/**
 * Data invariants I1–I5 — these ARE the product.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { buildLedgerFromCsv } from '../scripts/settle';
import { verifyPickHash } from '../engine/hash';
import { openMemoryDb, upsertMany, settledRows, receiptCount, rowCount } from '../db/ledger';
import { buildMerkleTree, merkleProof, verifyProof } from '../engine/merkle';
import { closingLineFromSnapshots } from '../data/odds';
import { PATHS } from '../config';

const csv = fs.readFileSync(PATHS.picksCsv, 'utf8');
const rows = buildLedgerFromCsv(csv);

describe('I1 — receipt predates kickoff', () => {
  it('every row: receipt_block_time < kickoff_utc', () => {
    for (const r of rows) {
      expect(new Date(r.receipt_block_time).getTime()).toBeLessThan(
        new Date(r.kickoff_utc).getTime(),
      );
    }
  });

  it('the pre-kickoff delta is a positive number of hours', () => {
    for (const r of rows) {
      const deltaH =
        (new Date(r.kickoff_utc).getTime() - new Date(r.receipt_block_time).getTime()) / 3600_000;
      expect(deltaH).toBeGreaterThan(0);
    }
  });
});

describe('I2 — tamper evidence (pick_hash re-hashes)', () => {
  it('served raw_json re-hashes to the stored pick_hash', () => {
    for (const r of rows) {
      const v = verifyPickHash(r.raw_json, r.pick_hash);
      expect(v.ok).toBe(true);
    }
  });

  it('editing a served pick breaks the hash', () => {
    const r = rows[0];
    const tampered = JSON.parse(r.raw_json);
    tampered.model_prob = 0.999;
    expect(verifyPickHash(JSON.stringify(tampered), r.pick_hash).ok).toBe(false);
  });
});

describe('I3 — no cherry-picking (losses included; rows == receipts)', () => {
  const db = openMemoryDb();
  upsertMany(db, rows.map((r) => ({ ...r })) as any);

  it('the ledger contains losing rows', () => {
    expect(settledRows(db).some((r) => r.result === 'loss')).toBe(true);
  });

  it('distinct receipt count equals settled row count', () => {
    expect(receiptCount(db)).toBe(rowCount(db));
    expect(rowCount(db)).toBe(rows.length);
  });

  it('receipt tx values are unique (one receipt per pick)', () => {
    const txs = new Set(rows.map((r) => r.receipt_tx));
    expect(txs.size).toBe(rows.length);
  });
});

describe('I4 — closing line = last snapshot <= kickoff', () => {
  const kickoff = '2026-07-14T19:00:00Z';
  const snapshots = [
    { captured_at: '2026-07-13T19:00:00Z', odds: 2.1 },
    { captured_at: '2026-07-14T18:55:00Z', odds: 1.9 }, // last before kickoff
    { captured_at: '2026-07-14T19:05:00Z', odds: 1.7 }, // AFTER kickoff — ignored
  ];

  it('picks the latest snapshot at or before kickoff', () => {
    const cl = closingLineFromSnapshots(snapshots, kickoff);
    expect(cl?.odds).toBe(1.9);
  });

  it('ignores post-kickoff snapshots entirely', () => {
    const cl = closingLineFromSnapshots(snapshots, kickoff);
    expect(cl?.captured_at).toBe('2026-07-14T18:55:00Z');
  });

  it('returns undefined when no snapshot precedes kickoff', () => {
    expect(closingLineFromSnapshots([{ captured_at: '2026-07-15T00:00:00Z', odds: 2 }], kickoff)).toBeUndefined();
  });
});

describe('I5 — daily Merkle root over pick hashes', () => {
  const leaves = rows.map((r) => r.pick_hash);

  it('every leaf has a proof that folds back to the root', () => {
    const tree = buildMerkleTree(leaves);
    for (let i = 0; i < leaves.length; i++) {
      const proof = merkleProof(leaves, i);
      expect(verifyProof(leaves[i], proof, tree.root)).toBe(true);
    }
  });

  it('a wrong leaf does NOT verify against the root', () => {
    const tree = buildMerkleTree(leaves);
    const proof = merkleProof(leaves, 0);
    expect(verifyProof('deadbeef'.repeat(8), proof, tree.root)).toBe(false);
  });

  it('changing any leaf changes the root (tamper-evident DB)', () => {
    const root1 = buildMerkleTree(leaves).root;
    const mutated = leaves.slice();
    mutated[3] = 'f'.repeat(64);
    expect(buildMerkleTree(mutated).root).not.toBe(root1);
  });
});
