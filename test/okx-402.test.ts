/**
 * x402 402-handshake tests against the REAL @okxweb3/x402-express middleware
 * (api/rails/okx.ts) — boots the Express app on an ephemeral port and asserts
 * the review-gate self-check shape from ARCHITECTURE.md verbatim:
 *
 *   curl -i -X POST https://<domain>/api/edge  → HTTP 402, x402Version:2
 *   curl -i -X POST https://<domain>/api/slate → HTTP 200
 *   GET  /api/edge                             → HTTP 405
 *
 * No OKX credentials, no network, no facilitator round-trip required — the
 * 402 challenge is built purely from the local RoutesConfig (api/rails/okx.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../api/server';
import { NET, PAYTO_ADDRESS, PRICE_UNITS } from '../config';

let server: Server;
let base: string;

/** The x402ResourceServer's default unpaid response BODY is `{}` — the real
 * challenge (x402Version, accepts[], etc.) rides the base64 PAYMENT-REQUIRED
 * response HEADER (ARCHITECTURE's review-gate self-check says "header and/or
 * JSON body" for exactly this reason). Decode it the same way a buyer would. */
function decodePaymentRequired(res: Response): any {
  const header = res.headers.get('payment-required');
  if (!header) return null;
  return JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
}

beforeAll(async () => {
  const app = createApp(); // real payGate — no demo bypass
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

describe('review-gate self-check (ARCHITECTURE §Endpoints, PRD success metrics)', () => {
  it('POST /api/edge with no X-PAYMENT → HTTP 402', async () => {
    const res = await fetch(`${base}/api/edge`, { method: 'POST' });
    expect(res.status).toBe(402);
  });

  it('the PAYMENT-REQUIRED response header carries a real x402 v2 PaymentRequired with dual USD₮0/USDG accepts', async () => {
    const res = await fetch(`${base}/api/edge`, { method: 'POST' });
    const parsed = decodePaymentRequired(res);
    expect(parsed).toBeTruthy();
    expect(parsed.x402Version).toBe(2);
    expect(Array.isArray(parsed.accepts)).toBe(true);
    expect(parsed.accepts.length).toBe(2);
    for (const req of parsed.accepts) {
      expect(req.scheme).toBe('exact');
      expect(req.network).toBe(NET.caip2);
      expect(req.amount).toBe(PRICE_UNITS);
      expect(req.payTo.toLowerCase()).toBe(PAYTO_ADDRESS.toLowerCase());
    }
    const assets = parsed.accepts.map((a: any) => a.asset.toLowerCase());
    expect(assets).toContain(NET.usdt0.toLowerCase());
    expect(assets).toContain(NET.usdg.toLowerCase());
  });

  it('a malformed X-PAYMENT header is rejected, never crashes to 5xx', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'X-PAYMENT': 'not-base64-@@@' },
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).not.toBe(200);
  });

  it('GET /api/edge → HTTP 405 (never serves GET — observed live-ASP semantics)', async () => {
    const res = await fetch(`${base}/api/edge`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('POST /api/slate is free (200), no payment required', async () => {
    const res = await fetch(`${base}/api/slate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(Array.isArray(body.fixtures)).toBe(true);
    for (const f of body.fixtures) {
      expect(['BET', 'SKIP']).toContain(f.verdict);
      // slate mode must never leak numbers (PRD #2 — "no numbers, no stakes")
      expect(f).not.toHaveProperty('edge_pct');
      expect(f).not.toHaveProperty('stake');
    }
  });

  it('POST /api/ledger is free (200), CORS-open', async () => {
    const res = await fetch(`${base}/api/ledger`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const body = (await res.json()) as any;
    expect(Array.isArray(body.settled)).toBe(true);
    expect(body.settled.length).toBeGreaterThanOrEqual(20);
    expect(body.totals).toHaveProperty('n');
    expect(body.totals).toHaveProperty('roi_pct');
    expect(body.anchor).toHaveProperty('merkle_root');
  });

  it('POST /api/me is free (200) even for an address with no history', async () => {
    const res = await fetch(`${base}/api/me`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address: '0x0000000000000000000000000000000000dEaD' }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.your_calls).toBe(0);
  });

  it('POST /api/receipts/verify is free (200/404), no payment required', async () => {
    const res = await fetch(`${base}/api/receipts/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pick_hash: 'deadbeef'.repeat(8) }) });
    expect([200, 404]).toContain(res.status);
  });

  it('payment-before-compute: the unpaid path never reaches the verdict engine (402 body has no verdict field)', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05 }),
    });
    expect(res.status).toBe(402);
    const body = (await res.json()) as any;
    expect(body.verdict).toBeUndefined();
    expect(body.pick_hash).toBeUndefined();
  });
});
