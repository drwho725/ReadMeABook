/**
 * Component: Library scan, delivered request linked to its Audiobookshelf item (#284)
 * Documentation: documentation/fixes/file-hash-matching.md
 *
 * RMAB delivered a book (request `downloaded`, ASIN X, folder on record) and Audiobookshelf holds
 * that folder under its own ASIN Y. Before the fix the request matched by ASIN only and stayed
 * `downloaded` forever. Real: both processors, match-requests, request-library-link, the path
 * helper, audiobook-matcher. Mocked: prisma (in-memory holder), config, library service, ABS fetch,
 * thumbnail cache, job queue.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const libraryServiceMock = vi.hoisted(() => ({
  getLibraryItems: vi.fn(),
  getRecentlyAdded: vi.fn(),
  getCoverCachingParams: vi.fn(),
}));
const configMock = vi.hoisted(() => ({
  getBackendMode: vi.fn(),
  getPlexConfig: vi.fn(),
  getMany: vi.fn(),
  get: vi.fn(),
  getAudibleRegion: vi.fn(),
}));
const thumbnailCacheServiceMock = vi.hoisted(() => ({ cacheLibraryThumbnail: vi.fn() }));
const jobQueueMock = vi.hoisted(() => ({ addNotificationJob: vi.fn() }));
const fetchMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/services/job-queue.service', () => ({ getJobQueueService: () => jobQueueMock }));
vi.mock('@/lib/services/library', () => ({ getLibraryService: async () => libraryServiceMock }));
vi.mock('@/lib/services/config.service', () => ({ getConfigService: () => configMock }));
vi.mock('@/lib/services/thumbnail-cache.service', () => ({ getThumbnailCacheService: () => thumbnailCacheServiceMock }));

const REQUESTED_ASIN = 'B0REQUEST1';
const LIBRARY_ASIN = 'B0LIBRARY2';
const MEDIA = '/media/audiobooks';
const FOLDER = `Author/Delivered Book ${REQUESTED_ASIN}`;
const DELIVERED = new Date('2026-10-20T12:00:00Z');

const ITEM = {
  id: 'abs-1',
  externalId: 'abs-1',
  title: 'Delivered Book',
  author: 'Author',
  asin: LIBRARY_ASIN,
  path: `/audiobooks/${FOLDER}`,
  relPath: FOLDER,
  isMissing: false,
  addedAt: new Date('2026-10-20T12:05:00Z'),
  updatedAt: new Date('2026-10-20T12:05:00Z'),
};

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;
interface Args {
  where?: Where;
  data?: Row;
  select?: Record<string, boolean>;
  include?: { requests?: unknown };
}

/** In-memory tables (plain holder, wired in beforeEach; never a vi.mock factory implementation). */
const db = {
  plex: [] as Row[],
  audiobooks: [] as Row[],
  requests: [] as Row[],
  /** When set, each matchable-request read waits until this many callers have read (forces the race). */
  barrier: 0,
};

/** The subset of Prisma's where clause these processors use: equality, notIn, in, contains, not, OR. */
function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c));
    const value = row[key] ?? null;
    if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
      const op = cond as { notIn?: unknown[]; in?: unknown[]; contains?: string; not?: unknown };
      if (op.notIn) return !op.notIn.includes(value);
      if (op.in) return op.in.includes(value);
      if (op.contains !== undefined) return typeof value === 'string' && value.includes(op.contains);
      if ('not' in op) return value !== op.not;
      return false;
    }
    return value === cond;
  });
}

function pick(row: Row, select: Record<string, boolean> | undefined): Row {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
}

function withRequest(r: Row): Row {
  return { ...r, audiobook: { ...db.audiobooks.find((a) => a.id === r.audiobookId) }, user: { plexUsername: 'reader' } };
}

function assign(row: Row | undefined, data: Row | undefined): Row {
  if (!row) throw new Error('row not found');
  for (const [k, v] of Object.entries(data ?? {})) if (v !== undefined) row[k] = v;
  return row;
}

