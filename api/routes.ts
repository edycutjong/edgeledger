/**
 * Free (non-gated) endpoints + the gated /api/edge handler body.
 *
 *   POST /api/edge             (gated by the okx x402 rail) — verdict + grade + ladder stake
 *   POST /api/slate            (free) — BET/SKIP only, no numbers
 *   POST /api/ledger           (free) — settled history, losses included, + anchor
 *   POST /api/me               (free) — BuyerLens read + forget
 *   POST /api/receipts/verify  (free) — independent re-check via the facilitator
 *   GET  /api/edge             → 405 (registered in server.ts)
 *   GET  /health
 */
import type { Request, Response } from 'express';
import fs from 'node:fs';
import { buildVerdict, verdictHash, gradeFor, buildGradeStats, buildMirror, type Grade } from '../engine/verdict';
import { buildMerkleTree } from '../engine/merkle';
import { openDb, allRows, settledRows, rowByHash, rowByReceipt, rowCount, upsertRow } from '../db/ledger';
import { appendBuyerCall, buyerSummary, buyerHistory, forgetBuyer } from '../db/buyers';
import type { DB } from '../db/ledger';
import type { LedgerRow } from '../engine/types';
import { findKnownPick, findKnownPicksForFixture, loadKnownPicks, type KnownPick } from '../data/knownPicks';
import { PATHS, PRICE_USD_DISPLAY, HAS_REAL_OKX_CREDS } from '../config';
import { buildFacilitatorClient } from './rails/okx';

// ── DB singleton, hydrated from the seeded ledger-state.json ────────────────
let _db: DB | null = null;
export function getDb(): DB {
  if (_db) return _db;
  _db = openDb(PATHS.db);
  if (rowCount(_db) === 0 && fs.existsSync(PATHS.ledgerState)) {
    const state = JSON.parse(fs.readFileSync(PATHS.ledgerState, 'utf8'));
    for (const r of state.rows as LedgerRow[]) upsertRow(_db, r as any);
  }
  return _db;
}

/** Reset the in-process DB handle (tests only — lets each test suite reseed cleanly). */
export function resetDbForTests(db: DB | null = null): void {
  _db = db;
}

// ── X-PAYMENT decode (BuyerLens — ARCHITECTURE §BuyerLens wiring) ───────────
export interface DecodedXPayment {
  from: string;
  to: string;
  value: string;
}

/**
 * Decode (not re-verify — the payGate already verified it before calling
 * next()) the base64 `X-PAYMENT` request header and pull out
 * `authorization.from`. Returns null if the header is absent or malformed —
 * BuyerLens writes are gated on this returning non-null (ARCHITECTURE §6:
 * "buyer rows are written exclusively from post-verification X-PAYMENT
 * decodes — never from user-supplied addresses").
 */
export function decodeXPayment(req: Request): DecodedXPayment | null {
  const header = req.header('x-payment');
  if (!header) return null;
  try {
    const json = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    const auth = json?.payload?.authorization ?? json?.authorization;
    if (!auth?.from || !auth?.to || !auth?.value) return null;
    return { from: String(auth.from), to: String(auth.to), value: String(auth.value) };
  } catch {
    return null;
  }
}

function ledgerRowsAsGradeStats(rows: LedgerRow[]): { grade: Grade; result: LedgerRow['result']; stake_pct: number; entry_odds: number }[] {
  return rows.map((r) => ({
    grade: gradeFor(r.edge_pct),
    result: r.result,
    stake_pct: r.stake_units, // seed ledger units on a 100-unit bankroll == pct
    entry_odds: r.entry_odds,
  }));
}

function ledgerRowsAsMirror(rows: LedgerRow[]) {
  return rows.map((r) => ({
    fixture: r.fixture,
    stake_pct: r.stake_units,
    result: r.result,
    pnl_pct: r.result === 'win' ? Math.round(r.stake_units * (r.entry_odds - 1) * 100) / 100
      : r.result === 'loss' ? -r.stake_units
      : null,
    receipt: r.is_placeholder ? `board:${r.id}` : `xlayer:${r.receipt_tx}`,
  }));
}

