/**
 * BuyerLens (COMPLEXITY §1.2, ARCHITECTURE §BuyerLens wiring + §Protocol
 * invariants #6): the X-PAYMENT decode, the local-faithful facilitator's REAL
 * EIP-712 signature recovery, and the db/buyers.ts store + forget path.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { authorizationTypes } from '@okxweb3/x402-evm';
import { LocalFacilitatorClient } from '../api/rails/localFacilitator';
import { openMemoryDb } from '../db/ledger';
import { appendBuyerCall, buyerSummary, buyerHistory, forgetBuyer } from '../db/buyers';
import { NET, PRICE_UNITS, PAYTO_ADDRESS } from '../config';

const REQUIREMENTS = {
  scheme: 'exact',
  network: NET.caip2,
  asset: NET.usdt0,
  amount: PRICE_UNITS,
  payTo: PAYTO_ADDRESS,
  maxTimeoutSeconds: 120,
  extra: { assetTransferMethod: 'eip3009', name: 'USD₮0', version: '1' },
} as const;

async function signAuthorization(pk: `0x${string}`, overrides: Partial<Record<string, unknown>> = {}) {
  const account = privateKeyToAccount(pk);
  const now = Math.floor(Date.now() / 1000);
  const authorization = {
    from: account.address,
    to: PAYTO_ADDRESS,
    value: PRICE_UNITS,
    validAfter: String(now - 60),
    validBefore: String(now + 120),
    nonce: `0x${'ab'.repeat(32)}` as `0x${string}`,
    ...overrides,
  };
  const signature = await account.signTypedData({
    domain: { name: 'USD₮0', version: '1', chainId: NET.chainId, verifyingContract: NET.usdt0 },
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: authorization.from as `0x${string}`,
      to: authorization.to as `0x${string}`,
      value: BigInt(authorization.value as string),
      validAfter: BigInt(authorization.validAfter as string),
      validBefore: BigInt(authorization.validBefore as string),
      nonce: authorization.nonce as `0x${string}`,
    },
  });
  return { authorization, signature, address: account.address };
}

describe('LocalFacilitatorClient.verify — genuine EIP-712 signature recovery (offline)', () => {
  it('a validly-signed EIP-3009 authorization verifies and recovers the correct payer', async () => {
    const pk = generatePrivateKey();
    const { authorization, signature, address } = await signAuthorization(pk);
    const facilitator = new LocalFacilitatorClient();
    const result = await facilitator.verify(
      { x402Version: 2, accepted: REQUIREMENTS as any, payload: { authorization, signature } } as any,
      REQUIREMENTS as any,
    );
    expect(result.isValid).toBe(true);
    expect(result.payer?.toLowerCase()).toBe(address.toLowerCase());
  });

  it('a tampered signature fails verification (flipped byte mid-signature)', async () => {
    const pk = generatePrivateKey();
    const { authorization, signature } = await signAuthorization(pk);
    // Flip a hex nibble inside the `r` component (well away from the trailing
    // recovery-id byte) so the recovered address is provably wrong, not just
    // an alternate-but-still-valid recovery candidate.
    const chars = signature.split('');
    const flipIdx = 10;
    chars[flipIdx] = chars[flipIdx] === '0' ? '1' : '0';
    const tampered = chars.join('') as `0x${string}`;
    const facilitator = new LocalFacilitatorClient();
    const result = await facilitator.verify(
      { x402Version: 2, accepted: REQUIREMENTS as any, payload: { authorization, signature: tampered } } as any,
      REQUIREMENTS as any,
    );
    expect(result.isValid).toBe(false);
  });

  it('a signature over the wrong payTo fails (payee mismatch)', async () => {
    const pk = generatePrivateKey();
    const wrongPayee = privateKeyToAccount(generatePrivateKey()).address;
    const { authorization, signature } = await signAuthorization(pk, { to: wrongPayee });
    const facilitator = new LocalFacilitatorClient();
    const result = await facilitator.verify(
      { x402Version: 2, accepted: REQUIREMENTS as any, payload: { authorization, signature } } as any,
      REQUIREMENTS as any,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('wrong_payee');
  });

  it('an expired authorization (validBefore in the past) fails', async () => {
    const pk = generatePrivateKey();
    const now = Math.floor(Date.now() / 1000);
    const { authorization, signature } = await signAuthorization(pk, { validAfter: String(now - 600), validBefore: String(now - 60) });
    const facilitator = new LocalFacilitatorClient();
    const result = await facilitator.verify(
      { x402Version: 2, accepted: REQUIREMENTS as any, payload: { authorization, signature } } as any,
      REQUIREMENTS as any,
    );
    expect(result.isValid).toBe(false);
    expect(result.invalidReason).toBe('expired');
  });

  it('settle() never fabricates a receipt when no live facilitator is configured (honesty gate)', async () => {
    const pk = generatePrivateKey();
    const { authorization, signature } = await signAuthorization(pk);
    const facilitator = new LocalFacilitatorClient();
    const result = await facilitator.settle(
      { x402Version: 2, accepted: REQUIREMENTS as any, payload: { authorization, signature } } as any,
      REQUIREMENTS as any,
    );
    expect(result.success).toBe(false);
    expect(result.transaction).toBe('');
    expect(result.errorReason).toBe('no_live_facilitator');
  });
});

describe('db/buyers.ts — BuyerLens store (write-only-on-verified-payment invariant tested at the API layer)', () => {
  let db: ReturnType<typeof openMemoryDb>;
  beforeEach(() => {
    db = openMemoryDb();
  });

  it('a fresh address has zero history', () => {
    const summary = buyerSummary(db, '0xAAA0000000000000000000000000000000AAA0');
    expect(summary.your_calls).toBe(0);
    expect(summary.drift).toBe('no history yet');
  });

  it('appendBuyerCall + buyerHistory round-trips', () => {
    const addr = '0xBBB0000000000000000000000000000000BBB0';
    appendBuyerCall(db, { buyer_from: addr, pick_hash: 'h1', fixture: 'SF: FRA vs ESP', verdict: 'APPROVED', grade: 'A', proposed_stake_pct: 8, ladder_stake_pct: 6, at: new Date().toISOString() });
    const hist = buyerHistory(db, addr);
    expect(hist.length).toBe(1);
    expect(hist[0].pick_hash).toBe('h1');
  });

  it('drift reports a tilt pattern when proposed stake consistently exceeds the ladder', () => {
    const addr = '0xCCC0000000000000000000000000000000CCC0';
    for (let i = 0; i < 3; i++) {
      appendBuyerCall(db, { buyer_from: addr, pick_hash: `h${i}`, fixture: 'f', verdict: 'APPROVED', grade: 'B', proposed_stake_pct: 8, ladder_stake_pct: 4, at: new Date().toISOString() });
    }
    const summary = buyerSummary(db, addr);
    expect(summary.your_avg_stake_vs_ladder).toBeCloseTo(4, 5);
    expect(summary.drift).toMatch(/tilt pattern/);
  });

  it('address matching is case-insensitive', () => {
    const addr = '0xDDD0000000000000000000000000000000dDd0';
    appendBuyerCall(db, { buyer_from: addr.toUpperCase(), pick_hash: 'h1', fixture: 'f', verdict: 'SKIP', grade: 'D', proposed_stake_pct: null, ladder_stake_pct: 0, at: new Date().toISOString() });
    expect(buyerHistory(db, addr.toLowerCase()).length).toBe(1);
  });

  it('forget:true deletes every row for that address (privacy note)', () => {
    const addr = '0xEEE0000000000000000000000000000000EEE0';
    appendBuyerCall(db, { buyer_from: addr, pick_hash: 'h1', fixture: 'f', verdict: 'APPROVED', grade: 'A', proposed_stake_pct: null, ladder_stake_pct: 6, at: new Date().toISOString() });
    const removed = forgetBuyer(db, addr);
    expect(removed).toBe(1);
    expect(buyerHistory(db, addr).length).toBe(0);
  });
});
