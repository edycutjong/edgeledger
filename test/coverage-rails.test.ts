/**
 * Coverage completion for the payment rails:
 *   - localFacilitator.ts: the not-yet-exercised verify/settle branches
 *     (missing signature, insufficient value, payer mismatch, nonce replay,
 *     default EIP-712 domain, settle-on-invalid, getSettleStatus).
 *   - okx.ts: quoteSummary() + the real-credentials facilitator branch.
 * All signatures are produced with real viem accounts — no crypto is faked.
 */
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { authorizationTypes } from '@okxweb3/x402-evm';
import { LocalFacilitatorClient } from '../api/rails/localFacilitator';
import { quoteSummary, buildFacilitatorClient, buildRoutes, EDGE_ROUTE_KEY } from '../api/rails/okx';
import { NET, PRICE_UNITS, PAYTO_ADDRESS } from '../config';

const BASE_REQ = {
  scheme: 'exact',
  network: NET.caip2,
  asset: NET.usdt0,
  amount: PRICE_UNITS,
  payTo: PAYTO_ADDRESS,
  maxTimeoutSeconds: 120,
  extra: { assetTransferMethod: 'eip3009', name: 'USD₮0', version: '1' },
} as const;

async function sign(
  pk: `0x${string}`,
  opts: {
    from?: `0x${string}`;
    to?: `0x${string}`;
    value?: string;
    nonce?: `0x${string}`;
    domain?: { name?: string; version?: string; chainId?: number; verifyingContract?: `0x${string}` };
  } = {},
) {
  const account = privateKeyToAccount(pk);
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    from: opts.from ?? account.address,
    to: opts.to ?? PAYTO_ADDRESS,
    value: opts.value ?? PRICE_UNITS,
    validAfter: String(now - 60),
    validBefore: String(now + 120),
    nonce: opts.nonce ?? (`0x${'cd'.repeat(32)}` as `0x${string}`),
  };
  const domain = {
    name: opts.domain?.name ?? 'USD₮0',
    version: opts.domain?.version ?? '1',
    chainId: opts.domain?.chainId ?? NET.chainId,
    verifyingContract: opts.domain?.verifyingContract ?? NET.usdt0,
  };
  const signature = await account.signTypedData({
    domain,
    types: authorizationTypes,
    primaryType: 'TransferWithAuthorization',
    message: {
      from: auth.from,
      to: auth.to as `0x${string}`,
      value: BigInt(auth.value),
      validAfter: BigInt(auth.validAfter),
      validBefore: BigInt(auth.validBefore),
      nonce: auth.nonce,
    },
  });
  return { auth, signature, address: account.address };
}

const fac = () => new LocalFacilitatorClient();
const rand = () => `0x${Array.from({ length: 64 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}` as `0x${string}`;

describe('LocalFacilitatorClient.verify — remaining branches', () => {
  it('missing signature → invalid_payload', async () => {
    const { auth } = await sign(generatePrivateKey());
    const r = await fac().verify({ payload: { authorization: auth } } as any, BASE_REQ as any);
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('invalid_payload');
  });

  it('authorization value below the required amount → insufficient_value', async () => {
    const { auth, signature } = await sign(generatePrivateKey(), { value: '1', nonce: rand() });
    const r = await fac().verify({ payload: { authorization: auth, signature } } as any, BASE_REQ as any);
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('insufficient_value');
  });

  it('recovered signer != authorization.from → signature_mismatch', async () => {
    // account A signs a message that CLAIMS from = account B → recovery yields A, not B.
    const a = generatePrivateKey();
    const b = privateKeyToAccount(generatePrivateKey()).address;
    const { auth, signature } = await sign(a, { from: b, nonce: rand() });
    const r = await fac().verify({ payload: { authorization: auth, signature } } as any, BASE_REQ as any);
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('signature_mismatch');
  });

  it('default EIP-712 domain is used when requirements omit extra + network is bare', async () => {
    // requirements.extra omitted, network without ":" → chainId falls back to 196.
    const reqNoExtra = { ...BASE_REQ, network: 'eip155', extra: undefined } as any;
    const nonce = rand();
    const { auth, signature } = await sign(generatePrivateKey(), {
      nonce,
      domain: { name: 'USD₮0', version: '1', chainId: 196, verifyingContract: NET.usdt0 },
    });
    const r = await fac().verify({ payload: { authorization: auth, signature } } as any, reqNoExtra);
    expect(r.isValid).toBe(true);
  });

  it('a structurally-invalid signature is caught and reported (recovery throws)', async () => {
    const { auth } = await sign(generatePrivateKey(), { nonce: rand() });
    const r = await fac().verify({ payload: { authorization: auth, signature: '0x1234' } } as any, BASE_REQ as any);
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('signature_invalid');
  });

  it('a nonce already spent by settle() is rejected on re-verify', async () => {
    const nonce = rand();
    const { auth, signature } = await sign(generatePrivateKey(), { nonce });
    const f = fac();
    await f.settle({ payload: { authorization: auth, signature } } as any, BASE_REQ as any); // spends the nonce
    const r = await f.verify({ payload: { authorization: auth, signature } } as any, BASE_REQ as any);
    expect(r.isValid).toBe(false);
    expect(r.invalidReason).toBe('nonce_reused');
  });
});

