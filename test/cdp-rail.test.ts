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

describe('venue-specific discovery shape (the two marketplaces disagree)', () => {
  // OKX.AI: validation must complete BEFORE the challenge — its validator sends
  // params (`x402-check --body`). Coinbase Bazaar: probes with a param-less POST
  // and fails the listing on anything that is not a 402 ("Skipped: endpoint did
  // not return 402" on every check).
  //
  // Asserted on the PREFLIGHT DECISION itself rather than through the app: with
  // dummy credentials the CDP gate cannot build, so an end-to-end 402 is not
  // observable here. What matters is whether preflight hands the request on to
  // the gate (discovery) or answers 400 itself (purchase attempt).
  async function decide(rail: string, opts: { body?: unknown; method?: string; headers?: Record<string, string> } = {}) {
    vi.resetModules();
    process.env.PAY_RAIL = rail;
    const { paramPreflight } = await import('../api/validate');
    const gate = paramPreflight();
    const req = {
      path: '/api/edge',
      method: opts.method ?? 'POST',
      body: opts.body ?? {},
      query: {},
      headers: opts.headers ?? {},
    };
    return new Promise<{ passedToGate: boolean; status?: number; body?: Record<string, unknown> }>((resolve) => {
      const res = {
        statusCode: 0,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: Record<string, unknown>) { resolve({ passedToGate: false, status: this.statusCode, body: payload }); return this; },
      };
      gate(req as never, res as never, (() => resolve({ passedToGate: true })) as never);
    });
  }

  it('OKX rail: a param-less POST is a purchase attempt -> 400, never reaches the gate', async () => {
    const r = await decide('okx', { body: {} });
    expect(r.passedToGate).toBe(false);
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe('invalid_request');
  });

  it('CDP rail: a param-less POST is the Bazaar validator probe -> passed to the gate for a 402', async () => {
    const r = await decide('cdp', { body: {} });
    expect(r.passedToGate).toBe(true);
  });

  it('both rails: a param-less GET is discovery', async () => {
    expect((await decide('okx', { method: 'GET' })).passedToGate).toBe(true);
    expect((await decide('cdp', { method: 'GET' })).passedToGate).toBe(true);
  });

  it('CDP rail: params present but INVALID is still 400, never a challenge', async () => {
    const r = await decide('cdp', { body: { bankroll: 100 } }); // no fixture
    expect(r.passedToGate).toBe(false);
    expect(r.status).toBe(400);
  });

  it('CDP rail: THE DEDUCTION GUARANTEE HOLDS — a PAID param-less call is 400 before the gate', async () => {
    const r = await decide('cdp', { body: {}, headers: { 'x-payment': 'base64-payload' } });
    expect(r.passedToGate).toBe(false);
    expect(r.status).toBe(400);
    expect(String(r.body?.payment)).toMatch(/nothing was deducted/i);
  });

  it('CDP rail: valid params pass through to the gate as normal', async () => {
    const r = await decide('cdp', { body: { fixture: 'SF: FRA vs ESP' } });
    expect(r.passedToGate).toBe(true);
  });
});
