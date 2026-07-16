/**
 * Coverage completion for the pure engine + db layers: the uncovered
 * branches/fallbacks the primary suites didn't reach (empty inputs, unknown
 * tiers, tie-breaks, void rows, non-placeholder rows, and the under-betting
 * drift band). Every assertion exercises a real code path — no ignores.
 */
import { describe, it, expect } from 'vitest';
import { buildPick } from '../engine/index';
import { unitsForTier, nameForTier, recommendTier } from '../engine/ladder';
import { buildMerkleTree, merkleRoot, merkleProof, verifyProof } from '../engine/merkle';
import { buildSimilarSettled, type SettledSummary } from '../engine/similar';
import { buildGradeStats } from '../engine/verdict';
import {
  openMemoryDb, upsertRow, rowByReceipt, rowByHash, rowProfitUnits, computeStats, receiptCount,
} from '../db/ledger';
import { appendBuyerCall, buyerSummary } from '../db/buyers';
import type { LedgerRow } from '../engine/types';

describe('engine/types — pure type module loads (0 runtime statements)', () => {
  it('resolves to an empty runtime namespace', async () => {
    // a runtime dynamic import forces the (type-only) module to actually load,
    // so v8 records it; a static import would be elided by the transpiler.
    const mod = await import('../engine/types');
    expect(mod).toBeDefined();
    expect(Object.keys(mod)).toEqual([]);
  });
});

describe('engine/index buildPick — issued_at fallback (branch 56)', () => {
  it('defaults issued_at to now when the caller omits it', () => {
    const before = Date.now();
    const { pick, pick_hash } = buildPick({
      fixture: 'SF: FRA vs ESP', competition: 'FIFA World Cup 2026', kickoff_utc: '2026-07-14T19:00:00Z',
      side: 'HOME', side_label: 'France ML', model_prob: 0.58, market_odds: 2.05,
    });
    expect(pick_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Date(pick.issued_at).getTime()).toBeGreaterThanOrEqual(before - 1000);
    // and the explicit-issued_at path stays stable
    const explicit = buildPick({
      fixture: 'F', competition: 'C', kickoff_utc: '2026-07-14T19:00:00Z',
      side: 'AWAY', side_label: 'x', model_prob: 0.4, market_odds: 3, issued_at: '2026-07-14T00:00:00Z',
    });
    expect(explicit.pick.issued_at).toBe('2026-07-14T00:00:00Z');
  });
});

describe('engine/ladder — unknown-tier fallbacks (branches 66,70)', () => {
  it('unitsForTier/nameForTier fall back for an out-of-range tier', () => {
    expect(unitsForTier(3)).toBe(8);
    expect(unitsForTier(99)).toBe(0);
    expect(nameForTier(2)).toBe('value');
    expect(nameForTier(99)).toBe('pass');
    expect(recommendTier(0.0, 0.5)).toBe(0);
  });
});

describe('engine/merkle — empty tree + root helper + out-of-range proof', () => {
  it('an empty leaf set yields the sentinel single-leaf tree', () => {
    const tree = buildMerkleTree([]);
    expect(tree.count).toBe(0);
    expect(tree.layers).toEqual([[tree.root]]);
    expect(tree.root).toMatch(/^[0-9a-f]{64}$/);
  });

  it('merkleRoot(leaves) equals buildMerkleTree(leaves).root and folds back', () => {
    const leaves = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const root = merkleRoot(leaves);
    expect(root).toBe(buildMerkleTree(leaves).root);
    const proof = merkleProof(leaves, 2); // odd node → self-pair path
    expect(verifyProof(leaves[2], proof, root)).toBe(true);
  });

  it('merkleProof throws for an out-of-range leaf index', () => {
    expect(() => merkleProof(['a'.repeat(64)], 5)).toThrow(/out of range/);
    expect(() => merkleProof(['a'.repeat(64)], -1)).toThrow(/out of range/);
  });
});

describe('engine/similar — tie-break by settled_at (branch 51)', () => {
  it('equal edge-distance rows are ordered newest-settled first', () => {
    const rows: SettledSummary[] = [
      { fixture: 'A', side: 'HOME', edge_pct: 0.05, result: 'win', clv_pct: 1, settled_at: '2026-07-01T00:00:00Z' },
      { fixture: 'B', side: 'HOME', edge_pct: 0.05, result: 'loss', clv_pct: -1, settled_at: '2026-07-05T00:00:00Z' },
    ];
    const out = buildSimilarSettled({ fixture: 'Z', side: 'HOME', edge_pct: 0.05 }, rows, 2);
    expect(out.map((r) => r.fixture)).toEqual(['B', 'A']); // identical score → newer first
  });
});

describe('engine/verdict buildGradeStats — zero-staked bucket (branch 170)', () => {
  it('roi_pct is 0 when a graded bucket has settled rows but no stake', () => {
    const stats = buildGradeStats('C', [
      { grade: 'C', result: 'win', stake_pct: 0, entry_odds: 2 },
      { grade: 'C', result: 'loss', stake_pct: 0, entry_odds: 2 },
    ]);
    expect(stats.n).toBe(2);
    expect(stats.roi_pct).toBe(0);
    expect(stats.win_rate).toBe(0.5);
  });
});