describe('LocalFacilitatorClient.settle / getSettleStatus', () => {
  it('settle() short-circuits with the verify failure when the payload is invalid', async () => {
    const { auth } = await sign(generatePrivateKey()); // no signature attached
    const r = await fac().settle({ payload: { authorization: auth } } as any, BASE_REQ as any);
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe('invalid_payload');
    expect(r.transaction).toBe('');
  });

  it('settle() falls back to verify_failed when verify reports invalid without a reason', async () => {
    const { vi } = await import('vitest');
    const f = fac();
    // simulate a verify that fails without populating invalidReason → exercises the `?? verify_failed` fallback
    vi.spyOn(f, 'verify').mockResolvedValue({ isValid: false } as any);
    const { auth, signature } = await sign(generatePrivateKey(), { nonce: rand() });
    const r = await f.settle({ payload: { authorization: auth, signature } } as any, BASE_REQ as any);
    expect(r.success).toBe(false);
    expect(r.errorReason).toBe('verify_failed');
    vi.restoreAllMocks();
  });

  it('getSettleStatus is honestly pending (no live facilitator)', async () => {
    const r = await fac().getSettleStatus('0xabc');
    expect(r.success).toBe(false);
    expect(r.status).toBe('pending');
    expect(r.errorReason).toBe('no_live_facilitator');
  });
});

describe('okx.ts — quoteSummary + facilitator selection', () => {
  it('quoteSummary mirrors buildRoutes (dual accepts, local facilitator by default)', () => {
    const q = quoteSummary();
    expect(q.route).toBe(EDGE_ROUTE_KEY);
    expect(q.x402Version).toBe(2);
    expect(q.accepts.length).toBe(2);
    expect(q.accepts.map((a: any) => a.token_name).sort()).toEqual(['USDG', 'USD₮0']);
    expect(q.accepts[0].amount_usd).toBeCloseTo(Number(PRICE_UNITS) / 1e6, 6);
    expect(q.facilitator).toMatch(/LocalFacilitatorClient/);
    // buildRoutes shape is internally consistent with the quote
    expect(Object.keys(buildRoutes())).toContain(EDGE_ROUTE_KEY);
  });

  it('without real OKX credentials, buildFacilitatorClient returns the local-faithful client', () => {
    expect(buildFacilitatorClient()).toBeInstanceOf(LocalFacilitatorClient);
  });
});

describe('okx.ts — real-credentials facilitator branch (isolated module reload)', () => {
  it('constructs the OKXFacilitatorClient when Developer Portal creds are present', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.stubEnv('OKX_API_KEY', 'k');
    vi.stubEnv('OKX_SECRET_KEY', 's');
    vi.stubEnv('OKX_PASSPHRASE', 'p');
    const okxMod = await import('../api/rails/okx');
    const { OKXFacilitatorClient } = await import('@okxweb3/x402-core');
    const client = okxMod.buildFacilitatorClient();
    expect(client).toBeInstanceOf(OKXFacilitatorClient);
    // and quoteSummary reports the live facilitator label in this mode
    expect(okxMod.quoteSummary().facilitator).toMatch(/OKXFacilitatorClient \(live\)/);
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});

describe('okx.ts — warmFacilitator() boot self-check', () => {
  it('resolves and reports ready when the (local) facilitator handshake succeeds', async () => {
    const { vi } = await import('vitest');
    const { warmFacilitator } = await import('../api/rails/okx');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmFacilitator()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('x402 facilitator ready'));
    log.mockRestore();
  });

  it('swallows a slow handshake via the bounded timeout (logs a warning, never throws)', async () => {
    const { vi } = await import('vitest');
    const { x402ResourceServer } = await import('@okxweb3/x402-core/server');
    const { warmFacilitator } = await import('../api/rails/okx');
    // Force initialize() slower than the timeout so the race rejects → catch branch.
    const init = vi
      .spyOn(x402ResourceServer.prototype, 'initialize')
      .mockImplementation(() => new Promise<void>((resolve) => { setTimeout(resolve, 50); }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(warmFacilitator(1)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('facilitator warm-up failed'));
    init.mockRestore();
    warn.mockRestore();
  });

  it('reports the live-facilitator label when Developer Portal creds are present', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.stubEnv('OKX_API_KEY', 'k');
    vi.stubEnv('OKX_SECRET_KEY', 's');
    vi.stubEnv('OKX_PASSPHRASE', 'p');
    const { x402ResourceServer } = await import('@okxweb3/x402-core/server');
    const { warmFacilitator } = await import('../api/rails/okx');
    // Mock the handshake to succeed locally — no real web3.okx.com call.
    const init = vi.spyOn(x402ResourceServer.prototype, 'initialize').mockResolvedValue(undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await expect(warmFacilitator()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('OKXFacilitatorClient (live)'));
    init.mockRestore();
    log.mockRestore();
    vi.unstubAllEnvs();
    vi.resetModules();
  });
});