function wire() {
  const plexBy = (w: Where = {}) => db.plex.find((r) => (w.id ? r.id === w.id : r.plexGuid === w.plexGuid));
  prismaMock.plexLibrary.findFirst.mockImplementation(async (a: Args) => plexBy(a.where) ?? null);
  prismaMock.plexLibrary.findUnique.mockImplementation(async (a: Args) => plexBy(a.where) ?? null);
  prismaMock.plexLibrary.create.mockImplementation(async (a: Args) => {
    const row: Row = { id: `row-${db.plex.length + 1}`, filePath: null, asin: null, ...a.data };
    db.plex.push(row);
    return row;
  });
  prismaMock.plexLibrary.update.mockImplementation(async (a: Args) => assign(plexBy(a.where), a.data));
  prismaMock.plexLibrary.findMany.mockImplementation(async (a?: Args) => db.plex.filter((r) => matches(r, a?.where)).map((r) => pick(r, a?.select)));
  prismaMock.plexLibrary.delete.mockImplementation(async (a: Args) => {
    db.plex = db.plex.filter((r) => r.id !== a.where?.id);
    return {};
  });

  prismaMock.audiobook.findMany.mockImplementation(async (a?: Args) => db.audiobooks.filter((r) => matches(r, a?.where)).map((r) => {
    const out = pick(r, a?.select);
    if (a?.include?.requests) out.requests = db.requests.filter((q) => q.audiobookId === r.id && q.deletedAt === null);
    return out;
  }));
  prismaMock.audiobook.findFirst.mockResolvedValue(null);
  prismaMock.audiobook.update.mockImplementation(async (a: Args) => assign(db.audiobooks.find((r) => r.id === a.where?.id), a.data));

  let readers = 0;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  prismaMock.request.findMany.mockImplementation(async (a?: Args) => {
    const rows = db.requests.filter((r) => matches(r, a?.where)).map(withRequest);
    if (db.barrier > 0) {
      readers++;
      if (readers >= db.barrier) release();
      await gate;
    }
    return rows;
  });
  prismaMock.request.update.mockImplementation(async (a: Args) => assign(db.requests.find((r) => r.id === a.where?.id), a.data));
  prismaMock.request.updateMany.mockImplementation(async (a: Args) => {
    const rows = db.requests.filter((r) => matches(r, a.where));
    rows.forEach((r) => assign(r, a.data));
    return { count: rows.length };
  });

  prismaMock.configuration.findUnique.mockImplementation(async (a: Args) => (a.where?.key === 'media_dir' ? { key: 'media_dir', value: MEDIA } : null));
}

function seedDelivered(over: { status?: string; type?: string; requestId?: string } = {}) {
  if (!db.audiobooks.some((a) => a.id === 'ab-1')) {
    db.audiobooks.push({
      id: 'ab-1', audibleAsin: REQUESTED_ASIN, title: 'Delivered Book', author: 'Author', narrator: null,
      filePath: `${MEDIA}/${FOLDER}`, filesHash: 'f'.repeat(64), status: 'completed', completedAt: DELIVERED,
      plexGuid: null, absItemId: null,
    });
  }
  db.requests.push({
    id: over.requestId ?? 'req-1', audiobookId: 'ab-1', userId: 'u-1', type: over.type ?? 'audiobook',
    status: over.status ?? 'downloaded', deletedAt: null, completedAt: DELIVERED, updatedAt: DELIVERED, errorMessage: null,
  });
}

const request = (id = 'req-1') => db.requests.find((r) => r.id === id) ?? {};
const audiobook = () => db.audiobooks.find((a) => a.id === 'ab-1') ?? {};
const notifications = () => jobQueueMock.addNotificationJob.mock.calls.filter((c) => c[0] === 'request_available');

