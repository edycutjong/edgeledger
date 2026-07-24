# `web/` — EdgeLedger proof surface

> A single dependency-free HTML page (`index.html`, no build step, no framework) that
> drives the same live routes as `curl` — so a judge sees the **402 → pay → verdict**
> flow and the loss-inclusive ledger as a product, not as terminal output. Served by
> the Express API at `GET /`.

**[↩ Root README](../README.md)** · **[🛰️ API](../api/README.md)**

## 📦 What's here

| File | Responsibility |
|---|---|
| [`index.html`](index.html) | The whole surface. Inline design tokens (Bloomberg-SOC dark, hot-pink `REJECTED` / gold receipts) + inline vanilla JS. Left column: a *Validate a bet* form (fixture, selection, odds, bankroll) that `POST`s to `/api/edge` and renders the VerdictCard (`APPROVED` / `REJECTED` / `SKIP` + edge grade, conviction-ladder stake, `pick_hash`). Right column: the public `POST /api/ledger` — every settled call, **losses included**. Also renders the raw **HTTP 402** paywall card when the gate is live. |

## 🚀 Run it

The page is static and is served by the API — there is no separate `web:*` script or bundler.

```bash
# from the repo root — demo mode skips the x402 gate so the verdict renders without a wallet
npm run api -- --demo
# open http://localhost:3000/   (index.html is served via express.static of ../web)
```

Run the API **without** `--demo` and the same page shows the real OKX x402 challenge
instead of a verdict — the paywall card decodes the `PAYMENT-REQUIRED` header live. See
[`../DEMO.md`](../DEMO.md) for the full walkthrough. Opening `index.html` directly (no API)
degrades gracefully: the status pill shows `API offline` and the panels prompt you to start it.

## ⚙️ Environment

None. The page reads no config and ships no keys — it targets `location.origin`, so it
talks to whichever host serves it. All payment/credential logic lives server-side in
[`../api/`](../api).

## 🧪 Notes

- On load it auto-fires the headline `REJECTED` verdict, polls `GET /health` for the live
  status pill (rows · price · pay rail), and loads the ledger.
- Demonstrates the core pitch end-to-end: **pay 5¢ → get a verdict, not a prediction**, with
  a tamper-evident `pick_hash` and a public record a predict-only competitor can't fabricate.
- **Honest state (matches the page footer):** the ledger's placeholder rows carry
  `is_placeholder=true` and are **excluded from ROI totals**; receipts read `board:*`, not
  `xlayer:*`, until a real paid call settles on-chain. The verdict engine, edge math, grade
  bands, and pick-hash behind it are real and test-covered.
