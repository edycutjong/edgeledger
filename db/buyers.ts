/**
 * BuyerLens repository (COMPLEXITY §1.2, ARCHITECTURE §BuyerLens wiring).
 *
 * "No-login personalization": rows are written ONLY from the post-verification
 * EIP-3009 `authorization.from` the payment middleware recovers — never from a
 * user-supplied address (ARCHITECTURE §Protocol invariants #6). `/api/me`
 * reads this store; `forget:true` deletes it.
 */
import type { DB } from './ledger';
import type { BuyerCall } from '../engine/types';

/** Append one paid-call record for a buyer (write path — verified payment only). */
export function appendBuyerCall(db: DB, call: BuyerCall): void {
  db.prepare(
    `INSERT INTO buyer_calls
       (buyer_from, pick_hash, fixture, verdict, grade, proposed_stake_pct, ladder_stake_pct, at)
     VALUES (@buyer_from, @pick_hash, @fixture, @verdict, @grade, @proposed_stake_pct, @ladder_stake_pct, @at)`,
  ).run({
    buyer_from: call.buyer_from.toLowerCase(),
    pick_hash: call.pick_hash,
    fixture: call.fixture,
    verdict: call.verdict,
    grade: call.grade,
    proposed_stake_pct: call.proposed_stake_pct ?? null,
    ladder_stake_pct: call.ladder_stake_pct,
    at: call.at,
  });
}

/** All calls for one buyer address, oldest first. */
export function buyerHistory(db: DB, address: string): BuyerCall[] {
  return db
    .prepare('SELECT * FROM buyer_calls WHERE buyer_from = ? ORDER BY at ASC')
    .all(address.toLowerCase()) as BuyerCall[];
}

export interface BuyerSummary {
  address: string;
  your_calls: number;
  your_avg_stake_vs_ladder: number; // avg(proposed - ladder), rungs of stake_pct
  drift: string;
}

/** The `you` block shipped in every paid /api/edge response + /api/me. */
export function buyerSummary(db: DB, address: string): BuyerSummary {
  const rows = buyerHistory(db, address);
  const your_calls = rows.length;
  if (your_calls === 0) {
    return { address, your_calls: 0, your_avg_stake_vs_ladder: 0, drift: 'no history yet' };
  }
  const withProposed = rows.filter((r) => r.proposed_stake_pct !== null && r.proposed_stake_pct !== undefined);
  const avgDelta = withProposed.length
    ? withProposed.reduce((s, r) => s + ((r.proposed_stake_pct as number) - r.ladder_stake_pct), 0) / withProposed.length
    : 0;
  const rounded = Math.round(avgDelta * 100) / 100;
  let drift: string;
  if (withProposed.length === 0) drift = 'no proposed-stake history yet';
  else if (rounded > 1) drift = `+${rounded} pct-pts above ladder — tilt pattern`;
  else if (rounded < -1) drift = `${rounded} pct-pts below ladder — under-betting your edges`;
  else drift = 'on-ladder — disciplined sizing';
  return { address, your_calls, your_avg_stake_vs_ladder: rounded, drift };
}

/** GDPR-style delete: remove every row for an address (privacy note in listing copy). */
export function forgetBuyer(db: DB, address: string): number {
  const info = db.prepare('DELETE FROM buyer_calls WHERE buyer_from = ?').run(address.toLowerCase());
  return info.changes;
}
