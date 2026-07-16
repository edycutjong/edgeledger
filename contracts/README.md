# `contracts/` — LedgerAnchor

On-chain tamper-evidence for EdgeLedger's settled ledger. A single small contract,
[`LedgerAnchor.sol`](LedgerAnchor.sol), that holds a **daily Merkle checkpoint** of the
day's `pick_hash`es on **X Layer** (`eip155:196`).

## Why it exists

Two different proofs, two different mechanisms:

- **When a pick existed** is proven by the **x402 payment receipt** — the settlement
  block time precedes kickoff. (No contract needed; that's the payment rail.)
- **That the ledger database was never rewritten after the fact** is what this contract
  proves. A nightly job Merkle-izes the day's pick hashes and posts the root here,
  **write-once per day**. `edgeledger-audit --all` recomputes each day's root from the
  *served* ledger and diffs it against the on-chain `AnchorPosted` event — any post-hoc
  edit to a settled row changes the root and is detectable by anyone.

The tree is `sha256` over the hex pick hashes (see [`engine/merkle.ts`](../engine/merkle.ts)).
**Proof verification is off-chain** against the posted root; the chain only holds the
immutable commitment, so gas stays minimal (one small write per day).

## Interface

| Member | Kind | Purpose |
|---|---|---|
| `postAnchor(day, merkleRoot, count)` | `external onlyOwner` | Commit a day's root. Reverts on zero root (`ZeroRoot`) or a re-post (`AlreadyAnchored`) — write-once. |
| `getAnchor(day) → (merkleRoot, count, timestamp)` | `view` | Read a day's anchor. |
| `isAnchored(day) → bool` | `view` | Whether a day has been committed. |
| `anchors(day)` / `latestDay` / `owner` | `public` | Auto-getters for the stored state. |
| `transferOwnership(newOwner)` | `external onlyOwner` | Hand off the poster key. |
| `event AnchorPosted(day, merkleRoot, count)` | — | Emitted on each commit; the audit trail `edgeledger-audit --all` diffs against. |

`day` = whole days since the Unix epoch. Solidity `^0.8.24`, MIT.

## Build · test · deploy

```bash
npm run anchor      # compute today's Merkle root off-chain (engine/merkle.ts)
# Hardhat compile/test + deploy steps and the X Layer network config:
```

See **[`DEPLOY.md`](DEPLOY.md)** for the full deploy runbook (Hardhat config, X Layer RPC,
`postAnchor` wiring, and how `/api/ledger` reads back `anchor.contract` / `explorer_url`).

## Status

**Not deployed yet.** Daily Merkle roots are computed off-chain today; `/api/ledger`'s
`anchor.contract` and `anchor.explorer_url` are `null` until the contract is deployed
(a credential- and funds-gated, user-only step). The contract compiles and is tested;
deployment is intentionally deferred — see the "Limitations" section of the
[root README](../README.md).
