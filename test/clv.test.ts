import { describe, it, expect } from 'vitest';
import { clvPct, clvProbPoints, beatClose, aggregateClv } from '../engine/clv';

describe('CLV engine', () => {
  it('relative CLV matches the UI: 1.85 → 1.72 ≈ +7.6%', () => {
    expect(clvPct(1.85, 1.72)).toBeCloseTo(0.0756, 4);
  });

  it('relative CLV: 2.10 → 2.15 ≈ -2.3% (line drifted against us)', () => {
    expect(clvPct(2.1, 2.15)).toBeCloseTo(-0.0233, 4);
  });

  it('relative CLV: 1.60 → 1.55 ≈ +3.2%', () => {
    expect(clvPct(1.6, 1.55)).toBeCloseTo(0.0323, 4);
  });

  it('prob-point CLV: 1.85 → 1.72 ≈ +0.0409', () => {
    expect(clvProbPoints(1.85, 1.72)).toBeCloseTo(0.0409, 4);
  });

  it('no move = zero CLV', () => {
    expect(clvPct(2.0, 2.0)).toBe(0);
    expect(clvProbPoints(2.0, 2.0)).toBeCloseTo(0, 12);
  });

  it('shorter close = positive CLV (beat the close)', () => {
    expect(beatClose(2.0, 1.8)).toBe(true);
    expect(clvPct(2.0, 1.8)).toBeGreaterThan(0);
  });

  it('longer close = negative CLV', () => {
    expect(beatClose(1.8, 2.0)).toBe(false);
  });

  it('invalid odds throw', () => {
    expect(() => clvPct(1, 1.5)).toThrow();
    expect(() => clvPct(1.5, 1)).toThrow();
  });

  it('aggregateClv averages relative CLV and hit-rate', () => {
    const agg = aggregateClv([
      { entry_odds: 1.85, closing_odds: 1.72 }, // +
      { entry_odds: 2.1, closing_odds: 2.15 }, // -
      { entry_odds: 1.6, closing_odds: 1.55 }, // +
    ]);
    expect(agg.n).toBe(3);
    expect(agg.beat_close_rate).toBeCloseTo(2 / 3, 5);
    expect(agg.avg_clv_pct).toBeCloseTo((0.0756 - 0.0233 + 0.0323) / 3, 3);
  });

  it('empty sample is safe', () => {
    expect(aggregateClv([])).toEqual({ avg_clv_pct: 0, beat_close_rate: 0, n: 0 });
  });
});
