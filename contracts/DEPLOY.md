# Deploying LedgerAnchor on X Layer

`LedgerAnchor.sol` is a ~40-line write-once daily Merkle checkpoint. It anchors
the ledger's tamper-evidence on **X Layer (eip155:196)** — the same chain the
`$0.05` x402 charge settles on — so the on-chain root and the payment receipts
share one explorer.

## ⚠️ CREDENTIAL / FUNDS-GATED (not deployed in this build session)
Deploying + posting a root needs **OKB gas** on the deployer/owner wallet on
X Layer. Nothing below is faked, and **no contract address is claimed** until it
is really deployed — `/api/ledger`'s `anchor.contract` / `explorer_url` stay
`null` until then (see the README "Limitations" section). This is the same
credential/funds-gated, user-only step as the real paid-call receipt
(`scripts/paid-call-smoke.ts`).

## Networks
- Mainnet `eip155:196` · chainId `196` · RPC `https://rpc.xlayer.tech` · explorer `https://www.oklink.com/xlayer`
- Rehearsal/testnet `eip155:1952` · chainId `1952` · RPC `https://testrpc.xlayer.tech` · explorer `https://www.oklink.com/xlayer-test`

(These are the same constants pinned in `config.ts` → `NETWORKS`.)

## Deploy (Foundry example)
```bash
forge create contracts/LedgerAnchor.sol:LedgerAnchor \
  --rpc-url https://rpc.xlayer.tech \
  --private-key $OWNER_WALLET_PK
# then verify the source on OKLink (X Layer explorer) via its
# contract-verification API — flags are explorer/toolchain-dependent, so
# follow OKLink's current X Layer verification docs at verify time.
```

## Post a daily root
1. `npm run settle` → `npm run anchor` (writes `fixtures/anchors.json` with each
   day's `day_number`, `merkleRoot`, `count`).
2. For a day: `postAnchor(day_number, merkleRoot, count)` from the owner wallet.
3. Record the tx so the audit can diff DB vs chain:
   ```
   npx tsx scripts/anchor.ts --onchain <YYYY-MM-DD> <0x-anchor-tx>
   ```
4. `npm run audit -- --all` now shows `MATCHES chain ✓` for that day instead of
   `not anchored on-chain`.

## Why write-once
An anchor cannot be overwritten (`AlreadyAnchored`). If a settled ledger row is
edited after its day was anchored, the recomputed root will not match the posted
root — the tamper is provable to anyone holding the `AnchorPosted` event.
