/**
 * Conviction ladder — machine-readable staking guidance.
 *
 * Calibrated to the seller's SETTLED 2026 record (bankers on short-priced,
 * high-confidence favorites; probe stakes on thin edges) rather than textbook
 * full-Kelly, which over-bets a ~20-pick sample. Units are on a 100-unit
 * bankroll, so stake_units == stake_pct.
 *
 * Tier selection blends edge (value) with model confidence (bankers are
 * short-priced AND high-probability — see the QF banker run in the real ledger):
 *
 *   tier 3 banker : model_prob >= 0.62 AND edge_pct >= 0.05   → 8U
 *   tier 2 value  : edge_pct >= 0.08                          → 5U
 *   tier 1 probe  : edge_pct >= 0.03                          → 2U
 *   tier 0 pass   : otherwise                                 → 0U
 */
import type { LadderRung } from './types';

export const LADDER_RUNGS: Omit<LadderRung, 'rationale'>[] = [
  { tier: 0, name: 'pass', stake_units: 0, stake_pct: 0 },
  { tier: 1, name: 'probe', stake_units: 2, stake_pct: 2 },
  { tier: 2, name: 'value', stake_units: 5, stake_pct: 5 },
  { tier: 3, name: 'banker', stake_units: 8, stake_pct: 8 },
];

export function recommendTier(edgePct: number, modelProb: number): number {
  if (modelProb >= 0.62 && edgePct >= 0.05) return 3; // banker
  if (edgePct >= 0.08) return 2; // value
  if (edgePct >= 0.03) return 1; // probe
  return 0; // pass
}

function rationaleFor(tier: number, edgePct: number, modelProb: number): string {
  const e = (edgePct * 100).toFixed(1);
  const p = (modelProb * 100).toFixed(0);
  switch (tier) {
    case 3:
      return `Banker: ${p}% model conf on a short price with +${e}% edge — max sizing on the settled record's best-performing tier.`;
    case 2:
      return `Value: +${e}% edge clears the 8% threshold — standard 5U value stake.`;
    case 1:
      return `Probe: +${e}% edge is real but thin — 2U probe, sized to survive variance.`;
    default:
      return `Pass: edge ${e}% below the 3% action threshold — no stake, logged for the record.`;
  }
}

/**
 * Build the full 1-2-3 ladder plus the recommended tier for a pick. Every rung
 * carries a rationale so the response is self-explaining to an agent.
 */
export function buildLadder(
  edgePct: number,
  modelProb: number,
): { ladder: LadderRung[]; recommended_tier: number } {
  const recommended_tier = recommendTier(edgePct, modelProb);
  const ladder: LadderRung[] = LADDER_RUNGS.map((r) => ({
    ...r,
    rationale: rationaleFor(r.tier, edgePct, modelProb),
  }));
  return { ladder, recommended_tier };
}

/** Look up the units for a tier (used by settle when a row records its rung). */
export function unitsForTier(tier: number): number {
  return LADDER_RUNGS.find((r) => r.tier === tier)?.stake_units ?? 0;
}

export function nameForTier(tier: number): LadderRung['name'] {
  return LADDER_RUNGS.find((r) => r.tier === tier)?.name ?? 'pass';
}
