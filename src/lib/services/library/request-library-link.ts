/**
 * Component: Delivered request → Audiobookshelf item link (#284)
 * Documentation: documentation/fixes/file-hash-matching.md
 *
 * After RMAB delivered a book, the library item that holds RMAB's folder is the record, whatever
 * ASIN Audiobookshelf gave it. Finds that item by path first, by file hash second:
 *   - path: rows whose ABS path is the RMAB folder, or ends with its path relative to media_dir.
 *     An exact path or exact relPath links on its own; a suffix-only match needs the files hash or
 *     an item added since delivery (- 1 h). Several candidates: the files hash decides.
 *   - no path candidate: files hash over unlinked rows added since delivery (- 1 h), oldest 20.
 * Missing items (ABS `isMissing`) are skipped; anything not unique is ambiguous (no link).
 */

import { prisma } from '@/lib/db';
import { generateFilesHash } from '@/lib/utils/files-hash';
import { getMediaDir } from '@/lib/utils/media-dir';
import { canonicalPath } from '@/lib/utils/delete-guard';
import { libraryRelativePath, normalizeItemPath, normalizeRelPath } from '@/lib/utils/library-item-path';
import { getABSItem } from '@/lib/services/audiobookshelf/api';
import type { RMABLogger } from '@/lib/utils/logger';
import type { LibraryItem } from './ILibraryService';

/** At most this many ABS item fetches (`GET /api/items/:id`) per run. */
export const LINK_HASH_LOOKUP_BUDGET = 50;
/** A link may use items added up to this long before the delivery. */
export const LINK_WINDOW_MS = 60 * 60 * 1000;
/** The hash fallback looks at no more than this many rows per book. */
export const HASH_FALLBACK_LIMIT = 20;

export interface LinkRow {
  plexGuid: string;
  filePath: string | null;
  addedAt: Date | null;
}

export interface DeliveredBook {
  id: string;
  title: string;
  filePath: string | null;
  filesHash: string | null;
}

export type LinkResult =
  | { status: 'linked'; plexGuid: string; via: 'path' | 'hash' }
  | { status: 'ambiguous'; ids: string[] }
  | { status: 'none' };

/** The fields of ABS's GET /api/items/:id that the link reads. */
interface AbsItemFields {
  relPath?: unknown;
  isMissing?: unknown;
  media?: { audioFiles?: { metadata?: { filename?: unknown } }[] };
}

interface ItemDetail {
  relPath: string | null;
  isMissing: boolean;
  hash: string;
}

type Logger = Pick<RMABLogger, 'info' | 'warn' | 'debug'>;

/** Everything one run (scan or recently-added check) shares: loaded once, fetched at most once. */
export interface LinkContext {
  rows: LinkRow[];
  /** plex_library ids already linked to an audiobook (absItemId) */
  linkedIds: Set<string>;
  mediaDir: string;
  /** relPath/isMissing of the items listed by this run (no fetch needed) */
  listed: Map<string, { relPath?: string; isMissing?: boolean }>;
  details: Map<string, ItemDetail | null>;
  lookups: number;
  budgetLogged: boolean;
  fetchItem: (id: string) => Promise<unknown>;
  logger: Logger;
}

export function newLinkContext(init: {
  rows: LinkRow[];
  mediaDir: string;
  linkedIds: Iterable<string>;
  listedItems: Pick<LibraryItem, 'externalId' | 'relPath' | 'isMissing'>[];
  fetchItem: (id: string) => Promise<unknown>;
  logger: Logger;
}): LinkContext {
  return {
    rows: init.rows,
    linkedIds: new Set(init.linkedIds),
    mediaDir: init.mediaDir,
    listed: new Map(init.listedItems.map((i) => [i.externalId, { relPath: i.relPath, isMissing: i.isMissing }])),
    details: new Map(),
    lookups: 0,
    budgetLogged: false,
    fetchItem: init.fetchItem,
    logger: init.logger,
  };
}

/** Load this library's rows, the linked ids and media_dir once for the run. */
export async function createLinkContext(opts: { libraryId: string; listedItems: LibraryItem[]; logger: Logger }): Promise<LinkContext> {
  const [rows, linked, mediaDir] = await Promise.all([
    prisma.plexLibrary.findMany({
      where: { plexLibraryId: opts.libraryId },
      select: { plexGuid: true, filePath: true, addedAt: true },
    }),
    prisma.audiobook.findMany({ where: { absItemId: { not: null } }, select: { absItemId: true } }),
    getMediaDir(),
  ]);
  return newLinkContext({
    rows,
    mediaDir,
    linkedIds: linked.map((a) => a.absItemId).filter((id): id is string => !!id),
    listedItems: opts.listedItems,
    fetchItem: getABSItem,
    logger: opts.logger,
  });
}

/** When the audio was delivered: the audiobook request's completion time (set at `downloaded`). */
export function deliveryTime(request: { completedAt: Date | null; updatedAt: Date }): Date {
  return request.completedAt ?? request.updatedAt;
}

