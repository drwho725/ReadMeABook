/**
 * Component: Ebook Placement Record (which ebook files a request put in the library, #497)
 * Documentation: documentation/admin-features/request-deletion.md
 *
 * `Request.placedEbookFiles` lists the ebook files an ebook request's imports
 * placed: `[{ path, size, sha256, placedAt }]`. An entry is written only when
 * placeFile copied the file ('copied'); 'identical', 'present' and 'differs'
 * mean the library already had it, so the import adds nothing (the field is then
 * at least []). NULL means no record (never imported, or imported before this
 * field existed). A request delete removes only recorded files, and only while
 * each is still the exact file RMAB placed (size + sha256) and its folder passes
 * library delete guard rules a-c.
 */

import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { prisma } from '../db';
import type { RMABLogger } from './logger';
import { UnsafeDeleteError } from './delete-guard';
import { isEbookFile, type PlacementRecord } from './import-inventory';
import { assertSafeLibraryDelete, type LibraryBook } from './library-delete-guard';

export interface EbookPlacement {
  /** Absolute library path of the placed file (placeFile's target). */
  path: string;
  size: number;
  /** sha256 (hex) of the placed bytes. */
  sha256: string;
  /** ISO time of the import that placed it. */
  placedAt: string;
}

export interface PlacementRecordRead {
  entries: EbookPlacement[];
  /** Items that are not a well-formed entry: their file is never removed. */
  unreadable: number;
}

const SHA256 = /^[0-9a-f]{64}$/;

function isPlacement(value: unknown): value is EbookPlacement {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.path === 'string' &&
    path.isAbsolute(v.path) &&
    !v.path.includes('\0') &&
    isEbookFile(path.basename(v.path)) &&
    Number.isSafeInteger(v.size) &&
    (v.size as number) >= 0 &&
    typeof v.sha256 === 'string' &&
    SHA256.test(v.sha256)
  );
}

/** The record as stored; null when there is none (SQL NULL and JSON null alike). */
export function readPlacements(value: unknown): PlacementRecordRead | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return { entries: [], unreadable: 1 };
  const entries = value.filter(isPlacement);
  return { entries, unreadable: value.length - entries.length };
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/** The entry for a file RMAB just placed; throws unless it is a regular file. */
export async function placementEntry(file: string): Promise<EbookPlacement> {
  const stat = await fs.lstat(file);
  if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a regular file`);
  return { path: path.resolve(file), size: stat.size, sha256: await sha256File(file), placedAt: new Date().toISOString() };
}

/** Append `entry` to the stored value (same path: newest wins); anything stored is kept. */
export function mergePlacements(stored: unknown, entry: EbookPlacement | null): unknown[] {
  const existing = Array.isArray(stored) ? stored : stored === null || stored === undefined ? [] : [stored];
  if (!entry) return existing;
  const samePath = (item: unknown) => !!item && typeof item === 'object' && (item as { path?: unknown }).path === entry.path;
  return [...existing.filter((item) => !samePath(item)), entry];
}

/**
 * After a successful ebook organize: record the file it placed, if it copied one.
 * Never throws. On a failure the field is left as it was (logged): the file is
 * then never removed by a request delete, which is the safe side.
 */
export async function recordEbookPlacement(requestId: string, record: PlacementRecord | undefined, logger: RMABLogger): Promise<void> {
  try {
    const entry = record?.status === 'copied' ? await placementEntry(record.target) : null;
    const row = await prisma.request.findUnique({ where: { id: requestId }, select: { placedEbookFiles: true } });
    await prisma.request.update({
      where: { id: requestId },
      data: { placedEbookFiles: mergePlacements(row?.placedEbookFiles, entry) as object[] },
    });
    logger.info(
      entry
        ? `Recorded the placed ebook file ${path.basename(entry.path)} for request ${requestId}`
        : `No ebook file placed by this import (${record?.status ?? 'no placement'}); nothing recorded for a later delete`
    );
  } catch (error) {
    logger.warn(
      `Could not record the placed ebook file for request ${requestId} (${error instanceof Error ? error.message : String(error)}); deleting this request will keep it`
    );
  }
}

/**
 * Library paths recorded by every other active request, of any book. A file two
 * requests recorded stays until neither needs it. Only the ebook organize writes
 * records, so only ebook requests can hold one.
 */
export async function otherRecordedPaths(requestId: string): Promise<Set<string>> {
  const rows = await prisma.request.findMany({
    where: { id: { not: requestId }, deletedAt: null, type: 'ebook' },
    select: { placedEbookFiles: true },
  });
  const paths = new Set<string>();
  for (const row of rows) {
    for (const entry of readPlacements(row.placedEbookFiles)?.entries ?? []) paths.add(path.resolve(entry.path));
  }
  return paths;
}

export type PlacedFileDecision =
  /** Unlink this path: still the file RMAB placed, in a folder rules a-c allow. */
  | { kind: 'remove'; file: string }
  /** Nothing there any more (or its folder is gone): nothing to do. */
  | { kind: 'gone' }
  | { kind: 'kept'; reason: string };

/** Whether one recorded file may be unlinked for `book`'s request delete. */
export async function planPlacedEbookDelete(
  entry: EbookPlacement,
  book: LibraryBook,
  otherPaths: Set<string>
): Promise<PlacedFileDecision> {
  const name = path.basename(entry.path);
  if (otherPaths.has(path.resolve(entry.path))) return { kind: 'kept', reason: `${name} is also the ebook of another request` };

  let safe;
  try {
    safe = await assertSafeLibraryDelete(path.dirname(entry.path), book, { evidence: false });
  } catch (error) {
    if (error instanceof UnsafeDeleteError) return { kind: 'kept', reason: error.reason };
    return { kind: 'kept', reason: error instanceof Error ? error.message : String(error) };
  }
  if (!safe.exists) return { kind: 'gone' };

  const file = path.join(safe.canonicalPath, name);
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile()) return { kind: 'kept', reason: `${name} is no longer the file RMAB placed` };
    if (stat.size !== entry.size || (await sha256File(file)) !== entry.sha256) {
      return { kind: 'kept', reason: `${name} changed since RMAB placed it` };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? 'error';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'gone' };
    return { kind: 'kept', reason: `${name} could not be checked (${code})` };
  }
  return { kind: 'remove', file };
}
