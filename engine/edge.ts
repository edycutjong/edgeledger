/**
 * Edge engine: model probability vs market odds.
 *
 * Headline edge (matches the UI mockup "model 58% · implied 46% · edge +12%"):
 *   edge_pct = model_prob - market_implied_prob    (probability POINTS)
 *
 * Also expose EV edge (expected ROI per unit staked), used by the ladder:
 *   ev_pct  = model_prob * decimal_odds - 1
 */

/** Book-implied probability of a single decimal price (includes the vig). */
export function impliedProb(decimalOdds: number): number {
  if (!(decimalOdds > 1)) throw new Error(`invalid decimal odds: ${decimalOdds}`);
  return 1 / decimalOdds;
}

/**
 * Remove the vig from a set of decimal odds covering a full market (e.g. the
 * three 1X2 prices). Returns fair probabilities that sum to 1. Used when we
 * want a cleaner "fair" comparison; the headline edge uses raw implied prob to
 * match the UI numbers.
 */
export function devig(decimalOddsForAllOutcomes: number[]): number[] {
  const raw = decimalOddsForAllOutcomes.map(impliedProb);
  const overround = raw.reduce((a, b) => a + b, 0);
  return raw.map((p) => p / overround);
}

/** Probability-points edge: model_prob - implied_prob(odds). Positive = value. */
export function edgePct(modelProb: number, marketOdds: number): number {
  assertProb(modelProb);
  return modelProb - impliedProb(marketOdds);
}

/** Expected ROI per unit staked at these odds under the model. */
export function evPct(modelProb: number, marketOdds: number): number {
  assertProb(modelProb);
  return modelProb * marketOdds - 1;
}

/** Fair decimal odds implied by a model probability (no vig). */
export function fairOdds(modelProb: number): number {
  assertProb(modelProb);
  return 1 / modelProb;
}

function assertProb(p: number): void {
  if (!(p >= 0 && p <= 1)) throw new Error(`probability out of range [0,1]: ${p}`);
}

/** Round to n decimal places (default 4) — deterministic for hashing. */
export function round(x: number, n = 4): number {
  const f = 10 ** n;
  return Math.round(x * f) / f;
}
