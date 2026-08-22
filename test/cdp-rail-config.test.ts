/**
 * api/rails/cdp.ts — what we actually hand to the CDP SDK.
 *
 * The credential-gated paths (`createX402Server`, the Express adapter) cannot
 * run without a Coinbase account, so the SDK is mocked here and the assertions
 * are on OUR config object. That config IS the Bazaar listing: price, network,
 * receiver address and the advertised parameter contract. Getting it wrong
 * publishes a listing that takes money on terms the server does not honour —
 * so it is worth pinning even though the facilitator itself is out of reach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const ORIGINAL_ENV = { ...process.env };
const createX402Server = vi.fn(async (config: Record<string, unknown>) => ({ __config: config }));
const paymentMiddlewareFromHTTPServer = vi.fn((_server: unknown) => (_req: unknown, _res: unknown, next: () => void) => next());

vi.mock('@coinbase/cdp-sdk/x402', () => ({ createX402Server: (c: Record<string, unknown>) => createX402Server(c) }));
vi.mock('@x402/express', () => ({
  paymentMiddlewareFromHTTPServer: (s: unknown) => paymentMiddlewareFromHTTPServer(s),
}));

async function railWithCreds() {
  vi.resetModules();
  process.env.CDP_API_KEY_ID = 'test-key-id';
  process.env.CDP_API_KEY_SECRET = 'test-key-secret';
  return import('../api/rails/cdp');
}

beforeEach(() => {
  createX402Server.mockClear();
  paymentMiddlewareFromHTTPServer.mockClear();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe('the config handed to createX402Server IS the Bazaar listing', () => {
  it('passes credentials, keeps OUR receiver address, and provisions no wallet', async () => {
    const rail = await railWithCreds();
    await rail.buildCdpServer();

    expect(createX402Server).toHaveBeenCalledTimes(1);
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;

    expect(cfg.apiKeyId).toBe('test-key-id');
    expect(cfg.apiKeySecret).toBe('test-key-secret');
    // type 'address' means CDP provisions nothing and CDP_WALLET_SECRET is not
    // required — payouts land in the same address as the OKX rail.
    expect(cfg.payToConfig).toEqual({ type: 'address', evm: '0x45078eD96C2bB171009A47a57aF5C085Bf4fD0e3' });
    expect(cfg).not.toHaveProperty('walletSecret');
  });

  it('registers POST /api/edge on Base at the premium price', async () => {
    const rail = await railWithCreds();
    await rail.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;

    const key = 'POST /api/edge';
    expect(Object.keys(cfg.routes)).toEqual([key]);
    const route = cfg.routes[key];
    expect(route.price).toBe('$15.00');
    expect(route.networks).toEqual(['eip155:8453']);
    expect(route.maxTimeoutSeconds).toBe(300);
    expect(typeof route.description).toBe('string');
    expect(route.description.length).toBeGreaterThan(20);
  });

  it('the route carries a Bazaar discovery declaration naming fixture as the only required param', async () => {
    const rail = await railWithCreds();
    await rail.buildCdpServer();
    const route = (createX402Server.mock.calls[0][0] as Record<string, any>).routes['POST /api/edge'];

    expect(route.extensions).toBeTruthy();
    const serialized = JSON.stringify(route.extensions);
    // the advertised contract, mirrored from api/validate.ts::edgeRequestSchema
    expect(serialized).toContain('fixture');
    expect(serialized).toContain('selection');
    expect(serialized).toContain('odds');
    expect(serialized).toContain('bankroll');
    expect(serialized).toContain('proposed_stake_pct');
    // and a worked example so a buying agent can construct a call
    expect(serialized).toContain('verdict');
    // the example INSTANCE must satisfy the declared schema, or CDP's validator
    // fails the listing with "(root).input.body: fixture is required"
    const ext = JSON.parse(serialized) as Record<string, any>;
    const info = JSON.parse(JSON.stringify(ext)).bazaar?.info ?? Object.values(ext)[0]?.info;
    expect(info?.input?.body?.fixture).toBeTruthy();
  });

  it('honours CDP_PRICE and the development environment together', async () => {
    vi.resetModules();
    process.env.CDP_API_KEY_ID = 'k';
    process.env.CDP_API_KEY_SECRET = 's';
    process.env.CDP_PRICE = '$25.00';
    process.env.CDP_X402_SERVER_ENVIRONMENT = 'development';
    const rail = await import('../api/rails/cdp');
    await rail.buildCdpServer();
    const cfg = createX402Server.mock.calls[0][0] as Record<string, any>;
    expect(cfg.environment).toBe('development');
    expect(cfg.routes['POST /api/edge'].price).toBe('$25.00');
    expect(cfg.routes['POST /api/edge'].networks).toEqual(['eip155:84532']);
  });
});

describe('the Express adapter', () => {
  it('wraps the CDP server with paymentMiddlewareFromHTTPServer', async () => {
    const rail = await railWithCreds();
    const gate = await rail.buildCdpPayGate();
    expect(paymentMiddlewareFromHTTPServer).toHaveBeenCalledTimes(1);
    expect(typeof gate).toBe('function');
  });

  it('the lazy gate builds ONCE and reuses the result across requests', async () => {
    const rail = await railWithCreds();
    const gate = rail.buildCdpPayGateLazy();
    const run = (path = '/api/edge') =>
      new Promise<void>((resolve) => gate({ path } as never, {} as never, (() => resolve()) as never));
    await run();
    await run();
    await run();
    expect(createX402Server).toHaveBeenCalledTimes(1);
    expect(paymentMiddlewareFromHTTPServer).toHaveBeenCalledTimes(1);
  });

  it('passes non-gated paths straight through WITHOUT building — an unconfigured rail must not break /health', async () => {
    vi.resetModules();
    delete process.env.CDP_API_KEY_ID;
    delete process.env.CDP_API_KEY_SECRET;
    const rail = await import('../api/rails/cdp');
    const gate = rail.buildCdpPayGateLazy();
    for (const path of ['/health', '/api/slate', '/api/ledger', '/']) {
      const err = await new Promise<unknown>((resolve) =>
        gate({ path } as never, {} as never, ((e: unknown) => resolve(e)) as never),
      );
      expect(err).toBeUndefined(); // next() with no error
    }
    expect(createX402Server).not.toHaveBeenCalled();
  });
});
