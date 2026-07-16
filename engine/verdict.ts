/**
 * Verdict engine (NEW for the OKX edition — COMPLEXITY.md §1.1).
 *
 * Wraps the ported edge/ladder engine (edge.ts, ladder.ts — unchanged) with the
 * OKX response contract from ARCHITECTURE.md §Endpoints:
 *
 *   {mode, verdict, edge_pct, edge_grade, fair_prob, market_implied,
 *    stake:{amount|pct, rung}, decay_min_halflife, mirror, similar_settled,
 *    you, pick_hash, sources}
 *
 * Design (not specified verbatim in the docs — this is the concrete rule this
 * build ships, documented here so it is auditable):
 *
 *   grade bands (probability-point edge_pct):
 *     >= 0.12 → A+   >= 0.08 → A   >= 0.05 → B   >= 0.03 → C   >= 0 → D   < 0 → F
 *
 *   verdict:
 *     edge_pct <  0                → REJECTED  (proposed bet is -EV — reject it)
 *     0 <= edge_pct < ACTION_THRESHOLD → SKIP    ("no bet" is a first-class answer)
 *     edge_pct >= ACTION_THRESHOLD → APPROVED
 *
 *   Invariant (tested, ARCHITECTURE §Protocol invariants #2):
 *     REJECTED ⇒ stake 0; SKIP ⇒ stake 0; stake caps are monotone non-decreasing
 *     in grade.
 *
 * The 5-rung conviction ladder (ARCHITECTURE: "5 rungs, record-calibrated caps")
 * maps grade → rung name → stake_pct of bankroll:
 *   F/D → pass (0%) · C → probe (2%) · B → lean (4%) · A → value (6%) · A+ → banker (8%)
 */
import { edgePct as calcEdge, evPct as calcEv, impliedProb, round } from './edge';
import { pickHash } from './hash';
import { ACTION_THRESHOLD, DECAY_HALFLIFE_MIN } from '../config';

export type Grade = 'A+' | 'A' | 'B' | 'C' | 'D' | 'F';
export type Verdict = 'APPROVED' | 'REJECTED' | 'SKIP';
export type RungName = 'pass' | 'probe' | 'lean' | 'value' | 'banker';

export interface StakeRung {
  name: RungName;
  stake_pct: number; // percent of bankroll, 0..8
}

export const RUNGS: Record<Grade, StakeRung> = {
  'F': { name: 'pass', stake_pct: 0 },
  'D': { name: 'pass', stake_pct: 0 },
  'C': { name: 'probe', stake_pct: 2 },
  'B': { name: 'lean', stake_pct: 4 },
  'A': { name: 'value', stake_pct: 6 },
  'A+': { name: 'banker', stake_pct: 8 },
};

/** Grade order, worst→best — used to assert ladder monotonicity in tests. */
export const GRADE_ORDER: Grade[] = ['F', 'D', 'C', 'B', 'A', 'A+'];

export function gradeFor(edgePct: number): Grade {
  if (edgePct >= 0.12) return 'A+';
  if (edgePct >= 0.08) return 'A';
  if (edgePct >= 0.05) return 'B';
  if (edgePct >= 0.03) return 'C';
  if (edgePct >= 0) return 'D';
  return 'F';
}

export function verdictFor(edgePct: number): Verdict {
  if (edgePct < 0) return 'REJECTED';
  if (edgePct < ACTION_THRESHOLD) return 'SKIP';
  return 'APPROVED';
}

export interface StakeResult {
  pct: number;
  amount: number | null; // null when no bankroll supplied
  rung: RungName;
}

export function buildStake(grade: Grade, bankroll?: number): StakeResult {
  const rung = RUNGS[grade];
  const amount = typeof bankroll === 'number' && bankroll > 0
    ? round((rung.stake_pct / 100) * bankroll, 2)
    : null;
  return { pct: rung.stake_pct, amount, rung: rung.name };
}

export interface VerdictInput {
  fixture: string;
  selection: string;
  odds: number; // decimal odds for the proposed selection
  fair_prob: number; // model probability, 0..1
  bankroll?: number;
}

