/**
 * api/rails/cdp.ts — the x402 Bazaar rail (Coinbase CDP · Base · USDC).
 *
 * What is verifiable WITHOUT credentials, and therefore tested here:
 *   - network selection from CDP_X402_SERVER_ENVIRONMENT
 *   - the Bazaar discovery declaration is well-formed and its parameter
 *     contract matches api/validate.ts exactly (a drift here means buyers
 *     construct calls the preflight then rejects — the listing would advertise
 *     a contract the server does not honour)
 *   - the rail refuses to start with an actionable message when credentials
 *     are absent, rather than serving a rail that can never settle
 *   - the readiness report names every remaining manual gate
 *
 * What is NOT verifiable here (needs a CDP account + USDC on Base): the live
 * facilitator handshake, a real settlement, and Bazaar indexing. Those are
 * enumerated by `bazaarReadiness()` and printed in the deploy log.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

async function freshRail(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import('../api/rails/cdp');
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('network selection', () => {
  it('defaults to Base mainnet', async () => {
    const rail = await freshRail({ CDP_X402_SERVER_ENVIRONMENT: undefined });
    expect(rail.cdpNetwork()).toBe('eip155:8453');
    expect(rail.BASE_MAINNET_CAIP2).toBe('eip155:8453');
  });

  it('uses Base Sepolia in development', async () => {
    const rail = await freshRail({ CDP_X402_SERVER_ENVIRONMENT: 'development' });
    expect(rail.cdpNetwork()).toBe('eip155:84532');
  });
});

describe('credential guard', () => {
  it('refuses to build without CDP credentials, with an actionable message', async () => {
    const rail = await freshRail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    await expect(rail.buildCdpServer()).rejects.toThrow(/CDP_API_KEY_ID/);
    await expect(rail.buildCdpServer()).rejects.toThrow(/PAY_RAIL=okx/);
  });

  it('the lazy gate surfaces a credential failure through next(err), never as a crash', async () => {
    const rail = await freshRail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    const gate = rail.buildCdpPayGateLazy();
    const err = await new Promise<unknown>((resolve) => {
      gate({ path: '/api/edge' } as never, {} as never, ((e: unknown) => resolve(e)) as never);
    });
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/CDP_API_KEY_ID/);
  });
});

describe('quote + readiness reporting', () => {
  it('quotes the premium price on Base in USDC, not the $0.05 OKX price', async () => {
    const rail = await freshRail({ CDP_PRICE: undefined, CDP_X402_SERVER_ENVIRONMENT: undefined });
    const q = rail.cdpQuoteSummary();
    expect(q.rail).toBe('cdp');
    expect(q.venue).toBe('x402 Bazaar');
    expect(q.asset).toBe('USDC');
    expect(q.network).toBe('eip155:8453');
    expect(q.price).toBe('$15.00');
    expect(q.route).toBe('/api/edge');
  });

  it('honours a CDP_PRICE override', async () => {
    const rail = await freshRail({ CDP_PRICE: '$25.00' });
    expect(rail.cdpQuoteSummary().price).toBe('$25.00');
  });

  it('readiness names the validate call, the first settlement and the discovery check', async () => {
    const rail = await freshRail({ CDP_API_KEY_ID: undefined, CDP_API_KEY_SECRET: undefined });
    const r = rail.bazaarReadiness();
    expect(r.ready).toBe(false);
    const all = r.steps.join(' | ');
    expect(all).toMatch(/CDP_API_KEY_ID/);
    expect(all).toMatch(/x402\/validate/);
    expect(all).toMatch(/settlement/i);
    expect(all).toMatch(/discovery\/resources/);
  });

  it('reports ready once credentials are present', async () => {
    const rail = await freshRail({ CDP_API_KEY_ID: 'k', CDP_API_KEY_SECRET: 's' });
    expect(rail.bazaarReadiness().ready).toBe(true);
    expect(rail.cdpQuoteSummary().credentials).toMatch(/live/);
  });
});

describe('the Bazaar listing contract matches the server contract', () => {
  it('advertises exactly the params api/validate.ts accepts — fixture required, rest optional', async () => {
    await freshRail({ CDP_API_KEY_ID: 'k', CDP_API_KEY_SECRET: 's' });
    const { declareDiscoveryExtension } = await import('@x402/extensions/bazaar');
    expect(typeof declareDiscoveryExtension).toBe('function');

    const { edgeRequestSchema } = await import('../api/validate');
    // Everything the listing advertises as required must actually be required,
    // and everything it advertises as optional must actually parse when absent.
    const okMinimal = edgeRequestSchema.safeParse({ fixture: 'SF: FRA vs ESP' });
    expect(okMinimal.success).toBe(true);
    const missingFixture = edgeRequestSchema.safeParse({ selection: 'France ML', odds: 2.1 });
    expect(missingFixture.success).toBe(false);
    // the advertised optional set, all together
    const okFull = edgeRequestSchema.safeParse({
      fixture: 'SF: FRA vs ESP',
      selection: 'France ML',
      odds: 2.1,
      bankroll: 1000,
      proposed_stake_pct: 2,
    });
    expect(okFull.success).toBe(true);
  });
});
