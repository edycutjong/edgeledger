/**
 * Verdict engine (NEW, engine/verdict.ts) — grade bands, APPROVED/REJECTED/SKIP,
 * the 5-rung conviction ladder, and the similar_settled / mirror aggregates
 * that ship in the paid /api/edge response (ARCHITECTURE §Endpoints,
 * §Protocol invariants #2).
 */
import { describe, it, expect } from 'vitest';
import {
  gradeFor, verdictFor, buildStake, buildVerdict, RUNGS, GRADE_ORDER,
  buildGradeStats, buildMirror, verdictHash,
} from '../engine/verdict';

describe('gradeFor — probability-point edge bands', () => {
  it('A+ at >= 12% edge', () => expect(gradeFor(0.12)).toBe('A+'));
  it('A at >= 8% edge', () => expect(gradeFor(0.08)).toBe('A'));
  it('B at >= 5% edge', () => expect(gradeFor(0.05)).toBe('B'));
  it('C at >= 3% edge', () => expect(gradeFor(0.03)).toBe('C'));
  it('D at >= 0% edge', () => expect(gradeFor(0)).toBe('D'));
  it('F below 0% edge (negative)', () => expect(gradeFor(-0.068)).toBe('F'));
  it('grade boundaries are inclusive on the lower bound', () => {
    expect(gradeFor(0.0799)).toBe('B');
    expect(gradeFor(0.08)).toBe('A');
  });
});

describe('verdictFor — REJECTED / SKIP / APPROVED', () => {
  it('negative edge → REJECTED (the headline "reject your bet" moment)', () => {
    expect(verdictFor(-0.0697)).toBe('REJECTED');
  });
  it('thin positive edge below the action threshold → SKIP ("no bet" is first-class)', () => {
    expect(verdictFor(0.01)).toBe('SKIP');
  });
  it('edge at/above the action threshold → APPROVED', () => {
    expect(verdictFor(0.03)).toBe('APPROVED');
    expect(verdictFor(0.092)).toBe('APPROVED');
  });
  it('zero edge is SKIP, not REJECTED (fair bet, no reason to reject)', () => {
    expect(verdictFor(0)).toBe('SKIP');
  });
});

describe('buildStake — 5-rung ladder, ARCHITECTURE §Protocol invariants #2', () => {
  it('REJECTED/SKIP grades (F, D) always map to the pass rung, 0%', () => {
    expect(RUNGS.F).toEqual({ name: 'pass', stake_pct: 0 });
    expect(RUNGS.D).toEqual({ name: 'pass', stake_pct: 0 });
  });

  it('stake_pct is monotone non-decreasing across the grade order', () => {
    const pcts = GRADE_ORDER.map((g) => RUNGS[g].stake_pct);
    for (let i = 1; i < pcts.length; i++) {
      expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1]);
    }
  });

  it('there are exactly 5 distinct rung NAMES across the 6 grades (F/D share "pass")', () => {
    const names = new Set(GRADE_ORDER.map((g) => RUNGS[g].name));
    expect(names.size).toBe(5);
    expect([...names].sort()).toEqual(['banker', 'lean', 'pass', 'probe', 'value']);
  });

  it('amount is null when no bankroll is supplied, and a number when it is', () => {
    expect(buildStake('A+').amount).toBeNull();
    expect(buildStake('A+', 500).amount).toBe(40); // 8% of 500
  });

  it('amount scales linearly with bankroll', () => {
    expect(buildStake('B', 1000).amount).toBe(40); // 4% of 1000
    expect(buildStake('C', 1000).amount).toBe(20); // 2% of 1000
  });
});

