# Contributing

Thanks for your interest in improving EdgeLedger (OKX.AI edition)! 🎉

## Getting Started
1. Fork the repo and branch from `main`: `git checkout -b feat/your-feature`
2. Install dependencies: `npm install`
3. Copy the env template: `cp .env.example .env.local`
4. Run the API: `npm run api` (or `npm run api -- --demo` to bypass the x402
   paygate and exercise the response shape without a live OKX facilitator)

## Before You Open a PR
- `npm run ci` passes (typecheck + tests with coverage).
- `npm run typecheck` — zero TypeScript errors.
- `npm test` — all 188 vitest tests green.
- Add or update tests for any behavior change (`test/*.test.ts`).
- Never fabricate settlement or receipts — see `api/rails/localFacilitator.ts`
  and `scripts/paid-call-smoke.ts` for the project's honesty invariants around
  on-chain proof. New code should follow the same pattern: refuse rather than
  fake when a credential or live dependency is missing.
- Keep commits conventional (`feat:`, `fix:`, `docs:`, `chore:`).

## Reporting Bugs / Requesting Features
Open an issue using the provided templates. Include repro steps, expected vs.
actual behavior, and environment details (Node version, `PAY_RAIL`, whether
real OKX Developer Portal credentials were configured).
