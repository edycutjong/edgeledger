/** Core domain types for the edge + CLV engine. */

export type Side = 'HOME' | 'AWAY' | 'DRAW';
export type Result = 'win' | 'loss' | 'void' | 'pending';

/** A conviction-ladder rung (machine-readable staking guidance). */
export interface LadderRung {
  tier: number; // 0 = pass, 1 = probe, 2 = value, 3 = banker
  name: 'pass' | 'probe' | 'value' | 'banker';
  stake_units: number; // units on a 100-unit bankroll
  stake_pct: number; // = stake_units (percent of bankroll)
  rationale: string;
}

/** The canonical pick object that gets hashed (I2). Field order is normalized on hash. */
export interface CanonicalPick {
  fixture: string; // "SF: FRA vs ESP"
  competition: string; // "FIFA World Cup 2026"
  kickoff_utc: string; // ISO 8601
  side: Side;
  side_label: string; // "France ML"
  model_prob: number; // 0..1
  market_odds: number; // decimal odds we can bet at (entry)
  market_implied_prob: number; // 1 / market_odds
  edge_pct: number; // model_prob - market_implied_prob (probability-points edge)
  ev_pct: number; // model_prob * market_odds - 1 (expected ROI per unit)
  recommended_tier: number;
  ladder: LadderRung[];
  issued_at: string; // ISO — the moment the edge was computed/sold
}

/** A settled ledger row (the free public ledger). */
export interface LedgerRow {
  id: string;
  fixture: string;
  competition: string;
  kickoff_utc: string;
  side: Side;
  side_label: string;
  entry_odds: number;
  closing_odds: number;
  model_prob: number;
  market_implied_prob: number;
  edge_pct: number;
  stake_tier: number;
  stake_name: string;
  stake_units: number;
  result: Result;
  clv_pct: number; // relative CLV headline (matches UI): entry/closing - 1
  clv_prob_points: number; // implied(closing) - implied(entry)
  pick_hash: string; // sha256(canonical pick JSON)
  receipt_tx: string; // x402 payment tx (or placeholder — see is_placeholder)
  receipt_block_time: string; // ISO — must be < kickoff_utc (I1)
  sold_count: number; // demand signal (v2)
  revenue_usdc: number; // sold_count * price (v2)
  settled_at: string; // ISO
  is_placeholder: boolean; // true = seed row w/ placeholder receipt (honesty)
  raw_json: string; // the exact served CanonicalPick JSON (re-hashable, I2)
  verdict: 'APPROVED' | 'REJECTED' | 'SKIP'; // ARCHITECTURE data model — SKIPs/REJECTs are graded history too
}

/** A single BuyerLens call record — one row per PAID /api/edge call (COMPLEXITY §1.2). */
export interface BuyerCall {
  id?: number;
  buyer_from: string; // EIP-3009 authorization.from, ECDSA-recovered — never user-supplied
  pick_hash: string;
  fixture: string;
  verdict: 'APPROVED' | 'REJECTED' | 'SKIP';
  grade: string;
  proposed_stake_pct: number | null;
  ladder_stake_pct: number;
  at: string;
}
