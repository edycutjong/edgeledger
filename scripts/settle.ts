/**
 * settle.ts — idempotent settler.
 *
 * Reads fixtures/picks.csv → for each pick builds the canonical pick (edge +
 * ladder + hash), freezes the closing line, computes CLV, records the stake
 * rung and result → writes the ledger to SQLite AND emits
 * fixtures/ledger-state.json. Re-running produces byte-identical state (the
 * pick_hash and synthetic receipt tx are pure functions of the input).
 *
 * Usage:
 *   npm run settle            # rebuild db + ledger-state.json
 *   npm run settle -- --check # rebuild in memory, print stats, don't write
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPick, clvPct, clvProbPoints, sha256Hex } from '../engine/index';
import { unitsForTier, nameForTier } from '../engine/ladder';
import { verdictFor } from '../engine/verdict';
import type { LedgerRow, Result, Side } from '../engine/types';
import { openDb, upsertMany, computeStats } from '../db/ledger';
import { PATHS, PRICE_USD_DISPLAY, FOOTBALL_DATA } from '../config';

interface CsvPick {
  id: string;
  stage: string;
  fixture: string;
  side: Side;
  side_label: string;
  model_prob: number;
  entry_odds: number;
  closing_odds: number;
  result: Result;
  kickoff_utc: string;
  receipt_offset_hours: number;
  sold_count: number;
}

const HEADER = [
  'id', 'stage', 'fixture', 'side', 'side_label', 'model_prob', 'entry_odds',
  'closing_odds', 'result', 'kickoff_utc', 'receipt_offset_hours', 'sold_count',
];

/** Parse the seed CSV (skips `#` comments and blank lines). */
export function parsePicksCsv(text: string): CsvPick[] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('#'));
  if (lines.length === 0) return [];
  // First non-comment line is the header; validate it.
  const header = lines[0].split(',').map((s) => s.trim());
  const rows = header[0] === 'id' ? lines.slice(1) : lines;
  return rows.map((line) => {
    const c = line.split(',').map((s) => s.trim());
    const get = (name: string) => c[HEADER.indexOf(name)];
    return {
      id: get('id'),
      stage: get('stage'),
      fixture: get('fixture'),
      side: get('side') as Side,
      side_label: get('side_label'),
      model_prob: Number(get('model_prob')),
      entry_odds: Number(get('entry_odds')),
      closing_odds: Number(get('closing_odds')),
      result: get('result') as Result,
      kickoff_utc: get('kickoff_utc'),
      receipt_offset_hours: Number(get('receipt_offset_hours')),
      sold_count: Number(get('sold_count')),
    };
  });
}

/**
 * Deterministic synthetic receipt tx for a SEED row. Clearly not a real
 * on-chain hash — is_placeholder=true accompanies it everywhere it is served.
 */
export function placeholderReceiptTx(id: string, pickHash: string): string {
  return '0x' + sha256Hex(`edgeledger-seed:${id}:${pickHash}`);
}

/** Build a full settled ledger row from one CSV pick (pure). */
export function toLedgerRow(p: CsvPick): LedgerRow {
  const kickoff = new Date(p.kickoff_utc);
  const receiptTime = new Date(kickoff.getTime() - p.receipt_offset_hours * 3600_000);

  // Build the canonical pick at the ENTRY line (what was sold pre-kickoff).
  const { pick, pick_hash } = buildPick({
    fixture: p.fixture,
    competition: 'FIFA World Cup 2026',
    kickoff_utc: p.kickoff_utc,
    side: p.side,
    side_label: p.side_label,
    model_prob: p.model_prob,
    market_odds: p.entry_odds,
    issued_at: receiptTime.toISOString(),
  });

  const tier = pick.recommended_tier;
  const clv_pct = round4(clvPct(p.entry_odds, p.closing_odds));
  const clv_prob_points = round4(clvProbPoints(p.entry_odds, p.closing_odds));
  const revenue = round2(p.sold_count * PRICE_USD_DISPLAY);

  return {
    id: p.id,
    fixture: p.fixture,
    competition: 'FIFA World Cup 2026',
    kickoff_utc: p.kickoff_utc,
    side: p.side,
    side_label: p.side_label,
    entry_odds: p.entry_odds,
    closing_odds: p.closing_odds,
    model_prob: pick.model_prob,
    market_implied_prob: pick.market_implied_prob,
    edge_pct: pick.edge_pct,
    stake_tier: tier,
    stake_name: nameForTier(tier),
    stake_units: unitsForTier(tier),
    result: p.result,
    clv_pct,
    clv_prob_points,
    pick_hash,
    receipt_tx: placeholderReceiptTx(p.id, pick_hash),
    receipt_block_time: receiptTime.toISOString(),
    sold_count: p.sold_count,
    revenue_usdc: revenue,
    settled_at: kickoff.toISOString(),
    is_placeholder: true,
    raw_json: JSON.stringify(pick),
    verdict: verdictFor(pick.edge_pct),
  };
}

export function buildLedgerFromCsv(csvText: string): LedgerRow[] {
  return parsePicksCsv(csvText).map(toLedgerRow);
}

function round4(x: number): number {
  return Math.round(x * 1e4) / 1e4;
}
function round2(x: number): number {
  return Math.round(x * 100) / 100;
}

// ── I1 guard: every seeded receipt must predate its kickoff ──────────────────
export function assertPreKickoff(rows: LedgerRow[]): void {
  for (const r of rows) {
    if (new Date(r.receipt_block_time).getTime() >= new Date(r.kickoff_utc).getTime()) {
      throw new Error(`I1 violation: ${r.id} receipt_block_time >= kickoff_utc`);
    }
  }
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const csv = fs.readFileSync(PATHS.picksCsv, 'utf8');
  const rows = buildLedgerFromCsv(csv);
  assertPreKickoff(rows);

  const db = openDb(check ? ':memory:' : PATHS.db);
  upsertMany(db, rows.map((r) => ({ ...r, stage: undefined, ev_pct: 0 })) as any);
  const stats = computeStats(db);

  const state = {
    generated_at: new Date().toISOString(),
    price_usd: PRICE_USD_DISPLAY,
    attribution: FOOTBALL_DATA.attribution,
    disclaimer:
      'Seed rows are PLACEHOLDER data (is_placeholder=true) with synthetic receipt hashes. See DEMO.md.',
    stats,
    rows,
  };

  if (!check) {
    fs.writeFileSync(PATHS.ledgerState, JSON.stringify(state, null, 2));
  }

  console.log(`settle: ${rows.length} rows | record ${stats.wins}-${stats.losses}` +
    `${stats.voids ? '-' + stats.voids : ''} | ROI ${(stats.roi_pct * 100).toFixed(1)}%` +
    ` | avg CLV ${(stats.avg_clv_pct * 100).toFixed(2)}% | beat-close ${(stats.beat_close_rate * 100).toFixed(0)}%`);
  console.log(`  tiers: ${stats.banker_count} banker / ${stats.value_count} value / ${stats.probe_count} probe` +
    ` | sold ${stats.total_sold} calls = $${stats.total_revenue_usdc} revenue`);
  if (check) console.log('  (--check: in-memory only, nothing written)');
  else console.log(`  wrote ${PATHS.ledgerState} + ${PATHS.db}`);
  db.close();
}

// Run only when invoked directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
