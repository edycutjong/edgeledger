---
name: worldcup-edgeledger
description: >
  Buy and audit World Cup bet-verdicts from EdgeLedger over OKX x402 on X Layer.
  Use when the user wants a pre-bet verdict (APPROVED / REJECTED / SKIP with an
  edge grade A+…F + a conviction staking ladder), wants to pay per-call in USD₮0
  (or USDG) with no API key, or wants to audit the seller's settled record by
  closing-line value (CLV). Handles: reading the free 402 quote, signing the
  EIP-3009 payment for the $0.05 x402 charge, validating the returned pick hash,
  and reading the free public ledger (losses included) before trusting a call.
license: MIT
---

# worldcup-edgeledger

Teach any harness (Claude Code / Cursor / Codex) to be a **buyer** on EdgeLedger:
a pay-per-call World Cup bet-**validation** API on **X Layer** (OKX x402) where the
x402 payment receipt IS the call's pre-kickoff timestamp, plus a **free** public
ledger that CLV-scores every settled call (losses included). The agent answers
*"should I bet"*, not *"who wins"* — REJECTED/SKIP is a first-class answer.

Install:

```
npx skills add https://github.com/edycutjong/edgeledger --skill worldcup-edgeledger
```

Config: set `EDGELEDGER_API_URL` (default `http://localhost:8403`; production
`https://api.edgeledger.edycu.dev`). To actually settle a paid call you also need
`OKX_API_KEY` / `OKX_SECRET_KEY` / `OKX_PASSPHRASE` (OKX Developer Portal —
web3.okx.com/onchainos/dev-portal) **and** `BUYER_WALLET_PK`, a funded X Layer key
holding USD₮0. Without those the API's local-faithful facilitator verifies the
signature but honestly refuses to settle on-chain (`no_live_facilitator`) — it
never fabricates a receipt.

## When to use
- "Should I make this World Cup bet?" → POST the proposed bet, get a verdict + grade + stake.
- "Is this tipster/seller real? Check their CLV." → read the free ledger, no payment.
- "Pay for the verdict and prove the receipt predates kickoff."

## The flow (4 steps)

### 1. Read the free 402 quote (no payment)
```
POST {EDGELEDGER_API_URL}/api/edge      # no X-PAYMENT header → HTTP 402 + quote
```
The 402 carries the quote in the base64 `PAYMENT-REQUIRED` header — an x402 v2
`PaymentRequired` with **dual accepts** (both zero-gas on X Layer):
`accepts = [{ scheme:"exact", network:"eip155:196", asset:<USD₮0>, amount:"50000", payTo, extra:{assetTransferMethod:"eip3009", name:"USD₮0"} }, { … name:"USDG" }]`.
(The rehearsal/testnet default is `eip155:1952`; set `X402_NETWORK=eip155:196` for
mainnet.) `50000` = $0.05 at 6 decimals. Decode with `base64 -d` on the header.

### 2. Pay the x402 quote (sign EIP-3009 — never hand-roll the settlement)
Sign an EIP-3009 `TransferWithAuthorization` for $0.05 USD₮0 to `payTo`, base64 it
into an `X-PAYMENT` header, and POST `/api/edge`. The repo's
`scripts/paid-call-smoke.ts` (`npm run paid-smoke`) implements exactly this and is
the reference path:

```ts
import { authorizationTypes } from '@okxweb3/x402-evm';
import { privateKeyToAccount } from 'viem/accounts';
// sign TransferWithAuthorization{from,to:payTo,value:"50000",validAfter,validBefore,nonce}
// domain { name:"USD₮0", version:"1", chainId:196, verifyingContract:<USD₮0> }
const xPayment = Buffer.from(JSON.stringify({
  x402Version: 2,
  accepted: { scheme:'exact', network:'eip155:196', asset:USDT0, amount:'50000', payTo },
  payload: { signature, authorization },
})).toString('base64');
const res = await fetch(`${API}/api/edge`, {
  method:'POST', headers:{ 'Content-Type':'application/json', 'X-PAYMENT': xPayment },
  body: JSON.stringify({ fixture:'SF: FRA vs ESP', selection:'France to advance', odds:2.05, bankroll:500 }),
});
```
On a real settlement the `PAYMENT-RESPONSE` response header is base64 JSON
`{ success, transaction, network, payer }`; `transaction`'s block time is your
pre-kickoff proof (verify on OKLink X Layer: `https://www.oklink.com/xlayer/tx/<tx>`).
Run `npm run paid-smoke` — it exits non-zero (never a fake receipt) until OKX
credentials **and** a funded wallet are present.

### 3. Validate the pick hash (tamper check — I2)
The 200 body includes `pick_hash`. Re-hash the served pick JSON with
`sha256(canonical JSON)` (keys sorted recursively — see `engine/hash.ts`,
`verifyPickHash`) and confirm it equals `pick_hash`. If it differs, the response
was tampered — reject it.

### 4. Read the ledger + compute trailing CLV (free — decide before you trust)
```
POST {EDGELEDGER_API_URL}/api/ledger    # free, CORS-open, losses included
POST {EDGELEDGER_API_URL}/api/slate     # free, today's BET/SKIP verdicts (no numbers)
```
Each settled row carries `grade`, `result`, `pnl`, `clv_pct`, `pick_hash`,
`receipt`, `is_placeholder`. `totals` = `{ n, roi_pct }` over **real** (non-placeholder)
rows only. Trust signal = positive CLV across the settled sample, NOT the raw
win/loss record. Re-verify any single receipt independently:
```
POST {EDGELEDGER_API_URL}/api/receipts/verify   # body { txHash } or { pick_hash }
```
It re-checks live via the OKX Facilitator when real credentials are configured;
for a seed/placeholder row it honestly returns `placeholder_no_onchain_receipt`.

## Guardrails
- Never trust a pick whose `pick_hash` does not re-verify (step 3).
- Never treat a row with `is_placeholder: true` as an on-chain receipt — those are
  labeled seed rows (`receipt` reads `board:*`, not `xlayer:*`) and are excluded
  from `totals`.
- An empty `similar_settled` (`n:0`) is honest, not a bug: the grade bucket has no
  settled history yet (e.g. the seller never placed a negative-edge grade-F bet).
- $0.05 per call — cheap to poll, but the ledger is the free audit surface; use it
  before paying.

## OKX surfaces used
`@okxweb3/x402-express` `paymentMiddleware` (server gate) · `OKXFacilitatorClient`
(verify + settle) · `ExactEvmScheme` on `eip155:196` with dual USD₮0/USDG accepts
(both zero-gas) · the `X-PAYMENT` EIP-3009 `authorization.from` as an unforgeable,
no-login buyer identity (BuyerLens) · this **Agent Skill** itself is the
distribution channel.
