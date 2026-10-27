/**
 * Component: Audible Refresh Category Cap Tests (#309)
 * Documentation: documentation/features/home-sections.md
 *
 * Each category section costs a cooldown and up to 4 pages per refresh, and sub-categories
 * raise the number users can pick, so one run refreshes at most 30 distinct categories:
 * the ones the most users chose, ties by category id.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPrismaMock } from '../helpers/prisma';

const prismaMock = createPrismaMock();
const audibleServiceMock = vi.hoisted(() => ({
  getPopularAudiobooks: vi.fn(),
  getNewReleases: vi.fn(),
  getCategoryBooks: vi.fn(),
}));
const thumbnailCacheMock = vi.hoisted(() => ({
  cacheThumbnail: vi.fn(),
  cleanupUnusedThumbnails: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ prisma: prismaMock }));
vi.mock('@/lib/integrations/audible.service', () => ({
  getAudibleService: () => audibleServiceMock,
}));
vi.mock('@/lib/services/thumbnail-cache.service', () => ({
  getThumbnailCacheService: () => thumbnailCacheMock,
}));

const CAP = 30;
const pad = (n: number) => `cat-${String(n).padStart(2, '0')}`;

/** Saved category sections: one row per (user, category). */
function sectionRows(byCategory: Record<string, number>) {
  const rows: { categoryId: string; userId: string }[] = [];
  for (const [categoryId, users] of Object.entries(byCategory)) {
    for (let u = 0; u < users; u++) rows.push({ categoryId, userId: `user-${u}` });
  }
  return rows;
}

/** Answer findMany like Postgres would: `distinct` collapses repeated category ids. */
function serveSections(rows: { categoryId: string; userId: string }[]) {
  prismaMock.userHomeSection.findMany.mockImplementation(async (args: { distinct?: string[] } = {}) => {
    if (args.distinct?.includes('categoryId')) {
      return [...new Set(rows.map((r) => r.categoryId))].map((categoryId) => ({ categoryId }));
    }
    return rows.map((r) => ({ categoryId: r.categoryId, userId: r.userId }));
  });
}

describe('processAudibleRefresh category cap (#309)', () => {
  let origSetTimeout: typeof global.setTimeout;

  beforeEach(() => {
    origSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: (...args: unknown[]) => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout;

    audibleServiceMock.getPopularAudiobooks.mockResolvedValue([]);
    audibleServiceMock.getNewReleases.mockResolvedValue([]);
    audibleServiceMock.getCategoryBooks.mockResolvedValue([]);
    thumbnailCacheMock.cleanupUnusedThumbnails.mockResolvedValue(0);
    prismaMock.audibleCacheCategory.deleteMany.mockResolvedValue({ count: 0 });
    prismaMock.audibleCache.findMany.mockResolvedValue([]);
  });

  afterEach(() => {
    global.setTimeout = origSetTimeout;
  });

  it(`refreshes at most ${CAP} categories, the most chosen first, and leaves the rest untouched`, async () => {
    const byCategory: Record<string, number> = {};
    for (let i = 1; i <= 35; i++) byCategory[pad(i)] = 1;
    byCategory[pad(35)] = 3;
    byCategory[pad(34)] = 3;
    byCategory[pad(20)] = 2;
    serveSections(sectionRows(byCategory));

    const { processAudibleRefresh } = await import('@/lib/processors/audible-refresh.processor');
    const result = await processAudibleRefresh({ jobId: 'job-cap' });

    const refreshed = audibleServiceMock.getCategoryBooks.mock.calls.map((c) => c[0]);
    expect(refreshed).toHaveLength(CAP);
    expect(new Set(refreshed).size).toBe(CAP);
    expect(refreshed.slice(0, 3)).toEqual([pad(34), pad(35), pad(20)]);

    const expected = [pad(34), pad(35), pad(20)];
    for (let i = 1; expected.length < CAP; i++) if (![20, 34, 35].includes(i)) expected.push(pad(i));
    expect(refreshed).toEqual(expected);

    const skipped = [pad(29), pad(30), pad(31), pad(32), pad(33)];
    expect(skipped.every((id) => !refreshed.includes(id))).toBe(true);
    const wiped = prismaMock.audibleCacheCategory.deleteMany.mock.calls.map((c) => c[0].where.categoryId);
    expect(skipped.some((id) => wiped.includes(id))).toBe(false);

    expect(result.categoriesSynced).toBe(CAP);
    expect(result.categoriesSkipped).toBe(5);
  });

  it('refreshes every category, each once, when there are no more than the cap', async () => {
    serveSections(sectionRows({ 'node-b': 1, 'node-a': 2, 'node-c': 1 }));

    const { processAudibleRefresh } = await import('@/lib/processors/audible-refresh.processor');
    const result = await processAudibleRefresh({ jobId: 'job-under' });

    expect(audibleServiceMock.getCategoryBooks.mock.calls.map((c) => c[0]).sort()).toEqual(['node-a', 'node-b', 'node-c']);
    expect(result.categoriesSynced).toBe(3);
    expect(result.categoriesSkipped ?? 0).toBe(0);
  });
});
