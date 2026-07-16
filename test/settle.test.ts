/**
 * settle.ts — idempotency + correctness of the ledger build.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
  parsePicksCsv,
  buildLedgerFromCsv,
  toLedgerRow,
  placeholderReceiptTx,
  assertPreKickoff,
} from '../scripts/settle';
import { openMemoryDb, upsertMany, computeStats, settledRows } from '../db/ledger';
import { PATHS } from '../config';

const csv = fs.readFileSync(PATHS.picksCsv, 'utf8');

describe('settle: CSV parsing', () => {
  it('skips # comments and the header, parses all rows', () => {
    const picks = parsePicksCsv(csv);
    expect(picks.length).toBe(24);
    expect(picks[0].id).toBe('p001');
    expect(picks[0].model_prob).toBeCloseTo(0.72, 5);
    expect(typeof picks[0].entry_odds).toBe('number');
  });
});

describe('settle: idempotency', () => {
  it('buildLedgerFromCsv is byte-identical across runs', () => {
    const a = JSON.stringify(buildLedgerFromCsv(csv));
    const b = JSON.stringify(buildLedgerFromCsv(csv));
    expect(a).toBe(b);
  });

  it('placeholder receipt tx is deterministic and 0x + 64 hex', () => {
    const tx1 = placeholderReceiptTx('p001', 'a'.repeat(64));
    const tx2 = placeholderReceiptTx('p001', 'a'.repeat(64));
    expect(tx1).toBe(tx2);
    expect(tx1).toMatch(/^0x[0-9a-f]{64}$/);
    // different input → different tx
    expect(placeholderReceiptTx('p002', 'a'.repeat(64))).not.toBe(tx1);
  });

  it('re-loading the DB twice yields identical stats', () => {
    const rows = buildLedgerFromCsv(csv);
    const db1 = openMemoryDb();
    upsertMany(db1, rows as any);
    const db2 = openMemoryDb();
    upsertMany(db2, rows as any);
    upsertMany(db2, rows as any); // upsert twice — must not duplicate
    expect(settledRows(db2).length).toBe(settledRows(db1).length);
    expect(computeStats(db2)).toEqual(computeStats(db1));
  });
});

describe('settle: ledger shape', () => {
  const rows = buildLedgerFromCsv(csv);

  it('produces >= 20 settled rows (definition of done)', () => {
    expect(rows.length).toBeGreaterThanOrEqual(20);
  });

  it('every row carries a stake tier, CLV, hash, receipt, and is flagged placeholder', () => {
    for (const r of rows) {
      expect(r.stake_tier).toBeGreaterThanOrEqual(0);
      expect(r.pick_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.receipt_tx).toMatch(/^0x[0-9a-f]{64}$/);
      expect(r.is_placeholder).toBe(true);
      expect(typeof r.clv_pct).toBe('number');
      expect(['win', 'loss', 'void', 'pending']).toContain(r.result);
    }
  });

  it('CLV divergence exists: at least one win with negative CLV and one loss with positive CLV', () => {
    expect(rows.some((r) => r.result === 'win' && r.clv_pct < 0)).toBe(true);
    expect(rows.some((r) => r.result === 'loss' && r.clv_pct > 0)).toBe(true);
  });

  it('revenue = sold_count * price for each row', () => {
    for (const r of rows) {
      expect(r.revenue_usdc).toBeCloseTo(r.sold_count * 0.05, 6);
    }
  });

  it('assertPreKickoff passes for the whole seed set (I1)', () => {
    expect(() => assertPreKickoff(rows)).not.toThrow();
  });

  it('toLedgerRow is a pure function of its input', () => {
    const p = parsePicksCsv(csv)[5];
    expect(JSON.stringify(toLedgerRow(p))).toBe(JSON.stringify(toLedgerRow(p)));
  });
});