// ── db/ledger extra coverage ────────────────────────────────────────────────
function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: 'x', fixture: 'F', competition: 'C', kickoff_utc: '2026-07-14T19:00:00Z',
    side: 'HOME', side_label: 's', entry_odds: 2, closing_odds: 2, model_prob: 0.6,
    market_implied_prob: 0.5, edge_pct: 0.05, stake_tier: 1, stake_name: 'probe', stake_units: 2,
    result: 'win', clv_pct: 1, clv_prob_points: 0.01, pick_hash: 'h', receipt_tx: '0xtx',
    receipt_block_time: '2026-07-14T18:00:00Z', sold_count: 1, revenue_usdc: 0.05,
    settled_at: '2026-07-14T22:00:00Z', is_placeholder: false, raw_json: '{}', verdict: 'APPROVED',
    ...over,
  };
}

describe('db/ledger — lookups, profit, and stats edge cases', () => {
  it('rowByReceipt / rowByHash hit and miss', () => {
    const db = openMemoryDb();
    upsertRow(db, row({ id: 'r1', receipt_tx: '0xaa', pick_hash: 'hh1', is_placeholder: false }));
    expect(rowByReceipt(db, '0xaa')?.id).toBe('r1');
    expect(rowByReceipt(db, '0xmissing')).toBeUndefined();
    expect(rowByHash(db, 'hh1')?.id).toBe('r1');
    expect(rowByHash(db, 'nope')).toBeUndefined();
    expect(receiptCount(db)).toBe(1);
  });

  it('rowProfitUnits covers win, loss, and void/pending', () => {
    expect(rowProfitUnits({ result: 'win', stake_units: 2, entry_odds: 3 })).toBe(4);
    expect(rowProfitUnits({ result: 'loss', stake_units: 2, entry_odds: 3 })).toBe(-2);
    expect(rowProfitUnits({ result: 'void', stake_units: 2, entry_odds: 3 })).toBe(0);
    expect(rowProfitUnits({ result: 'pending', stake_units: 2, entry_odds: 3 })).toBe(0);
  });

  it('computeStats over an empty DB takes every zero-branch', () => {
    const empty = computeStats(openMemoryDb());
    expect(empty).toMatchObject({ settled: 0, win_rate: 0, roi_pct: 0, avg_clv_pct: 0, beat_close_rate: 0 });
  });

  it('computeStats counts wins, losses, voids, and all three tiers', () => {
    const db = openMemoryDb();
    upsertRow(db, row({ id: 'w', pick_hash: 'w', receipt_tx: '0xw', result: 'win', stake_tier: 3, stake_units: 8, clv_pct: 2 }));
    upsertRow(db, row({ id: 'l', pick_hash: 'l', receipt_tx: '0xl', result: 'loss', stake_tier: 2, stake_units: 5, clv_pct: -1 }));
    upsertRow(db, row({ id: 'v', pick_hash: 'v', receipt_tx: '0xv', result: 'void', stake_tier: 1, stake_units: 2, clv_pct: 0 }));
    const s = computeStats(db);
    expect(s).toMatchObject({ wins: 1, losses: 1, voids: 1, settled: 3, banker_count: 1, value_count: 1, probe_count: 1 });
    expect(s.win_rate).toBeCloseTo(0.5, 5);
    expect(s.beat_close_rate).toBeCloseTo(1 / 3, 5);
  });

  it('computeStats with only a void row uses the wins+losses||1 guard', () => {
    const db = openMemoryDb();
    upsertRow(db, row({ id: 'v', pick_hash: 'v', receipt_tx: '0xv', result: 'void', stake_units: 2 }));
    const s = computeStats(db);
    expect(s.settled).toBe(1);
    expect(s.win_rate).toBe(0); // 0 / (0||1)
  });
});

describe('db/buyers — under-betting drift band (branch 58 / line 59)', () => {
  it('reports under-betting when proposed stake sits >1pt below the ladder', () => {
    const db = openMemoryDb();
    const addr = '0xUnder00000000000000000000000000000under';
    for (let i = 0; i < 2; i++) {
      appendBuyerCall(db, { buyer_from: addr, pick_hash: `h${i}`, fixture: 'f', verdict: 'APPROVED', grade: 'A', proposed_stake_pct: 2, ladder_stake_pct: 6, at: new Date().toISOString() });
    }
    const summary = buyerSummary(db, addr);
    expect(summary.your_avg_stake_vs_ladder).toBeCloseTo(-4, 5);
    expect(summary.drift).toMatch(/under-betting/);
  });

  it('reports on-ladder when proposed sizing tracks the ladder', () => {
    const db = openMemoryDb();
    const addr = '0xOnLadder000000000000000000000000onladdr';
    appendBuyerCall(db, { buyer_from: addr, pick_hash: 'h', fixture: 'f', verdict: 'APPROVED', grade: 'A', proposed_stake_pct: 6, ladder_stake_pct: 6, at: new Date().toISOString() });
    expect(buyerSummary(db, addr).drift).toMatch(/on-ladder/);
  });
});
