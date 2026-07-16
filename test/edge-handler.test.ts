/**
 * Integration coverage for the /api/edge response shape + BuyerLens write
 * gating, run in `demo` mode (payGate off — api/server.ts header comment)
 * so the paid response can be exercised offline. decodeXPayment() itself
 * doesn't re-verify the signature (that's the payGate's job on the real
 * path — see test/buyerlens.test.ts for the cryptographic half); here we
 * prove the WRITE GATING logic: no X-PAYMENT header → no buyer row, no `you`
 * block (ARCHITECTURE §Protocol invariants #6).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../api/server';
import { resetDbForTests } from '../api/routes';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ demo: true });
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
  resetDbForTests(null); // let other suites re-hydrate from the real fixtures/ledger-state.json
});

function xPaymentHeader(from: string): string {
  return Buffer.from(JSON.stringify({ payload: { authorization: { from, to: '0x0', value: '1' } } })).toString('base64');
}

describe('POST /api/edge — validate mode, model coverage found', () => {
  it('a known APPROVED selection returns the full response shape', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05, bankroll: 500 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.mode).toBe('validate');
    expect(body.verdict).toBe('APPROVED');
    expect(body.edge_grade).toBeTruthy();
    expect(body.stake.pct).toBeGreaterThan(0);
    expect(body.sources).toHaveProperty('odds');
    expect(body.sources).toHaveProperty('snapshot_at');
    expect(body.pick_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a known REJECTED selection (hype favorite) returns stake 0 and a flat mirror', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'Spain to advance', odds: 1.45, bankroll: 500 }),
    });
    const body = (await res.json()) as any;
    expect(body.verdict).toBe('REJECTED');
    expect(body.stake.pct).toBe(0);
    expect(body.stake.amount).toBe(0);
  });
});

describe('POST /api/edge — unknown fixture (no model coverage)', () => {
  it('honestly SKIPs rather than fabricating an edge (PRODUCTION_PLAN honesty gate #3)', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'Group stage: Nowhere vs Nobody', selection: 'Nowhere ML', odds: 1.9 }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.verdict).toBe('SKIP');
    expect(body.reason).toBe('no_model_coverage');
    expect(body.stake.pct).toBe(0);
  });

  it('missing fixture is a 400, not a fabricated response', async () => {
    const res = await fetch(`${base}/api/edge`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/edge — slate mode ({fixture} only)', () => {
  it('resolves the best-value known selection on that fixture', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP' }),
    });
    const body = (await res.json()) as any;
    expect(body.mode).toBe('slate');
    expect(body.selection).toBeTruthy();
  });
});

describe('BuyerLens write gating (ARCHITECTURE §Protocol invariants #6)', () => {
  it('no X-PAYMENT header → you is null, no buyer row written', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05 }),
    });
    const body = (await res.json()) as any;
    expect(body.you).toBeNull();
  });

  it('a present X-PAYMENT header (decoded, demo mode) writes a buyer row and populates `you`', async () => {
    const addr = '0x1234000000000000000000000000000000abcd';
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': xPaymentHeader(addr) },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05 }),
    });
    const body = (await res.json()) as any;
    expect(body.you).toBeTruthy();
    expect(body.you.your_calls).toBeGreaterThanOrEqual(1);

    const me = await fetch(`${base}/api/me`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }) });
    const meBody = (await me.json()) as any;
    expect(meBody.your_calls).toBeGreaterThanOrEqual(1);
    expect(meBody.calls.length).toBeGreaterThanOrEqual(1);

    const forget = await fetch(`${base}/api/me`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr, forget: true }) });
    const forgetBody = (await forget.json()) as any;
    expect(forgetBody.deleted).toBe(true);
    expect(forgetBody.rows_removed).toBeGreaterThanOrEqual(1);

    const meAgain = await fetch(`${base}/api/me`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: addr }) });
    expect(((await meAgain.json()) as any).your_calls).toBe(0);
  });
});

describe('POST /api/receipts/verify', () => {
  it('an unknown pick_hash → 404', async () => {
    const res = await fetch(`${base}/api/receipts/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick_hash: 'f'.repeat(64) }) });
    expect(res.status).toBe(404);
  });

  it('a placeholder seed row reports placeholder_no_onchain_receipt, never fabricates verified', async () => {
    const ledger = await fetch(`${base}/api/ledger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const ledgerBody = (await ledger.json()) as any;
    const anyRow = ledgerBody.settled.find((r: any) => r.is_placeholder);
    expect(anyRow).toBeTruthy();
    const res = await fetch(`${base}/api/receipts/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick_hash: anyRow.pick_hash }) });
    const body = (await res.json()) as any;
    expect(body.status).toBe('placeholder_no_onchain_receipt');
    expect(body.verified_at).toBeNull();
  });
});
