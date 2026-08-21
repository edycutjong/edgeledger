/**
 * VALIDATION BEFORE PAYMENT — the OKX.AI listing rule.
 *
 * OKX.AI review requires that parameter validation "be completed before
 * returning the x402 payment pending signature information (challenge)". The
 * sibling CLV Scout listing was DELISTED on 2026-08-20 for validating after
 * deduction and re-listed only once it validated first; EdgeLedger shipped the
 * identical pattern (a 200 usage response after the gate had settled), so it
 * gets the identical gate. This suite pins the three cases decided by
 * `api/validate.ts::paramPreflight`:
 *
 *   1. discovery  — unpaid, param-less GET  -> 402 + PAYMENT-REQUIRED challenge
 *   2. bad params — anything else invalid   -> 400, no challenge, no settlement
 *   3. good params                          -> 402 challenge, then paid 200
 *
 * The decisive test is the last one: a genuinely signed payment presented with
 * an invalid body is rejected 400 AND its authorization nonce is left unspent,
 * so the very same signature still buys a real verdict afterwards. That is
 * proof the buyer was not charged for the error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { authorizationTypes } from '@okxweb3/x402-evm';
import { createApp } from '../api/server';
import { NET, PAYTO_ADDRESS, PRICE_UNITS } from '../config';

let server: Server;
let base: string;

const VALID_BODY = { fixture: 'SF: FRA vs ESP' };

function randomNonce(): `0x${string}` {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return ('0x' + Buffer.from(bytes).toString('hex')) as `0x${string}`;
}

/** Probe with a VALID body, sign the real challenge, return an X-PAYMENT header. */
async function signPaymentHeader(): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  const probe = await fetch(`${base}/api/edge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(VALID_BODY),
  });
  expect(probe.status).toBe(402);
  const header = probe.headers.get('payment-required');
  expect(header).toBeTruthy();
  const challenge = JSON.parse(Buffer.from(header as string, 'base64').toString('utf8')) as {
    accepts: Record<string, unknown>[];
  };
  const required = challenge.accepts[0];
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: PAYTO_ADDRESS,
    value: PRICE_UNITS,
    validAfter: String(now - 60),
    validBefore: String(now + 3600),
    nonce: randomNonce(),
  };
  const signature = await account.signTypedData({
    domain: { name: 'USD₮0', version: '1', chainId: NET.chainId, verifyingContract: NET.usdt0 },
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  });
  return Buffer.from(
    JSON.stringify({ x402Version: 2, accepted: required, payload: { signature, authorization } }),
  ).toString('base64');
}

beforeAll(async () => {
  const app = createApp(); // real payGate — no demo bypass
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

describe('case 1 — the marketplace discovery probe still gets a real challenge', () => {
  it('GET /api/edge with no params -> 402 + PAYMENT-REQUIRED', async () => {
    const res = await fetch(`${base}/api/edge`);
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
  });
});

describe('case 2 — invalid params are rejected BEFORE any challenge is issued', () => {
  const bad: [string, unknown][] = [
    ['empty body', {}],
    ['unrelated keys', { nonsense: true }],
    ['blank fixture', { fixture: '   ' }],
    ['fixture not a string', { fixture: 42 }],
    ['odds below 1.0', { fixture: 'SF: FRA vs ESP', selection: 'France ML', odds: 0.5 }],
    ['non-numeric odds', { fixture: 'SF: FRA vs ESP', selection: 'France ML', odds: 'evens' }],
    ['negative bankroll', { fixture: 'SF: FRA vs ESP', bankroll: -100 }],
    ['blank selection', { fixture: 'SF: FRA vs ESP', selection: '  ', odds: 2.1 }],
  ];

  for (const [label, body] of bad) {
    it(`POST /api/edge (${label}) -> 400, no challenge`, async () => {
      const res = await fetch(`${base}/api/edge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
      const json = (await res.json()) as { error: string; required: string[]; payment: string; verdict?: string };
      expect(json.error).toBe('invalid_request');
      expect(json.required).toContain('fixture');
      expect(json.payment).toMatch(/nothing was deducted/i);
      // never a fabricated verdict on an error path
      expect(json.verdict).toBeUndefined();
    });
  }

  it('GET /api/edge with an invalid query param -> 400, no challenge', async () => {
    const res = await fetch(`${base}/api/edge?fixture=SF%3A%20FRA%20vs%20ESP&odds=0.2`);
    expect(res.status).toBe(400);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
  });

  it('a non-object JSON body (array) counts as no params -> 400, not a crash', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([VALID_BODY]),
    });
    expect(res.status).toBe(400);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
  });

  it('a trailing-slash path is still gated (/api/edge/ with bad params -> 400)', async () => {
    const res = await fetch(`${base}/api/edge/?bankroll=100`);
    expect(res.status).toBe(400);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull();
  });

  it('free routes are untouched by the preflight', async () => {
    const res = await fetch(`${base}/api/slate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});

describe('case 3 — valid params get the challenge', () => {
  it('POST /api/edge with only {fixture} -> 402 challenge', async () => {
    const res = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
  });

  it('GET /api/edge with valid query params -> 402 challenge (odds arrives as a string)', async () => {
    const res = await fetch(`${base}/api/edge?fixture=SF%3A%20FRA%20vs%20ESP&selection=France%20ML&odds=2.1`);
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeTruthy();
  });
});

describe('the deduction guarantee — a signed payment is not spent on an invalid call', () => {
  it('400s the invalid call, leaves the nonce unspent, and the SAME signature still buys a verdict', async () => {
    const header = await signPaymentHeader();

    // present the genuine, verifiable payment alongside an invalid body
    const rejected = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
      body: JSON.stringify({ bankroll: 1000 }), // no fixture
    });
    expect(rejected.status).toBe(400);
    expect(rejected.headers.get('X-PAYMENT-RESPONSE')).toBeNull();
    expect(rejected.headers.get('PAYMENT-RESPONSE')).toBeNull();

    // the authorization was never verified or settled, so it is still spendable:
    // had the rejected call settled, the facilitator would answer `nonce_reused`.
    const accepted = await fetch(`${base}/api/edge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-PAYMENT': header },
      body: JSON.stringify(VALID_BODY),
    });
    expect(accepted.status).toBe(200);
    const body = (await accepted.json()) as { verdict: string; fixture: string };
    expect(body.fixture).toBe(VALID_BODY.fixture);
    expect(['APPROVED', 'REJECTED', 'SKIP']).toContain(body.verdict);
  });
});
