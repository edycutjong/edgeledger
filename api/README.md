# `api/` — HTTP layer

The Express app and the OKX x402 payment rail. Pure HTTP + payments — all edge
math and persistence live in [`../engine/`](../engine) and [`../db/`](../db);
this layer only wires them behind paid/free routes.

## Files

| File | Responsibility |
|---|---|
| [`server.ts`](server.ts) | Builds the Express app (`createApp`), the process entrypoint (`main` / `runIfEntrypoint`). Applies CORS + JSON, mounts the x402 gate, the routes, and serves the `web/` proof page. |
| [`routes.ts`](routes.ts) | The six request handlers + `getDb()` (lazy SQLite handle) and `decodeXPayment()` (X-PAYMENT header → EIP-3009 `authorization.from`). |
| [`rails/okx.ts`](rails/okx.ts) | The OKX x402 rail: `paymentMiddleware` from `@okxweb3/x402-express`, the routes map, the resource server, and facilitator selection. |
| [`rails/localFacilitator.ts`](rails/localFacilitator.ts) | `LocalFacilitatorClient` — real **offline** EIP-712/EIP-3009 signature verification + an honestly-labeled *local-pending* settlement used when no OKX credentials are configured. |

## Routes

Mounted in `createApp()` ([`server.ts`](server.ts)):

| Method + Path | Gate | Handler | Returns |
|---|---|---|---|
| `POST /api/edge` | **$0.05 x402** | `edgeHandler` | Verdict: `APPROVED` / `REJECTED` / `SKIP` + edge grade, conviction-ladder stake, mirror receipt, `pick_hash`. |
| `GET /api/edge` | — | `methodNotAllowed` | `405` (review-gate semantics: a paid route never answers GET). |
| `POST /api/slate` | free | `slateHandler` | Today's BET/SKIP slate. |
| `POST /api/ledger` | free | `ledgerHandler` | Every settled call — **losses included** — with totals + `anchor`. |
| `POST /api/me` | free | `meHandler` | **BuyerLens** — a payer's own history keyed off their X-PAYMENT identity (`{forget:true}` deletes it). |
| `POST /api/receipts/verify` | free | `receiptsVerifyHandler` | Live re-check of a settlement against the OKX Facilitator's `GET /settle/status`. |
| `GET /health`, `GET /api` | free | `healthHandler` / index | Liveness + route index. |
| `/*` (static) | — | `express.static` | Serves the [`../web/`](../web) VerdictCard proof page. |

## Payment flow (`POST /api/edge`)

```
Buyer --POST /api/edge (no payment)--> buildOkxPayGate()  --> 402 challenge (x402Version:2, accepts: USD₮0 | USDG on eip155:196)
Buyer --POST /api/edge + X-PAYMENT----> paymentMiddleware  --> verify (facilitator) --> edgeHandler --> verdict + pick_hash
                                             |                     settle -> X Layer receipt
```

The gate protects **only** the routes in its own map (`POST /api/edge`) — the free
routes pass through untouched. `paymentMiddleware` runs **before** business logic,
so an unpaid call never reaches the verdict engine.

### Facilitator selection (`buildFacilitatorClient`)

- **Real** `OKXFacilitatorClient` when `OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE`
  are set — signature verification + on-chain settlement as a service.
- **`LocalFacilitatorClient`** otherwise — genuine offline EIP-712 recovery (`viem`),
  settlement recorded as a clearly-labeled *local-pending* receipt. **Never fabricates
  an on-chain receipt.** `HAS_REAL_OKX_CREDS` is logged on boot.

## Demo mode

`createApp({ demo: true })` — or `npm run api -- --demo` — skips the x402 gate so the
`web/` proof page renders the verdict end-to-end without a signed payment. Production
settlement requires the OKX credentials above (see [`../DEMO.md`](../DEMO.md)).

## Testing

Handlers, the rail, and both facilitator branches are covered by Vitest (real EIP-712
signing, a purpose-seeded in-memory DB, and a mocked fetch for the credentialed path).
`getDb()`/`resetDbForTests()` keep the ledger handle test-controllable. Run `npm run ci`
from the repo root.