/** One `GET /api/items/:id` per item per run, within the budget. Null: unknown (error or budget). */
async function itemDetail(id: string, ctx: LinkContext): Promise<ItemDetail | null> {
  if (ctx.details.has(id)) return ctx.details.get(id)!;
  if (ctx.lookups >= LINK_HASH_LOOKUP_BUDGET) {
    if (!ctx.budgetLogged) {
      ctx.budgetLogged = true;
      ctx.logger.info(`Library link: ${LINK_HASH_LOOKUP_BUDGET} Audiobookshelf item lookups used for this run; the rest wait for the next one`);
    }
    return null;
  }
  ctx.lookups++;
  let detail: ItemDetail | null = null;
  try {
    const item = (await ctx.fetchItem(id)) as AbsItemFields | null;
    const names = (item?.media?.audioFiles ?? [])
      .map((f) => f?.metadata?.filename)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    detail = {
      relPath: typeof item?.relPath === 'string' ? item.relPath : null,
      isMissing: item?.isMissing === true,
      hash: generateFilesHash(names),
    };
  } catch (error) {
    ctx.logger.warn(`Library link: could not read Audiobookshelf item ${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
  ctx.details.set(id, detail);
  return detail;
}

async function hashOf(id: string, ctx: LinkContext): Promise<string | null> {
  return (await itemDetail(id, ctx))?.hash || null;
}

interface PathCandidate {
  plexGuid: string;
  exact: boolean;
  inWindow: boolean;
}

/** Rows whose ABS path is the RMAB folder (or ends with its media_dir-relative path), not missing. */
async function pathCandidates(book: DeliveredBook & { filePath: string }, windowStart: Date, ctx: LinkContext): Promise<PathCandidate[]> {
  const rel = await libraryRelativePath(book.filePath, ctx.mediaDir);
  if (!rel) return [];
  const folders = new Set([normalizeItemPath(book.filePath), normalizeItemPath(await canonicalPath(book.filePath))]);
  const candidates: PathCandidate[] = [];
  for (const row of ctx.rows) {
    if (!row.filePath) continue;
    const p = normalizeItemPath(row.filePath);
    const exactPath = folders.has(p) || p === rel;
    if (!exactPath && !p.endsWith(`/${rel}`)) continue;

    let { relPath, isMissing } = ctx.listed.get(row.plexGuid) ?? {};
    if (isMissing === undefined) {
      const detail = await itemDetail(row.plexGuid, ctx);
      if (!detail) continue; // unknown: skipped this run
      relPath = detail.relPath ?? undefined;
      isMissing = detail.isMissing;
    }
    if (isMissing) continue;
    const exactRel = !!relPath && normalizeRelPath(relPath) === rel;
    candidates.push({
      plexGuid: row.plexGuid,
      exact: exactPath || exactRel,
      inWindow: !!row.addedAt && row.addedAt >= windowStart,
    });
  }
  return candidates;
}

/** Files hash over unlinked rows added since delivery (- 1 h), oldest first, at most 20. */
async function hashFallback(book: DeliveredBook, windowStart: Date, ctx: LinkContext): Promise<LinkResult> {
  if (!book.filesHash) return { status: 'none' };
  const pool = ctx.rows
    .filter((r) => !!r.addedAt && r.addedAt >= windowStart && !ctx.linkedIds.has(r.plexGuid))
    .sort((a, b) => a.addedAt!.getTime() - b.addedAt!.getTime())
    .slice(0, HASH_FALLBACK_LIMIT);
  const equal: string[] = [];
  for (const row of pool) {
    const detail = await itemDetail(row.plexGuid, ctx);
    if (!detail || detail.isMissing || detail.hash !== book.filesHash) continue;
    equal.push(row.plexGuid);
    if (equal.length > 1) break;
  }
  if (equal.length === 1) return { status: 'linked', plexGuid: equal[0], via: 'hash' };
  return equal.length > 1 ? { status: 'ambiguous', ids: equal } : { status: 'none' };
}

/**
 * The library item that holds a delivered book's RMAB folder, or none/ambiguous.
 * `deliveredAt` is the audiobook request's delivery time (see deliveryTime), never the audiobook
 * row's completedAt: an ebook import on the same row overwrites that and filePath.
 */
export async function findDeliveredLibraryItem(book: DeliveredBook, deliveredAt: Date, ctx: LinkContext): Promise<LinkResult> {
  if (!book.filePath) return { status: 'none' };
  const windowStart = new Date(deliveredAt.getTime() - LINK_WINDOW_MS);

  const qualified: (PathCandidate & { byHash: boolean })[] = [];
  for (const c of await pathCandidates({ ...book, filePath: book.filePath }, windowStart, ctx)) {
    if (c.exact || c.inWindow) qualified.push({ ...c, byHash: false });
    else if (book.filesHash && (await hashOf(c.plexGuid, ctx)) === book.filesHash) qualified.push({ ...c, byHash: true });
  }

  if (qualified.length === 1) {
    return { status: 'linked', plexGuid: qualified[0].plexGuid, via: qualified[0].byHash ? 'hash' : 'path' };
  }
  if (qualified.length > 1) {
    const equal: string[] = [];
    if (book.filesHash) {
      for (const c of qualified) {
        if ((await hashOf(c.plexGuid, ctx)) === book.filesHash) equal.push(c.plexGuid);
      }
    }
    if (equal.length === 1) return { status: 'linked', plexGuid: equal[0], via: 'hash' };
    return { status: 'ambiguous', ids: qualified.map((c) => c.plexGuid) };
  }
  return hashFallback(book, windowStart, ctx);
}

/** Record a link in the run, so the hash fallback of later books skips that item. */
export function markLinked(ctx: LinkContext, plexGuid: string): void {
  ctx.linkedIds.add(plexGuid);
}

const warnedAmbiguous = new Set<string>();

/** Ambiguous links are retried every run: warn once per audiobook per process, then debug. */
export function logAmbiguousLink(book: { id: string; title: string }, ids: string[], logger: Logger): void {
  const message = `Library link: "${book.title}" matches several Audiobookshelf items (${ids.join(', ')}); not linked, the ASIN match still applies`;
  if (warnedAmbiguous.has(book.id)) {
    logger.debug(message);
    return;
  }
  warnedAmbiguous.add(book.id);
  logger.warn(message);
}
