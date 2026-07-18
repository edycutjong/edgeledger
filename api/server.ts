/**
 * EdgeLedger (OKX.AI edition) — Express app.
 *
 *   POST /api/edge             gated by the `okx` x402 rail ($0.05, dual USD₮0/USDG accepts)
 *   POST /api/slate            free — BET/SKIP only
 *   POST /api/ledger           free — settled history + anchor
 *   POST /api/me               free — BuyerLens read + forget
 *   POST /api/receipts/verify  free — independent facilitator re-check
 *   GET  /api/edge             same x402 gate (OKX's review probe is a GET — 405 here read as "unreachable")
 *   GET  /health
 *
 * `demo` mode (createApp({ demo: true }) or `npm run api -- --demo`) disables
 * the paygate so the response SHAPE can be exercised without a live OKX
 * facilitator settlement — the same bypass pattern the ported Injective build
 * used (its api/server.ts header comment), needed here because the
 * local-faithful facilitator (api/rails/localFacilitator.ts) honestly refuses
 * to fabricate on-chain settlement when no real OKX credentials are
 * configured. `demo` is OFF by default; the required review-gate self-check
 * (`POST /api/edge` with no payment → 402) runs with the REAL payGate.
 */
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildOkxPayGate, warmFacilitator } from './rails/okx';
import {
  edgeHandler, slateHandler, ledgerHandler, meHandler, receiptsVerifyHandler, healthHandler, getDb,
} from './routes';
import { PORT, PAY_RAIL, API_BASE_URL, HAS_REAL_OKX_CREDS } from '../config';

/** CORS-open the free API so the ledger is a public, reusable proof layer. */
function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-PAYMENT, PAYMENT-SIGNATURE');
  res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE');
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
}

export function createApp(opts: { demo?: boolean } = {}): express.Express {
  const app = express();
  app.disable('x-powered-by');
  // Behind Railway's proxy `req.protocol` is "http" without this, which leaks
  // an http:// resource.url into the x402 challenge the SDK builds from the
  // request — OKX's validator compares it against the registered https endpoint.
  app.set('trust proxy', true);
  app.use(cors);
  app.use(express.json());

  // The SDK's browser sniff (Accept: text/html + Mozilla UA) swaps the 402 for
  // an HTML paywall WITHOUT the PAYMENT-REQUIRED header — and that header is
  // what OKX's marketplace validator checks ("x402 standard validation").
  // Force the JSON+header path on the paid route for every client.
  app.use('/api/edge', (req: Request, _res: Response, next: NextFunction) => {
    req.headers.accept = 'application/json';
    next();
  });

  // x402 gate — only protects the routes in its own routes map (POST /api/edge).
  if (!opts.demo && PAY_RAIL === 'okx') {
    app.use(buildOkxPayGate());
  }

  app.post('/api/edge', edgeHandler);
  // Paid GET support: OKX's x402 client sends business params in the query
  // string when the paid call is a GET. An unpaid GET never reaches here (the
  // gate's method-less route answers it with the 402 challenge).
  app.get('/api/edge', (req, res) => {
    req.body = { ...req.query };
    edgeHandler(req, res);
  });
  app.post('/api/slate', slateHandler);
  app.post('/api/ledger', ledgerHandler);
  app.post('/api/me', meHandler);
  app.post('/api/receipts/verify', receiptsVerifyHandler);
  app.get('/health', healthHandler);
  app.get('/api', (_req, res) =>
    res.json({ service: 'edgeledger-okx-api', see: ['/api/edge', '/api/slate', '/api/ledger', '/api/me', '/api/receipts/verify', '/health'] }),
  );

  // Public proof surface — a single served HTML page that calls this same API and
  // renders the VerdictCard (APPROVED/REJECTED/SKIP) + the loss-inclusive settled
  // ledger. This is what makes the "the agent said NO" magic moment *visible* to a
  // judge instead of curl output. Static; the page hits the live routes above.
  const webDir = path.join(fileURLToPath(new URL('..', import.meta.url)), 'web');
  app.use(express.static(webDir));

  return app;
}

export function main(argv: string[] = process.argv): Server {
  const demo = argv.includes('--demo');
  const app = createApp({ demo });
  getDb(); // warm the ledger
  const server = app.listen(PORT, () => {
    console.log(`EdgeLedger (OKX.AI edition) on http://localhost:${PORT} (rail=${PAY_RAIL})`);
    console.log(`  base url: ${API_BASE_URL}`);
    console.log(`  OKX Developer Portal credentials loaded: ${HAS_REAL_OKX_CREDS} (production settlement needs them — see DEMO.md)`);
    if (demo) console.log('  ⚠️  --demo: x402 gate DISABLED (paid payload rendered without payment)');
    console.log('  try: curl -i -X POST http://localhost:' + PORT + '/api/edge');
    // Prime the facilitator handshake at boot (non-blocking) so the first paid
    // /api/edge call is warm and cred/network errors show up here, not on a
    // buyer's request — see warmFacilitator(). Skipped in --demo (no gate).
    if (!demo && PAY_RAIL === 'okx') void warmFacilitator();
  });
  return server;
}

/** Boot only when this module is the process entrypoint (`tsx api/server.ts`). */
export function runIfEntrypoint(argv: string[], moduleUrl: string): Server | undefined {
  if (argv[1] && fileURLToPath(moduleUrl) === argv[1]) return main(argv);
  return undefined;
}

runIfEntrypoint(process.argv, import.meta.url);
