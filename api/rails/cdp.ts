/**
 * api/rails/cdp.ts — the x402 Bazaar rail, `PAY_RAIL=cdp`.
 *
 * ============================================================================
 * SECOND VENUE, SAME PRODUCT
 * ============================================================================
 * x402 is a Linux Foundation standard (formalised 2026-04-02; 22 members incl.
 * AWS, Google, Microsoft, Stripe, Visa, Mastercard, Circle), not an OKX
 * feature. EdgeLedger's engine, ledger, receipts, BuyerLens and the
 * validate-before-payment preflight are all venue-agnostic — so reaching a
 * second, much larger marketplace is a RAIL SWAP, not a rewrite:
 *
 *   | knob        | OKX.AI (rails/okx.ts)    | Bazaar (this file)        |
 *   |-------------|--------------------------|---------------------------|
 *   | facilitator | OKXFacilitatorClient     | CDP facilitator           |
 *   | network     | eip155:196  (X Layer)    | eip155:8453 (Base)        |
 *   | asset       | USD₮0                    | USDC                      |
 *   | discovery   | agent activate + review  | automatic on EVM routes   |
 *
 * Scale, for context: OKX.AI is 888 agents / ~$19K lifetime GMV; the x402
 * network reported 69,000 active agents, 165M transactions and ~$50M
 * cumulative volume by late April 2026. Listing on Bazaar is free and
 * permissionless — there is no human review gauntlet.
 *
 * COMPOSITION: `createX402Server()` (CDP) returns an `X402Server extends
 * x402HTTPResourceServer`, which is exactly what `@x402/express`'s
 * `paymentMiddlewareFromHTTPServer()` consumes. The CDP SDK injects the
 * `bazaar` and `builder-code` extensions automatically on EVM routes; we
 * additionally declare an explicit discovery schema so the listing is
 * searchable and an agent can construct a valid call without guessing.
 *
 * CREDENTIALS: `CDP_API_KEY_ID` + `CDP_API_KEY_SECRET`. `payToConfig` is
 * `{ type: 'address' }` so we keep our own receiver address and CDP never
 * provisions a wallet — meaning `CDP_WALLET_SECRET` is NOT required.
 *
 * DISCOVERABILITY IS NOT AUTOMATIC ON DAY ONE. Per CDP docs a service appears
 * in the Bazaar index only once it is (1) deployed to public HTTPS, (2)
 * validated via `POST https://api.cdp.coinbase.com/platform/v2/x402/validate`,
 * and (3) has completed ONE successful paid settlement through the CDP
 * facilitator. Step 3 needs real USDC on Base — see `bazaarReadiness()`.
 */
import { createX402Server } from '@coinbase/cdp-sdk/x402';
import { declareDiscoveryExtension } from '@x402/extensions/bazaar';
import { paymentMiddlewareFromHTTPServer } from '@x402/express';
import type { RequestHandler } from 'express';
import {
  CDP_API_KEY_ID,
  CDP_API_KEY_SECRET,
  CDP_ENV,
  CDP_PRICE,
  HAS_REAL_CDP_CREDS,
  PAYTO_ADDRESS,
} from '../../config';
import { EDGE_DESCRIPTION, EDGE_ROUTE_KEY } from './okx';

/** Base mainnet / Base Sepolia in CAIP-2, picked by CDP_X402_SERVER_ENVIRONMENT. */
export const BASE_MAINNET_CAIP2 = 'eip155:8453';
export const BASE_SEPOLIA_CAIP2 = 'eip155:84532';
export function cdpNetwork(): string {
  return CDP_ENV === 'development' ? BASE_SEPOLIA_CAIP2 : BASE_MAINNET_CAIP2;
}

/**
 * The Bazaar discovery declaration — this is the listing copy an agent reads
 * when deciding whether to buy, so it carries the full parameter contract.
 * It mirrors `api/validate.ts::edgeRequestSchema` exactly; if the two drift,
 * buyers construct calls the preflight then rejects.
 */
function edgeDiscovery() {
  // `method` is intentionally absent — the SDK infers it from the route key
  // (`POST /api/edge`), and DeclareDiscoveryExtensionInput omits the field.
  return declareDiscoveryExtension({
    bodyType: 'json',
    // `input` is the example INSTANCE, `inputSchema` is the contract. Both are
    // required: CDP's validator parses the recorded body against the declared
    // schema, so omitting `input` leaves it `{}` and the listing fails its own
    // `required: ["fixture"]` check with
    // "v2 discovery extension validation failed: (root).input.body: fixture is required".
    input: { fixture: 'SF: FRA vs ESP', selection: 'France ML', odds: 2.1 },
    inputSchema: {
      type: 'object',
      properties: {
        fixture: { type: 'string', description: 'Fixture to judge, e.g. "SF: FRA vs ESP". REQUIRED.' },
        selection: { type: 'string', description: 'Optional. The side you propose backing, e.g. "France ML". With `odds`, switches to validate mode.' },
        odds: { type: 'number', description: 'Optional. Decimal odds you can get, must be > 1. With `selection`, switches to validate mode.' },
        bankroll: { type: 'number', description: 'Optional. Bankroll for stake sizing; omit for percentage-only output.' },
        proposed_stake_pct: { type: 'number', description: 'Optional. Your intended stake %, recorded for discipline tracking.' },
      },
      required: ['fixture'],
    },
    output: {
      example: {
        mode: 'validate',
        fixture: 'SF: FRA vs ESP',
        selection: 'France ML',
        verdict: 'REJECTED',
        edge_grade: 'D',
        stake: { pct: 0, rung: 'pass' },
        similar_settled: { n: 12, win_rate: 0.42, roi_pct: -6.1 },
        pick_hash: '0x…',
      },
    },
  });
}