// ── POST /api/edge (paid) ────────────────────────────────────────────────────
export function edgeHandler(req: Request, res: Response): void {
  const db = getDb();
  const body = (req.body ?? {}) as { fixture?: string; selection?: string; odds?: number; bankroll?: number; proposed_stake_pct?: number };
  const fixture = (body.fixture ?? '').trim();

  if (!fixture) {
    res.status(400).json({ error: 'fixture_required', note: 'body must include at least {fixture}' });
    return;
  }

  const mode: 'validate' | 'slate' = body.selection && typeof body.odds === 'number' ? 'validate' : 'slate';

  let known: KnownPick | undefined;
  let odds: number | undefined;
  let selectionLabel: string;

  if (mode === 'validate') {
    known = findKnownPick(fixture, body.selection);
    odds = body.odds;
    selectionLabel = body.selection!;
  } else {
    // slate mode: pick the best-value known selection on this fixture.
    const candidates = findKnownPicksForFixture(fixture);
    known = candidates
      .map((p) => ({ p, edge: p.model_prob - 1 / p.reference_odds }))
      .sort((a, b) => b.edge - a.edge)[0]?.p;
    odds = known?.reference_odds;
    selectionLabel = known?.side_label ?? '(no known selection)';
  }

  const nowIso = new Date().toISOString();

  if (!known || typeof odds !== 'number' || !(odds > 1)) {
    const skipHash = verdictHash({ fixture, selectionLabel, note: 'no_model_coverage', at: nowIso } as any);
    res.json({
      mode,
      fixture,
      selection: selectionLabel,
      verdict: 'SKIP',
      reason: 'no_model_coverage',
      note: 'EdgeLedger has no fair-probability model for this fixture/selection yet — refusing to serve a fabricated edge (see PRODUCTION_PLAN honesty gates).',
      stake: { pct: 0, amount: body.bankroll ? 0 : null, rung: 'pass' },
      decay_min_halflife: null,
      mirror: { our_stake: 0, receipt: null, note: 'we are flat this market' },
      similar_settled: { n: 0, win_rate: 0, roi_pct: 0 },
      pick_hash: skipHash,
      sources: { odds: 'none', snapshot_at: nowIso },
    });
    return;
  }

  const verdict = buildVerdict({
    fixture,
    selection: selectionLabel,
    odds,
    fair_prob: known.model_prob,
    bankroll: body.bankroll,
  });
  const pick_hash = verdictHash(verdict);

  const settled = settledRows(db);
  const similar_settled = buildGradeStats(verdict.edge_grade, ledgerRowsAsGradeStats(settled));
  const mirror = buildMirror(fixture, ledgerRowsAsMirror(settled));

  // BuyerLens: write ONLY from a verified (middleware-attached) X-PAYMENT decode.
  const payer = decodeXPayment(req);
  let you: ReturnType<typeof buyerSummary> | null = null;
  if (payer) {
    appendBuyerCall(db, {
      buyer_from: payer.from,
      pick_hash,
      fixture,
      verdict: verdict.verdict,
      grade: verdict.edge_grade,
      proposed_stake_pct: typeof body.proposed_stake_pct === 'number' ? body.proposed_stake_pct : null,
      ladder_stake_pct: verdict.stake.pct,
      at: nowIso,
    });
    you = buyerSummary(db, payer.from);
  }

  res.json({
    ...verdict,
    mode, // override verdict's internal default ('validate') with the actual request mode
    mirror,
    similar_settled,
    you,
    pick_hash,
    sources: { odds: 'known-picks.json (heuristic model coverage — see DEMO.md)', snapshot_at: nowIso },
  });
}

// ── POST /api/slate (free) ───────────────────────────────────────────────────
export function slateHandler(req: Request, res: Response): void {
  const db = getDb();
  const settled = settledRows(db);
  const byFixture = new Map<string, KnownPick[]>();
  for (const p of loadKnownPicks()) {
    if (!byFixture.has(p.fixture)) byFixture.set(p.fixture, []);
    byFixture.get(p.fixture)!.push(p);
  }

  const fixtures = [...byFixture.entries()].map(([fixture, picks]) => {
    // each group is built from >= 1 pushed pick, so `best` is always defined.
    const best = picks
      .map((p) => ({ p, edge: p.model_prob - 1 / p.reference_odds }))
      .sort((a, b) => b.edge - a.edge)[0]!;
    const verdict = best.edge >= 0.03 ? 'BET' : 'SKIP';
    return {
      id: fixture,
      teams: fixture,
      kickoff: best.p.kickoff_utc ?? null,
      verdict,
    };
  });

  res.json({
    fixtures,
    generated_at: new Date().toISOString(),
    price_per_call_usd: PRICE_USD_DISPLAY,
    ledger_rows: settled.length,
    note: 'grades & stakes are on /api/edge',
  });
}

