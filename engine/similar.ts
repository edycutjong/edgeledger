/**
 * similar_settled — the "how have edges like this one actually resolved?" strip
 * that ships in every /api/edge response (PRD feature 4 / ARCHITECTURE response
 * shape). It draws from EdgeLedger's OWN settled ledger, losses included (I3),
 * so a buyer sees a comparable track record before trusting the pick — the same
 * asymmetry that is the moat: wins are provable, losses are public.
 */
import type { CanonicalPick, Result } from './types';

/** Minimal settled-row view the selector needs (decoupled from the DB layer). */
export interface SettledSummary {
  fixture: string;
  side: string;
  edge_pct: number;
  result: Result;
  clv_pct: number;
  settled_at: string;
}

/** One comparable settled pick surfaced to the buyer. */
export interface SimilarSettled {
  fixture: string;
  edge_pct: number;
  result: Extract<Result, 'win' | 'loss'>;
  clv_pct: number;
}

/**
 * Select the `n` settled picks most comparable to `pick`.
 *
 * Similarity is dominated by how close the historical edge was to this pick's
 * edge; a small nudge favours the same side, and newer settlements break ties.
 * Only decided rows (win/loss) are eligible — pending/void carry no track
 * record — and the pick's own fixture is never echoed back to itself.
 */
export function buildSimilarSettled(
  pick: Pick<CanonicalPick, 'fixture' | 'side' | 'edge_pct'>,
  rows: SettledSummary[],
  n = 3,
): SimilarSettled[] {
  return rows
    .filter(
      (r) => (r.result === 'win' || r.result === 'loss') && r.fixture !== pick.fixture,
    )
    .map((r) => ({
      r,
      // primary: edge distance; secondary: a small same-side preference.
      score: Math.abs(r.edge_pct - pick.edge_pct) + (r.side === pick.side ? 0 : 0.005),
    }))
    .sort(
      (a, b) => a.score - b.score || b.r.settled_at.localeCompare(a.r.settled_at),
    )
    .slice(0, Math.max(0, n))
    .map(({ r }) => ({
      fixture: r.fixture,
      edge_pct: r.edge_pct,
      result: r.result as Extract<Result, 'win' | 'loss'>,
      clv_pct: r.clv_pct,
    }));
}