/**
 * Build the CDP-backed x402 resource server for the Bazaar rail.
 * Throws with an actionable message when credentials are absent — this rail is
 * opt-in (`PAY_RAIL=cdp`), so failing loudly beats silently serving a rail that
 * can never settle.
 */
export async function buildCdpServer() {
  if (!HAS_REAL_CDP_CREDS) {
    throw new Error(
      'PAY_RAIL=cdp requires CDP_API_KEY_ID and CDP_API_KEY_SECRET (Coinbase Developer Platform). ' +
        'Set them, or run the default PAY_RAIL=okx rail.',
    );
  }
  return createX402Server({
    apiKeyId: CDP_API_KEY_ID,
    apiKeySecret: CDP_API_KEY_SECRET,
    environment: CDP_ENV,
    // Keep OUR receiver address; CDP provisions nothing, so no wallet secret.
    payToConfig: { type: 'address', evm: PAYTO_ADDRESS },
    routes: {
      [`POST ${EDGE_ROUTE_KEY}`]: {
        price: CDP_PRICE,
        description: EDGE_DESCRIPTION,
        networks: [cdpNetwork()],
        maxTimeoutSeconds: 300,
        extensions: { ...edgeDiscovery() },
      },
    },
  });
}

/**
 * The Express payment gate for `PAY_RAIL=cdp`. Mounted in exactly the same
 * position as `buildOkxPayGate()` — AFTER `paramPreflight()`, so the
 * validate-before-payment guarantee holds identically on this venue.
 */
export async function buildCdpPayGate(): Promise<RequestHandler> {
  const server = await buildCdpServer();
  return paymentMiddlewareFromHTTPServer(server) as unknown as RequestHandler;
}

/**
 * Synchronous mount point for an asynchronously-built gate.
 *
 * `createX402Server()` is async (it resolves the facilitator and expands the
 * routes), but `createApp()` is sync and every caller and test depends on that.
 * This defers construction to the first gated request and memoises it — one
 * build, shared by every subsequent call. A build failure is passed to
 * `next(err)` rather than thrown into the event loop, so a missing credential
 * surfaces as a normal 500 with a readable message instead of crashing the
 * process on boot.
 */
export function buildCdpPayGateLazy(): RequestHandler {
  let gate: RequestHandler | null = null;
  let pending: Promise<RequestHandler> | null = null;
  return (req, res, next) => {
    // Only the gated route may trigger a build. Without this guard an
    // unconfigured rail fails EVERY request — including `/health` and the free
    // routes — because the build error is raised before the underlying
    // middleware gets a chance to pass non-paid paths through. That would fail
    // the platform health check and block the deploy outright.
    const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path;
    if (path !== EDGE_ROUTE_KEY) {
      next();
      return;
    }
    if (gate) {
      gate(req, res, next);
      return;
    }
    pending ??= buildCdpPayGate();
    pending
      .then((g) => {
        gate = g;
        g(req, res, next);
      })
      .catch((err) => {
        pending = null; // allow a retry on the next request
        next(err);
      });
  };
}

/**
 * What still stands between this deployment and a live Bazaar listing.
 * Printed at boot so the remaining manual steps are visible in deploy logs
 * rather than discovered weeks later (the CLV Scout lesson: find the
 * platform's own gates before the platform finds them for you).
 */
export function bazaarReadiness(): { ready: boolean; steps: string[] } {
  const steps: string[] = [];
  if (!HAS_REAL_CDP_CREDS) steps.push('set CDP_API_KEY_ID + CDP_API_KEY_SECRET');
  steps.push('deploy this rail behind public HTTPS');
  steps.push('POST https://api.cdp.coinbase.com/platform/v2/x402/validate with the endpoint URL');
  steps.push(`complete ONE real settlement on ${cdpNetwork()} (needs USDC on Base in a buyer wallet)`);
  steps.push('confirm via GET https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources');
  return { ready: HAS_REAL_CDP_CREDS, steps };
}

/** The quote a buyer sees on this rail — mirrors okx.ts::quoteSummary for parity. */
export function cdpQuoteSummary() {
  return {
    service: 'edgeledger',
    rail: 'cdp',
    venue: 'x402 Bazaar',
    network: cdpNetwork(),
    asset: 'USDC',
    price: CDP_PRICE,
    payTo: PAYTO_ADDRESS,
    route: EDGE_ROUTE_KEY,
    discoverable: true,
    credentials: HAS_REAL_CDP_CREDS ? 'CDP facilitator (live)' : 'MISSING — rail will refuse to start',
  };
}