describe('a delivered request is linked to its Audiobookshelf item (#284)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: string) => {
      throw new Error(`unexpected ABS call ${url}`);
    });
    db.plex = [];
    db.audiobooks = [];
    db.requests = [];
    db.barrier = 0;
    wire();

    configMock.getBackendMode.mockResolvedValue('audiobookshelf');
    configMock.getAudibleRegion.mockResolvedValue('us');
    const config: Record<string, string> = {
      'audiobookshelf.server_url': 'http://abs',
      'audiobookshelf.api_token': 'token',
      'audiobookshelf.library_id': 'lib-1',
    };
    configMock.get.mockImplementation(async (key: string) => config[key] ?? null);
    configMock.getMany.mockResolvedValue(config);
    libraryServiceMock.getCoverCachingParams.mockResolvedValue({ backendBaseUrl: 'http://abs', authToken: 'token', backendMode: 'audiobookshelf' });
    libraryServiceMock.getLibraryItems.mockResolvedValue([{ ...ITEM }]);
    libraryServiceMock.getRecentlyAdded.mockResolvedValue([{ ...ITEM }]);
    thumbnailCacheServiceMock.cacheLibraryThumbnail.mockResolvedValue(null);
    jobQueueMock.addNotificationJob.mockResolvedValue(undefined);
  });

  it('full scan: the request goes available, linked to the item, and keeps its own ASIN', async () => {
    seedDelivered();
    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');

    const result = await processScanPlex({ jobId: 'job-1' });

    expect(db.plex[0].filePath, 'plex_library.file_path holds the ABS item path').toBe(ITEM.path);
    expect(request().status).toBe('available');
    expect(audiobook().absItemId).toBe('abs-1');
    expect(audiobook().audibleAsin, 'the requested ASIN is not rewritten').toBe(REQUESTED_ASIN);
    expect(audiobook().title).toBe('Delivered Book');
    expect(notifications()).toHaveLength(1);
    expect(result.matchedDownloads).toBe(1);
  });

  it('recently-added check: the same link', async () => {
    seedDelivered();
    const { processPlexRecentlyAddedCheck } = await import('@/lib/processors/plex-recently-added.processor');

    const result = await processPlexRecentlyAddedCheck({ jobId: 'job-2' });

    expect(db.plex[0].filePath).toBe(ITEM.path);
    expect(request().status).toBe('available');
    expect(audiobook().absItemId).toBe('abs-1');
    expect(audiobook().audibleAsin).toBe(REQUESTED_ASIN);
    expect(notifications()).toHaveLength(1);
    expect(result.matchedDownloads).toBe(1);
  });

  it('both jobs in the same window: one notification', async () => {
    seedDelivered();
    db.plex.push({ id: 'row-1', plexGuid: 'abs-1', plexLibraryId: 'lib-1', title: 'Delivered Book', author: 'Author', asin: LIBRARY_ASIN, filePath: ITEM.path, addedAt: ITEM.addedAt });
    db.barrier = 2; // both read the request as `downloaded` before either writes
    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const { processPlexRecentlyAddedCheck } = await import('@/lib/processors/plex-recently-added.processor');

    await Promise.all([processScanPlex({ jobId: 'job-3a' }), processPlexRecentlyAddedCheck({ jobId: 'job-3b' })]);

    expect(request().status).toBe('available');
    expect(notifications()).toHaveLength(1);
  });

  it('a pending request whose book has a matching-looking path is left alone', async () => {
    seedDelivered({ status: 'pending' });
    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');

    await processScanPlex({ jobId: 'job-4' });

    expect(request().status).toBe('pending');
    expect(audiobook().absItemId).toBeNull();
    expect(notifications()).toHaveLength(0);
  });

  it('an ebook request on the same book never becomes available', async () => {
    seedDelivered({ type: 'ebook', requestId: 'req-ebook' });
    const { processScanPlex } = await import('@/lib/processors/scan-plex.processor');
    const { processPlexRecentlyAddedCheck } = await import('@/lib/processors/plex-recently-added.processor');

    await processScanPlex({ jobId: 'job-5a' });
    await processPlexRecentlyAddedCheck({ jobId: 'job-5b' });

    expect(request('req-ebook').status).toBe('downloaded');
    expect(notifications()).toHaveLength(0);
  });
});