describe('buildVerdict — end-to-end pure computation', () => {
  it('REJECTED ⇒ stake pct 0 (the SEED_DATA devastating-demo shape)', () => {
    // fair_prob 0.62 vs odds 1.45 (implied ~0.6897) → negative edge.
    const v = buildVerdict({ fixture: 'SF: FRA vs ESP', selection: 'Spain to advance', odds: 1.45, fair_prob: 0.62, bankroll: 500 });
    expect(v.verdict).toBe('REJECTED');
    expect(v.edge_grade).toBe('F');
    expect(v.edge_pct).toBeLessThan(0);
    expect(v.stake.pct).toBe(0);
    expect(v.stake.amount).toBe(0);
    expect(v.market_implied).toBeCloseTo(0.6897, 3);
  });

  it('APPROVED ⇒ stake pct > 0 and amount = pct% of bankroll', () => {
    // fair_prob 0.58 vs odds 2.05 (implied ~0.4878) → positive edge (~9.2%).
    const v = buildVerdict({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05, fair_prob: 0.58, bankroll: 500 });
    expect(v.verdict).toBe('APPROVED');
    expect(v.stake.pct).toBeGreaterThan(0);
    expect(v.stake.amount).toBeCloseTo((v.stake.pct / 100) * 500, 6);
  });

  it('decay_min_halflife is always present (signal-decay honesty field, PRD #5)', () => {
    const v = buildVerdict({ fixture: 'x', selection: 'y', odds: 2, fair_prob: 0.5 });
    expect(typeof v.decay_min_halflife).toBe('number');
    expect(v.decay_min_halflife).toBeGreaterThan(0);
  });

  it('verdictHash is deterministic and stable across re-serialization', () => {
    const v1 = buildVerdict({ fixture: 'a', selection: 'b', odds: 2, fair_prob: 0.5 });
    const v2 = buildVerdict({ fixture: 'a', selection: 'b', odds: 2, fair_prob: 0.5 });
    expect(verdictHash(v1)).toBe(verdictHash(v2));
    expect(verdictHash(v1)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildGradeStats — the similar_settled aggregate', () => {
  const rows = [
    { grade: 'A' as const, result: 'win' as const, stake_pct: 6, entry_odds: 2.0 },
    { grade: 'A' as const, result: 'loss' as const, stake_pct: 6, entry_odds: 1.8 },
    { grade: 'F' as const, result: 'loss' as const, stake_pct: 0, entry_odds: 1.4 },
    { grade: 'A' as const, result: 'pending' as const, stake_pct: 6, entry_odds: 2.0 }, // excluded (undecided)
  ];

  it('only counts decided (win/loss) rows in the matching grade bucket', () => {
    const stats = buildGradeStats('A', rows);
    expect(stats.n).toBe(2);
  });

  it('win_rate and roi_pct compute over the bucket, losses included', () => {
    const stats = buildGradeStats('A', rows);
    expect(stats.win_rate).toBeCloseTo(0.5, 4);
    // staked = 12, profit = win(6*(2.0-1))=6, loss(-6) => 0 profit / 12 staked = 0 roi
    expect(stats.roi_pct).toBeCloseTo(0, 4);
  });

  it('empty bucket is safe (n=0, no divide-by-zero)', () => {
    expect(buildGradeStats('A+', rows)).toEqual({ n: 0, win_rate: 0, roi_pct: 0 });
  });
});

describe('buildMirror — "what we staked on the same/most-similar fixture"', () => {
  it('flat when no row matches the fixture (SEED_DATA REJECTED example shape)', () => {
    const m = buildMirror('SF: FRA vs ESP', []);
    expect(m).toEqual({ our_stake: 0, receipt: null, note: 'we are flat this market' });
  });

  it('reports our own stake + result + receipt when a matching row exists', () => {
    const m = buildMirror('QF: FRA vs POR', [
      { fixture: 'QF: FRA vs POR', stake_pct: 8, result: 'win', pnl_pct: 5.6, receipt: 'board:p003' },
    ]);
    expect(m.our_stake).toBe(8);
    expect(m.result).toBe('win');
    expect(m.receipt).toBe('board:p003');
  });
});
