/**
 * Engine composition root: turn a fixture + model probability + market odds
 * into a fully-formed, hashable CanonicalPick (the thing sold behind x402).
 */
import { edgePct as calcEdge, evPct as calcEv, impliedProb, round } from './edge';
import { buildLadder } from './ladder';
import { pickHash } from './hash';
import type { CanonicalPick, Side } from './types';

export * from './types';
export * from './edge';
export * from './clv';
export * from './ladder';
export * from './hash';
export * from './similar';
export * from './merkle';
export * from './verdict';

export interface EdgeInput {
  fixture: string;
  competition: string;
  kickoff_utc: string;
  side: Side;
  side_label: string;
  model_prob: number;
  market_odds: number;
  issued_at?: string;
}

/**
 * Build a canonical pick with edge, EV, implied prob and conviction ladder.
 * Numbers are rounded to fixed precision BEFORE hashing so pick_hash is stable
 * across re-serialization (I2).
 */
export function buildPick(input: EdgeInput): { pick: CanonicalPick; pick_hash: string } {
  const model_prob = round(input.model_prob, 4);
  const market_odds = round(input.market_odds, 4);
  const market_implied_prob = round(impliedProb(market_odds), 4);
  const edge_pct = round(calcEdge(model_prob, market_odds), 4);
  const ev_pct = round(calcEv(model_prob, market_odds), 4);
  const { ladder, recommended_tier } = buildLadder(edge_pct, model_prob);

  const pick: CanonicalPick = {
    fixture: input.fixture,
    competition: input.competition,
    kickoff_utc: input.kickoff_utc,
    side: input.side,
    side_label: input.side_label,
    model_prob,
    market_odds,
    market_implied_prob,
    edge_pct,
    ev_pct,
    recommended_tier,
    ladder,
    issued_at: input.issued_at ?? new Date().toISOString(),
  };

  return { pick, pick_hash: pickHash(pick) };
}
