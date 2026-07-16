/**
 * SQLite schema for the EdgeLedger public ledger.
 *
 * One table, `picks`, is the ledger. Every PAID pick becomes exactly one row
 * (invariant I3 — losses included), keyed by its receipt tx. Idempotent:
 * settle.ts rebuilds the same rows on every run.
 *
 * `buyer_calls` is NEW for the OKX edition — BuyerLens (ARCHITECTURE §BuyerLens
 * wiring, COMPLEXITY §1.2): one row per PAID /api/edge call, keyed by the
 * EIP-3009-recovered `authorization.from` address. Written only after payment
 * verification succeeds; never from a user-supplied address.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS picks (
  id                  TEXT PRIMARY KEY,
  fixture             TEXT    NOT NULL,
  competition         TEXT    NOT NULL,
  stage               TEXT,
  kickoff_utc         TEXT    NOT NULL,
  side                TEXT    NOT NULL,
  side_label          TEXT    NOT NULL,
  model_prob          REAL    NOT NULL,
  entry_odds          REAL    NOT NULL,
  closing_odds        REAL    NOT NULL,
  market_implied_prob REAL    NOT NULL,
  edge_pct            REAL    NOT NULL,
  ev_pct              REAL    NOT NULL,
  stake_tier          INTEGER NOT NULL,
  stake_name          TEXT    NOT NULL,
  stake_units         REAL    NOT NULL,
  result              TEXT    NOT NULL,   -- win | loss | void | pending
  clv_pct             REAL    NOT NULL,   -- relative headline CLV (entry/closing - 1)
  clv_prob_points     REAL    NOT NULL,   -- implied(closing) - implied(entry)
  pick_hash           TEXT    NOT NULL,   -- sha256(canonical pick JSON) — I2
  receipt_tx          TEXT    NOT NULL,   -- payment tx/ref (or synthetic placeholder)
  receipt_block_time  TEXT    NOT NULL,   -- must be < kickoff_utc — I1
  sold_count          INTEGER NOT NULL DEFAULT 0,
  revenue_usdc        REAL    NOT NULL DEFAULT 0,
  settled_at          TEXT    NOT NULL,
  is_placeholder      INTEGER NOT NULL DEFAULT 1,  -- 1 = seed row, no real on-chain receipt
  raw_json            TEXT    NOT NULL,  -- exact served CanonicalPick JSON (re-hashable)
  verdict             TEXT    NOT NULL DEFAULT 'APPROVED'  -- APPROVED | REJECTED | SKIP (ARCHITECTURE data model)
);

CREATE INDEX IF NOT EXISTS idx_picks_receipt ON picks(receipt_tx);
CREATE INDEX IF NOT EXISTS idx_picks_kickoff ON picks(kickoff_utc);
CREATE INDEX IF NOT EXISTS idx_picks_hash    ON picks(pick_hash);

CREATE TABLE IF NOT EXISTS buyer_calls (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  buyer_from      TEXT    NOT NULL,  -- EIP-3009 authorization.from, ECDSA-recovered
  pick_hash       TEXT    NOT NULL,
  fixture         TEXT    NOT NULL,
  verdict         TEXT    NOT NULL,
  grade           TEXT    NOT NULL,
  proposed_stake_pct REAL,           -- what the buyer's bankroll input implied, if any
  ladder_stake_pct   REAL NOT NULL,  -- what the ladder actually recommended
  at              TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_buyer_calls_from ON buyer_calls(buyer_from);
`;