// ── POST /api/ledger (free) ──────────────────────────────────────────────────
export function ledgerHandler(req: Request, res: Response): void {
  const db = getDb();
  const rows = allRows(db);
  const body = (req.body ?? {}) as { filter?: { result?: string; grade?: string } };

  const filtered = body.filter
    ? rows.filter((r) => (body.filter!.result ? r.result === body.filter!.result : true)
        && (body.filter!.grade ? gradeFor(r.edge_pct) === body.filter!.grade : true))
    : rows;

  const settled = filtered.map((r) => ({
    fixture: r.fixture,
    odds: r.entry_odds,
    fair_prob: r.model_prob,
    grade: gradeFor(r.edge_pct),
    rung: r.stake_name,
    result: r.result,
    pnl: r.result === 'win' ? Math.round(r.stake_units * (r.entry_odds - 1) * 100) / 100
      : r.result === 'loss' ? -r.stake_units
      : 0,
    clv_pct: r.clv_pct,
    pick_hash: r.pick_hash,
    receipt: r.is_placeholder ? `board:${r.id}` : `xlayer:${r.receipt_tx}`,
    is_placeholder: r.is_placeholder,
    reverified_at: readReverifyCache()[r.pick_hash] ?? null,
  }));

  // Honesty gate (PRODUCTION_PLAN #4): placeholder rows are shown but excluded from totals.
  const real = filtered.filter((r) => !r.is_placeholder);
  const staked = real.reduce((s, r) => s + r.stake_units, 0);
  const profit = real.reduce((s, r) => s + (r.result === 'win' ? r.stake_units * (r.entry_odds - 1) : r.result === 'loss' ? -r.stake_units : 0), 0);

  const leaves = filtered.map((r) => r.pick_hash);
  const merkle_root = leaves.length ? buildMerkleTree(leaves).root : null;

  res.json({
    settled,
    totals: { n: real.length, roi_pct: staked > 0 ? Math.round((profit / staked) * 10000) / 10000 : 0 },
    anchor: { merkle_root, contract: null, explorer_url: null },
    disclaimer: 'Rows with is_placeholder=true are seed/demo data (no on-chain receipt). Excluded from totals. See DEMO.md.',
  });
}

// ── POST /api/me (free — BuyerLens read + forget) ────────────────────────────
export function meHandler(req: Request, res: Response): void {
  const db = getDb();
  const body = (req.body ?? {}) as { address?: string; forget?: boolean };
  if (!body.address) {
    res.status(400).json({ error: 'address_required' });
    return;
  }
  if (body.forget) {
    const removed = forgetBuyer(db, body.address);
    res.json({ address: body.address, deleted: true, rows_removed: removed });
    return;
  }
  const summary = buyerSummary(db, body.address);
  const calls = buyerHistory(db, body.address).map((c) => ({
    pick_hash: c.pick_hash, fixture: c.fixture, verdict: c.verdict, grade: c.grade, at: c.at,
  }));
  res.json({ ...summary, calls });
}

// ── POST /api/receipts/verify (free) ─────────────────────────────────────────
const reverifyCachePath = () => PATHS.anchors.replace('anchors.json', 'reverify-cache.json');
function readReverifyCache(): Record<string, string> {
  const p = reverifyCachePath();
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}
function writeReverifyCache(hash: string, at: string): void {
  const cache = readReverifyCache();
  cache[hash] = at;
  fs.writeFileSync(reverifyCachePath(), JSON.stringify(cache, null, 2));
}

export async function receiptsVerifyHandler(req: Request, res: Response): Promise<void> {
  const db = getDb();
  const body = (req.body ?? {}) as { txHash?: string; pick_hash?: string };
  let row: LedgerRow | undefined;
  if (body.txHash) row = rowByReceipt(db, body.txHash);
  else if (body.pick_hash) row = rowByHash(db, body.pick_hash);

  if (!row) {
    res.status(404).json({ status: 'not_found' });
    return;
  }

  if (row.is_placeholder) {
    res.json({ status: 'placeholder_no_onchain_receipt', verified_at: null, explorer_url: null, pick_hash: row.pick_hash });
    return;
  }

  const facilitator = buildFacilitatorClient();
  const result = facilitator.getSettleStatus
    ? await facilitator.getSettleStatus(row.receipt_tx)
    : { success: false, status: 'pending' as const };
  const verified_at = new Date().toISOString();
  writeReverifyCache(row.pick_hash, verified_at);
  res.json({
    status: result.status ?? (result.success ? 'success' : 'pending'),
    verified_at,
    explorer_url: `https://www.oklink.com/xlayer/tx/${row.receipt_tx}`,
    pick_hash: row.pick_hash,
    live_facilitator: HAS_REAL_OKX_CREDS,
  });
}

// ── GET /health ───────────────────────────────────────────────────────────────
export function healthHandler(_req: Request, res: Response): void {
  const db = getDb();
  res.json({ ok: true, service: 'edgeledger-okx-api', rows: rowCount(db), price_usd: PRICE_USD_DISPLAY, pay_rail: 'okx' });
}
