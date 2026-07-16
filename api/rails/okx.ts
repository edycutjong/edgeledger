/**
 * OKX x402 payment middleware wiring — api/rails/okx.ts, the ONLY new
 * infrastructure file per ARCHITECTURE.md §Payment wiring.
 *
 * Uses the REAL, installed `@okxweb3/x402-express` + `@okxweb3/x402-core` +
 * `@okxweb3/x402-evm` packages (verified on npm 2026-07-15: x402-express
 * 0.1.1, x402-core 0.1.0, x402-evm 0.2.1 — installed and their compiled
 * `.d.ts` read directly, not guessed from docs).
 *
 * TWO CORRECTIONS vs the ARCHITECTURE.md sketch (shipped types win, same
 * pattern the ported Injective build used when its prose disagreed with the
 * SDK it actually shipped against):
 *
 *   1. `ExactEvmScheme` for SERVER-side registration must come from the
 *      subpath `@okxweb3/x402-evm/exact/server` — the top-level
 *      `@okxweb3/x402-evm` export of the same class name is the CLIENT-side
 *      implementation (constructor takes a signer). Importing the wrong one
 *      throws at construction time.
 *   2. `PaymentOption.price` accepts `Money | AssetAmount`. To get the
 *      documented DUAL-TOKEN accepts (USD₮0 *and* USDG, both zero-gas — 1.5),
 *      each entry in `accepts` is its own PaymentOption with an explicit
 *      `AssetAmount` price (`{asset, amount}`), not a single `"$0.05"` string
 *      (which would resolve to one implicit default token per network).
 *
 * Facilitator: real `OKXFacilitatorClient` when Developer Portal credentials
 * are configured (production); otherwise a local-faithful `FacilitatorClient`
 * (api/rails/localFacilitator.ts) that does genuine EIP-712 signature
 * recovery but honestly refuses to fabricate on-chain settlement — see that
 * file's header. Either way this module never needs live network access to
 * emit the 402 challenge (routes/schemes are pure local config), so `npm test`
 * runs fully offline.
 */
import { paymentMiddleware } from '@okxweb3/x402-express';
import { x402ResourceServer } from '@okxweb3/x402-core/server';
import type { RoutesConfig, FacilitatorClient } from '@okxweb3/x402-core/server';
import { OKXFacilitatorClient } from '@okxweb3/x402-core';
import { ExactEvmScheme } from '@okxweb3/x402-evm/exact/server';
import type { RequestHandler } from 'express';
import {
  NET,
  PAYTO_ADDRESS,
  PRICE_UNITS,
  HAS_REAL_OKX_CREDS,
  OKX_API_KEY,
  OKX_SECRET_KEY,
  OKX_PASSPHRASE,
} from '../../config';
import { LocalFacilitatorClient } from './localFacilitator';

export const EDGE_ROUTE_KEY = 'POST /api/edge';

export const EDGE_DESCRIPTION =
  'EdgeLedger — validate a World Cup bet: verdict (APPROVED/REJECTED/SKIP), edge grade, ' +
  'conviction-ladder stake, mirror receipts, and a pick hash. The x402 receipt is the ' +
  'immutable pre-decision timestamp for the call.';

/** The real OKXFacilitatorClient in production; the local-faithful one otherwise. */
export function buildFacilitatorClient(): FacilitatorClient {
  if (HAS_REAL_OKX_CREDS) {
    return new OKXFacilitatorClient({
      apiKey: OKX_API_KEY,
      secretKey: OKX_SECRET_KEY,
      passphrase: OKX_PASSPHRASE,
    });
  }
  return new LocalFacilitatorClient();
}

/** RoutesConfig for the gated endpoints — dual accepts (USD₮0 + USDG), both zero-gas. */
export function buildRoutes(): RoutesConfig {
  return {
    [EDGE_ROUTE_KEY]: {
      description: EDGE_DESCRIPTION,
      mimeType: 'application/json',
      accepts: [
        {
          scheme: 'exact',
          network: NET.caip2,
          payTo: PAYTO_ADDRESS,
          price: { asset: NET.usdt0, amount: PRICE_UNITS },
          maxTimeoutSeconds: 120,
          extra: { assetTransferMethod: 'eip3009', name: 'USD₮0', version: '1' },
        },
        {
          scheme: 'exact',
          network: NET.caip2,
          payTo: PAYTO_ADDRESS,
          price: { asset: NET.usdg, amount: PRICE_UNITS },
          maxTimeoutSeconds: 120,
          extra: { assetTransferMethod: 'eip3009', name: 'USDG', version: '1' },
        },
      ],
    },
  };
}

/** Build the x402ResourceServer: one facilitator, the exact/EVM scheme registered on our network(s). */
export function buildResourceServer(): x402ResourceServer {
  const server = new x402ResourceServer(buildFacilitatorClient());
  server.register('eip155:196', new ExactEvmScheme());
  server.register('eip155:1952', new ExactEvmScheme());
  return server;
}

/**
 * Express middleware for the `okx` rail (PAY_RAIL=okx — ARCHITECTURE §Rail
 * selection). `syncFacilitatorOnStart` stays at its default (true): the
 * resource server needs `facilitator.getSupported()` at least once to know
 * which scheme/network pairs it can quote (`x402ResourceServer.initialize()`,
 * called internally). This is still offline-safe here: our LocalFacilitatorClient
 * (api/rails/localFacilitator.ts) answers `getSupported()` from pure local
 * data, no network — only the real `OKXFacilitatorClient` (production, real
 * credentials) actually reaches out to web3.okx.com.
 */
export function buildOkxPayGate(): RequestHandler {
  const server = buildResourceServer();
  return paymentMiddleware(buildRoutes(), server) as unknown as RequestHandler;
}

/** The quote a buyer sees pre-flight — for docs/tests/DEMO.md, mirrors buildRoutes(). */
export function quoteSummary() {
  const routes = buildRoutes() as Record<string, any>;
  const route = routes[EDGE_ROUTE_KEY];
  return {
    route: EDGE_ROUTE_KEY,
    x402Version: 2,
    network: NET.caip2,
    network_name: NET.name,
    accepts: route.accepts.map((a: any) => ({
      scheme: a.scheme,
      network: a.network,
      asset: a.price.asset,
      amount_units: a.price.amount,
      amount_usd: Number(a.price.amount) / 1e6,
      payTo: a.payTo,
      asset_transfer_method: a.extra.assetTransferMethod,
      token_name: a.extra.name,
    })),
    facilitator: HAS_REAL_OKX_CREDS ? 'OKXFacilitatorClient (live)' : 'LocalFacilitatorClient (local-faithful — see api/rails/localFacilitator.ts)',
    explorer: NET.explorer,
    rpc: NET.rpc,
  };
}
