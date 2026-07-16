/**
 * similar_settled — the comparable-track-record strip in every /api/edge body
 * (PRD feature / ARCHITECTURE response shape). Covers the pure selector and
 * proves the field actually ships in the paid 200 payload (demo mode, no funds).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { buildSimilarSettled, type SettledSummary } from '../engine/similar';
import { createApp } from '../api/server';

const PICK = { fixture: 'SF: FRA vs ESP', side: 'HOME' as const, edge_pct: 0.09 };

const ROWS: SettledSummary[] = [
  { fixture: 'QF: FRA vs POR', side: 'HOME', edge_pct: 0.088, result: 'win', clv_pct: 0.11, settled_at: '2026-07-05' },
  { fixture: 'QF: BRA vs ARG', side: 'AWAY', edge_pct: 0.091, result: 'win', clv_pct: -0.02, settled_at: '2026-07-06' },
  { fixture: 'R16: ESP vs GER', side: 'HOME', edge_pct: 0.06, result: 'loss', clv_pct: 0.07, settled_at: '2026-07-01' },
  { fixture: 'GS: X vs Y', side: 'HOME', edge_pct: 0.30, result: 'win', clv_pct: 0.2, settled_at: '2026-06-20' },
  { fixture: 'SF: FRA vs ESP', side: 'HOME', edge_pct: 0.09, result: 'win', clv_pct: 0.05, settled_at: '2026-07-04' }, // same fixture
  { fixture: 'QF: pending', side: 'HOME', edge_pct: 0.09, result: 'pending', clv_pct: 0, settled_at: '2026-07-07' }, // undecided
];

describe('buildSimilarSettled (pure selector)', () => {
  it('excludes the current fixture and undecided (pending/void) rows', () => {
    const out = buildSimilarSettled(PICK, ROWS, 10);
    expect(out.every((r) => r.fixture !== PICK.fixture)).toBe(true);
    expect(out.every((r) => r.result === 'win' || r.result === 'loss')).toBe(true);
  });

  it('ranks by edge closeness, with a same-side nudge on ties', () => {
    const out = buildSimilarSettled(PICK, ROWS, 3);
    // FRA vs POR (edge 0.088, same side) is closest; BRA vs ARG (0.091 but away
    // side) is nudged just behind it.
    expect(out[0].fixture).toBe('QF: FRA vs POR');
    expect(out[1].fixture).toBe('QF: BRA vs ARG');
  });

  it('keeps losses public (I3 honesty — the moat is the asymmetry)', () => {
    const out = buildSimilarSettled(PICK, ROWS, 3);
    expect(out.some((r) => r.result === 'loss')).toBe(true);
  });

  it('caps at n and drops the far-edge outlier', () => {
    const out = buildSimilarSettled(PICK, ROWS, 3);
    expect(out.length).toBe(3);
    expect(out.some((r) => r.fixture === 'GS: X vs Y')).toBe(false);
  });

  it('n=0 and empty input both yield an empty list', () => {
    expect(buildSimilarSettled(PICK, ROWS, 0)).toEqual([]);
    expect(buildSimilarSettled(PICK, [], 3)).toEqual([]);
  });

  it('each entry carries exactly {fixture, edge_pct, result, clv_pct}', () => {
    const out = buildSimilarSettled(PICK, ROWS, 3);
    for (const r of out) {
      expect(Object.keys(r).sort()).toEqual(['clv_pct', 'edge_pct', 'fixture', 'result']);
      expect(typeof r.edge_pct).toBe('number');
      expect(typeof r.clv_pct).toBe('number');
    }
  });
});

describe('/api/edge ships a well-formed similar_settled AGGREGATE in the paid 200 body (demo mode, no funds)', () => {
  // NOTE: the OKX edition's /api/edge response shape (ARCHITECTURE §Endpoints)
  // ships similar_settled as an AGGREGATE {n, win_rate, roi_pct} — the grade-
  // bucket stat block from engine/verdict.ts's buildGradeStats — not the
  // ranked LIST buildSimilarSettled (above) returns. buildSimilarSettled still
  // exists and is unit-tested above; it now powers other comparable-pick
  // lookups. See test/verdict.test.ts for grade-band/verdict/ladder coverage.
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const app = createApp({ demo: true }); // gate off — render the paid payload without payment
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        base = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  afterAll(() => {
    server?.close();
  });

  it('POST /api/edge (validate mode, known fixture) → 200 with a well-formed similar_settled aggregate', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05, bankroll: 500 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.pick_hash).toBeTruthy();
    expect(typeof body.similar_settled).toBe('object');
    expect(typeof body.similar_settled.n).toBe('number');
    expect(typeof body.similar_settled.win_rate).toBe('number');
    expect(typeof body.similar_settled.roi_pct).toBe('number');
    expect(body.mirror).toBeTruthy();
    expect('receipt' in body.mirror).toBe(true);
  });
});
