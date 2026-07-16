import { describe, it, expect } from 'vitest';
import { recommendTier, buildLadder, unitsForTier, nameForTier, LADDER_RUNGS } from '../engine/ladder';

describe('conviction ladder', () => {
  it('banker: high confidence + real edge on a short price', () => {
    expect(recommendTier(0.06, 0.65)).toBe(3);
  });

  it('value: edge clears 8% but confidence not banker-grade', () => {
    expect(recommendTier(0.12, 0.58)).toBe(2);
  });

  it('probe: thin but real edge', () => {
    expect(recommendTier(0.04, 0.5)).toBe(1);
  });

  it('pass: edge below action threshold', () => {
    expect(recommendTier(0.02, 0.55)).toBe(0);
    expect(recommendTier(-0.05, 0.4)).toBe(0);
  });

  it('banker requires BOTH high prob AND >=5% edge', () => {
    expect(recommendTier(0.04, 0.7)).toBe(1); // high prob, edge too thin → probe
    expect(recommendTier(0.09, 0.55)).toBe(2); // big edge, prob not banker → value
  });

  it('buildLadder returns 4 rungs each with a rationale + a recommendation', () => {
    const { ladder, recommended_tier } = buildLadder(0.06, 0.65);
    expect(ladder).toHaveLength(4);
    expect(recommended_tier).toBe(3);
    for (const rung of ladder) {
      expect(rung.rationale.length).toBeGreaterThan(10);
      expect(rung.stake_units).toBe(rung.stake_pct);
    }
  });

  it('unit/name lookups line up with the rung table', () => {
    expect(unitsForTier(3)).toBe(8);
    expect(unitsForTier(2)).toBe(5);
    expect(unitsForTier(1)).toBe(2);
    expect(unitsForTier(0)).toBe(0);
    expect(nameForTier(3)).toBe('banker');
    expect(nameForTier(0)).toBe('pass');
    expect(LADDER_RUNGS).toHaveLength(4);
  });

  it('stakes increase monotonically with tier', () => {
    const units = LADDER_RUNGS.map((r) => r.stake_units);
    for (let i = 1; i < units.length; i++) expect(units[i]).toBeGreaterThan(units[i - 1]);
  });
});
