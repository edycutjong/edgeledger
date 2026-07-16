/**
 * Coverage for getDb()'s one-time hydration branch (routes.ts:29-32): a fresh,
 * empty ledger DB seeded from fixtures/ledger-state.json on first open. The real
 * committed sqlite already has rows, so this test points PATHS.db at a throwaway
 * temp file (via an isolated config mock) to force the empty→hydrate path.
 */
import { describe, it, expect, vi } from 'vitest';

const h = vi.hoisted(() => {
  const dir = (process.env.TMPDIR ?? '/tmp').replace(/\/$/, '');
  return { dbPath: `${dir}/edgeledger-hydrate-${Date.now()}-${Math.floor(Math.random() * 1e6)}/ledger.sqlite` };
});

vi.mock('../config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config')>();
  return { ...actual, PATHS: { ...actual.PATHS, db: h.dbPath } };
});

describe('routes.getDb — hydration from ledger-state.json on an empty DB', () => {
  it('opens the empty temp DB and hydrates the seed rows on first call', async () => {
    const { getDb, resetDbForTests } = await import('../api/routes');
    const { rowCount } = await import('../db/ledger');
    resetDbForTests(null);
    const db = getDb();
    expect(rowCount(db)).toBeGreaterThan(0); // hydrated from fixtures/ledger-state.json
    // second call returns the cached handle (early-return branch)
    expect(getDb()).toBe(db);
    resetDbForTests(null);
  });
});
