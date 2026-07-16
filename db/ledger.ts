/**
 * Ledger repository (better-sqlite3). Pure data access — no HTTP, no chain.
 */
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { SCHEMA_SQL } from './schema';
import type { LedgerRow } from '../engine/types';
import { PRICE_USD_DISPLAY } from '../config';

export type DB = Database.Database;

/** Open (creating if needed) the ledger DB and apply the schema idempotently. */
export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA_SQL);
  return db;
}

/** Open an in-memory DB (tests). */
export function openMemoryDb(): DB {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return db;
}

const COLUMNS = [
  'id', 'fixture', 'competition', 'stage', 'kickoff_utc', 'side', 'side_label',
  'model_prob', 'entry_odds', 'closing_odds', 'market_implied_prob', 'edge_pct', 'ev_pct',
  'stake_tier', 'stake_name', 'stake_units', 'result', 'clv_pct', 'clv_prob_points',
  'pick_hash', 'receipt_tx', 'receipt_block_time', 'sold_count', 'revenue_usdc',
  'settled_at', 'is_placeholder', 'raw_json', 'verdict',
] as const;

type DbRowInput = Omit<LedgerRow, 'is_placeholder'> & { stage?: string; ev_pct?: number; is_placeholder: boolean };

/** Insert or replace a ledger row (idempotent upsert on primary key `id`). */
export function upsertRow(db: DB, row: DbRowInput): void {
  const placeholders = COLUMNS.map((c) => `@${c}`).join(', ');
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO picks (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
  );
  stmt.run({
    stage: null,
    ev_pct: 0,
    ...row,
    is_placeholder: row.is_placeholder ? 1 : 0,
  });
}

/** Bulk upsert in a single transaction. */
export function upsertMany(db: DB, rows: DbRowInput[]): void {
  const tx = db.transaction((rs: DbRowInput[]) => {
    for (const r of rs) upsertRow(db, r);
  });
  tx(rows);
}

function hydrate(r: any): LedgerRow {
  return { ...r, is_placeholder: !!r.is_placeholder } as LedgerRow;
}

/** All rows, newest kickoff first. */
export function allRows(db: DB): LedgerRow[] {
  return db.prepare('SELECT * FROM picks ORDER BY kickoff_utc DESC').all().map(hydrate);
}

/** Only settled rows (win/loss/void). */
export function settledRows(db: DB): LedgerRow[] {
  return db
    .prepare("SELECT * FROM picks WHERE result IN ('win','loss','void') ORDER BY kickoff_utc DESC")
    .all()
    .map(hydrate);
}

export function rowByReceipt(db: DB, tx: string): LedgerRow | undefined {
  const r = db.prepare('SELECT * FROM picks WHERE receipt_tx = ?').get(tx);
  return r ? hydrate(r) : undefined;
}

export function rowByHash(db: DB, hash: string): LedgerRow | undefined {
  const r = db.prepare('SELECT * FROM picks WHERE pick_hash = ?').get(hash);
  return r ? hydrate(r) : undefined;
}

export function rowCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM picks').get() as { n: number }).n;
}

/** Distinct receipt count (I3: must equal settled row count). */
export function receiptCount(db: DB): number {
  return (db.prepare('SELECT COUNT(DISTINCT receipt_tx) AS n FROM picks').get() as { n: number }).n;
}

export interface LedgerStats {
  wins: number;
  losses: number;
  voids: number;
  settled: number;
  win_rate: number;
  total_staked_units: number;
  total_profit_units: number;
  roi_pct: number;
  avg_clv_pct: number;
  beat_close_rate: number;
  total_sold: number;
  total_revenue_usdc: number;
  banker_count: number;
  value_count: number;
  probe_count: number;
}

/** Profit on a single settled row, in units. */
export function rowProfitUnits(row: Pick<LedgerRow, 'result' | 'stake_units' | 'entry_odds'>): number {
  if (row.result === 'win') return row.stake_units * (row.entry_odds - 1);
  if (row.result === 'loss') return -row.stake_units;
  return 0; // void / pending
}

export function computeStats(db: DB): LedgerStats {
  const rows = settledRows(db);
  let wins = 0, losses = 0, voids = 0, staked = 0, profit = 0, clvSum = 0, beat = 0;
  let banker = 0, value = 0, probe = 0, sold = 0, revenue = 0;
  for (const r of rows) {
    if (r.result === 'win') wins++;
    else if (r.result === 'loss') losses++;
    else voids++;
    staked += r.stake_units;
    profit += rowProfitUnits(r);
    clvSum += r.clv_pct;
    if (r.clv_pct > 0) beat++;
    if (r.stake_tier === 3) banker++;
    else if (r.stake_tier === 2) value++;
    else if (r.stake_tier === 1) probe++;
    sold += r.sold_count;
    revenue += r.revenue_usdc;
  }
  const settled = rows.length;
  return {
    wins, losses, voids, settled,
    win_rate: settled ? wins / (wins + losses || 1) : 0,
    total_staked_units: round2(staked),
    total_profit_units: round2(profit),
    roi_pct: staked ? profit / staked : 0,
    avg_clv_pct: settled ? clvSum / settled : 0,
    beat_close_rate: settled ? beat / settled : 0,
    total_sold: sold,
    total_revenue_usdc: round2(revenue),
    banker_count: banker, value_count: value, probe_count: probe,
  };
}

function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

export const PRICE = PRICE_USD_DISPLAY;
