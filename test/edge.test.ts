import { describe, it, expect } from 'vitest';
import { impliedProb, devig, edgePct, evPct, fairOdds, round } from '../engine/edge';

describe('edge engine', () => {
  it('impliedProb = 1/odds', () => {
    expect(impliedProb(2)).toBeCloseTo(0.5, 10);
    expect(impliedProb(1.85)).toBeCloseTo(0.540541, 5);
  });

  it('rejects invalid odds (<= 1)', () => {
    expect(() => impliedProb(1)).toThrow();
    expect(() => impliedProb(0)).toThrow();
  });

  it('devig normalizes a full market to sum 1', () => {
    const fair = devig([2.1, 3.4, 3.8]); // home/draw/away
    const sum = fair.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
    // favourite keeps the largest fair prob
    expect(fair[0]).toBeGreaterThan(fair[1]);
    expect(fair[0]).toBeGreaterThan(fair[2]);
  });

  it('edge_pct matches the UI mockup (model 58% vs implied 46% = +12%)', () => {
    const odds = 1 / 0.46; // ~2.1739 → implied 46%
    expect(round(edgePct(0.58, odds), 4)).toBeCloseTo(0.12, 4);
  });

  it('ev_pct is expected ROI per unit', () => {
    // model 58% at 2.1739 → 0.58*2.1739 - 1 ≈ 0.2609
    expect(evPct(0.58, 1 / 0.46)).toBeCloseTo(0.2609, 3);
    // fair bet (model == implied) has zero EV
    expect(evPct(0.5, 2)).toBeCloseTo(0, 10);
  });

  it('negative edge when model below the market', () => {
    expect(edgePct(0.4, 2)).toBeLessThan(0); // 0.40 - 0.50
  });

  it('fairOdds is the inverse of model prob', () => {
    expect(fairOdds(0.5)).toBeCloseTo(2, 10);
    expect(fairOdds(0.25)).toBeCloseTo(4, 10);
  });

  it('probabilities out of range throw', () => {
    expect(() => edgePct(1.2, 2)).toThrow();
    expect(() => evPct(-0.1, 2)).toThrow();
  });

  it('round is deterministic to n places', () => {
    expect(round(0.1234567, 4)).toBe(0.1235);
    expect(round(0.5, 4)).toBe(0.5);
  });
});