export interface VerdictResult {
  mode: 'validate';
  fixture: string;
  selection: string;
  verdict: Verdict;
  edge_pct: number;
  edge_grade: Grade;
  fair_prob: number;
  market_implied: number;
  ev_pct: number;
  stake: StakeResult;
  decay_min_halflife: number;
}

/** Build the core verdict object (pure — no I/O, no DB, no similar_settled/mirror/you). */
export function buildVerdict(input: VerdictInput): VerdictResult {
  const fair_prob = round(input.fair_prob, 4);
  const market_implied = round(impliedProb(input.odds), 4);
  const edge_pct = round(calcEdge(fair_prob, input.odds), 4);
  const ev_pct = round(calcEv(fair_prob, input.odds), 4);
  const edge_grade = gradeFor(edge_pct);
  const verdict = verdictFor(edge_pct);
  const stake = verdict === 'APPROVED' ? buildStake(edge_grade, input.bankroll) : { pct: 0, amount: input.bankroll ? 0 : null, rung: 'pass' as RungName };

  return {
    mode: 'validate',
    fixture: input.fixture,
    selection: input.selection,
    verdict,
    edge_pct,
    edge_grade,
    fair_prob,
    market_implied,
    ev_pct,
    stake,
    decay_min_halflife: DECAY_HALFLIFE_MIN,
  };
}

/** Deterministic hash of the served verdict — the pick-commit (I2 pattern, ARCHITECTURE #3/#7). */
export function verdictHash(v: VerdictResult): string {
  return pickHash(v);
}

// ── similar_settled aggregate ({n, win_rate, roi_pct}) ───────────────────────
// NOTE: this is a different shape from engine/similar.ts's buildSimilarSettled
// (which returns a ranked LIST of individual comparable picks, used for the
// `mirror` block's "most similar settled pick"). ARCHITECTURE's /api/edge
// response wants the AGGREGATE stat block, so it lives here.

export interface GradeStatsRow {
  grade: Grade;
  result: 'win' | 'loss' | 'void' | 'pending';
  stake_pct: number;
  entry_odds: number;
}

export interface GradeStats {
  n: number;
  win_rate: number;
  roi_pct: number;
}

/** Aggregate settled-row stats for a grade bucket (losses included — the moat). */
export function buildGradeStats(grade: Grade, rows: GradeStatsRow[]): GradeStats {
  const bucket = rows.filter((r) => r.grade === grade && (r.result === 'win' || r.result === 'loss'));
  const n = bucket.length;
  if (n === 0) return { n: 0, win_rate: 0, roi_pct: 0 };
  const wins = bucket.filter((r) => r.result === 'win').length;
  let staked = 0;
  let profit = 0;
  for (const r of bucket) {
    staked += r.stake_pct;
    profit += r.result === 'win' ? r.stake_pct * (r.entry_odds - 1) : -r.stake_pct;
  }
  return {
    n,
    win_rate: round(wins / n, 4),
    roi_pct: staked > 0 ? round(profit / staked, 4) : 0,
  };
}

// ── mirror block ({our_stake, result?, receipt}) ─────────────────────────────

export interface MirrorRow {
  fixture: string;
  stake_pct: number;
  result: 'win' | 'loss' | 'void' | 'pending';
  pnl_pct: number | null;
  receipt: string | null; // "board:<ref>" (historical) or "xlayer:<tx>" (real OKX-paid)
}

export interface MirrorBlock {
  our_stake: number;
  result?: string;
  pnl_pct?: number | null;
  receipt: string | null;
  note?: string;
}

/** "What we staked on the same/most-similar fixture" — SEED_DATA.md's exact shape. */
export function buildMirror(fixture: string, rows: MirrorRow[]): MirrorBlock {
  const exact = rows.find((r) => r.fixture === fixture);
  if (!exact) {
    return { our_stake: 0, receipt: null, note: 'we are flat this market' };
  }
  return {
    our_stake: exact.stake_pct,
    result: exact.result,
    pnl_pct: exact.pnl_pct,
    receipt: exact.receipt,
  };
}
