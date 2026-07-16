/**
 * Coverage completion for api/routes.ts — the handlers are driven directly with
 * lightweight Request/Response doubles and a purpose-seeded in-memory DB
 * (placeholder + real rows, every result type) so the filter, PnL, receipt,
 * BuyerLens, and facilitator branches are all exercised. The facilitator
 * shape-branches (getSettleStatus present/absent, status present/absent) are
 * reached by stubbing buildFacilitatorClient — the same seam production swaps a
 * real OKXFacilitatorClient into.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import {
  decodeXPayment, edgeHandler, slateHandler, ledgerHandler, meHandler,
  receiptsVerifyHandler, healthHandler, getDb, resetDbForTests,
} from '../api/routes';
import * as okx from '../api/rails/okx';
import * as knownPicks from '../data/knownPicks';
import { openMemoryDb, upsertRow } from '../db/ledger';
import { appendBuyerCall } from '../db/buyers';
import { PATHS } from '../config';
import type { LedgerRow } from '../engine/types';

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    id: 'x', fixture: 'F', competition: 'C', kickoff_utc: '2026-07-14T19:00:00Z',
    side: 'HOME', side_label: 's', entry_odds: 2, closing_odds: 2, model_prob: 0.6,
    market_implied_prob: 0.5, edge_pct: 0.06, stake_tier: 2, stake_name: 'value', stake_units: 5,
    result: 'win', clv_pct: 1, clv_prob_points: 0.01, pick_hash: 'h', receipt_tx: '0xtx',
    receipt_block_time: '2026-07-14T18:00:00Z', sold_count: 1, revenue_usdc: 0.05,
    settled_at: '2026-07-14T22:00:00Z', is_placeholder: true, raw_json: '{}', verdict: 'APPROVED',
    ...over,
  };
}

function seedDb() {
  const db = openMemoryDb();
  upsertRow(db, row({ id: 'pw', pick_hash: 'pw', receipt_tx: '0xpw', result: 'win', edge_pct: 0.09, stake_tier: 3, stake_units: 8, entry_odds: 2 }));
  upsertRow(db, row({ id: 'pl', pick_hash: 'pl', receipt_tx: '0xpl', result: 'loss', edge_pct: 0.05, stake_tier: 2, stake_units: 4, entry_odds: 3 }));
  upsertRow(db, row({ id: 'pv', pick_hash: 'pv', receipt_tx: '0xpv', result: 'void', edge_pct: 0.01, stake_tier: 1, stake_units: 2 }));
  upsertRow(db, row({ id: 'pp', pick_hash: 'pp', receipt_tx: '0xpp', result: 'pending', edge_pct: 0.02 }));
  // REAL (non-placeholder) settled rows → staked>0 totals + on-chain receipt path,
  // one of each result so the totals PnL reduce covers win / loss / void.
  upsertRow(db, row({ id: 'rw', pick_hash: 'HREAL', receipt_tx: '0xREAL', result: 'win', is_placeholder: false, edge_pct: 0.07, stake_tier: 2, stake_units: 5, entry_odds: 2.5 }));
  upsertRow(db, row({ id: 'rl', pick_hash: 'HRL', receipt_tx: '0xRL', result: 'loss', is_placeholder: false, edge_pct: 0.04, stake_tier: 1, stake_units: 2, entry_odds: 3 }));
  upsertRow(db, row({ id: 'rv', pick_hash: 'HRV', receipt_tx: '0xRV', result: 'void', is_placeholder: false, edge_pct: 0.01, stake_tier: 1, stake_units: 2 }));
  return db;
}

function makeRes() {
  const res: any = {
    statusCode: 200, body: undefined, headers: {} as Record<string, string>,
    status(c: number) { this.statusCode = c; return this; },
    json(o: unknown) { this.body = o; return this; },
    sendStatus(c: number) { this.statusCode = c; return this; },
    setHeader(k: string, v: string) { this.headers[k] = v; },
  };
  return res;
}
function makeReq(opts: { body?: unknown; headers?: Record<string, string> } = {}) {
  const h = opts.headers ?? {};
  return { body: opts.body, method: 'POST', header: (n: string) => h[n.toLowerCase()] } as any;
}
function xpay(from: string): string {
  return Buffer.from(JSON.stringify({ payload: { authorization: { from, to: '0xpayto', value: '50000' } } })).toString('base64');
}

const reverifyCache = PATHS.anchors.replace('anchors.json', 'reverify-cache.json');

describe('api/routes handlers (direct, seeded DB)', () => {
  beforeEach(() => resetDbForTests(seedDb()));
  afterEach(() => {
    resetDbForTests(null);
    vi.restoreAllMocks();
    if (fs.existsSync(reverifyCache)) fs.unlinkSync(reverifyCache);
  });

  it('decodeXPayment: header forms + malformed input', () => {
    expect(decodeXPayment(makeReq())).toBeNull(); // no header
    expect(decodeXPayment(makeReq({ headers: { 'x-payment': xpay('0xabc') } }))?.from).toBe('0xabc');
    // top-level authorization (no payload wrapper)
    const top = Buffer.from(JSON.stringify({ authorization: { from: '0xf', to: '0xt', value: '1' } })).toString('base64');
    expect(decodeXPayment(makeReq({ headers: { 'x-payment': top } }))?.from).toBe('0xf');
    // missing a required field → null
    const partial = Buffer.from(JSON.stringify({ authorization: { from: '0xf' } })).toString('base64');
    expect(decodeXPayment(makeReq({ headers: { 'x-payment': partial } }))).toBeNull();
    // un-decodable → null (catch)
    expect(decodeXPayment(makeReq({ headers: { 'x-payment': '@@@not-base64@@@' } }))).toBeNull();
  });

  it('edgeHandler: missing fixture → 400 (with an undefined body)', () => {
    const res = makeRes();
    edgeHandler(makeReq({ body: undefined }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toBe('fixture_required');
  });

  it('edgeHandler: slate mode with no model coverage → SKIP (bankroll and no-bankroll variants)', () => {
    const res1 = makeRes();
    edgeHandler(makeReq({ body: { fixture: 'Totally Unknown Fixture', bankroll: 100 } }), res1);
    expect(res1.body.verdict).toBe('SKIP');
    expect(res1.body.stake.amount).toBe(0); // bankroll present → 0

    const res2 = makeRes();
    edgeHandler(makeReq({ body: { fixture: 'Totally Unknown Fixture' } }), res2);
    expect(res2.body.stake.amount).toBeNull(); // no bankroll → null
  });

  it('edgeHandler: validate APPROVED with X-PAYMENT writes a buyer row (mirror/gradeStats over mixed settled rows)', () => {
    const res = makeRes();
    edgeHandler(makeReq({
      body: { fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05, bankroll: 500, proposed_stake_pct: 9 },
      headers: { 'x-payment': xpay('0xBuyer1') },
    }), res);
    expect(res.body.verdict).toBe('APPROVED');
    expect(res.body.you).toBeTruthy();
    expect(res.body.you.your_calls).toBeGreaterThanOrEqual(1);

    // and the no-proposed-stake path (proposed_stake_pct omitted → null)
    const res2 = makeRes();
    edgeHandler(makeReq({
      body: { fixture: 'SF: FRA vs ESP', selection: 'France to advance', odds: 2.05 },
      headers: { 'x-payment': xpay('0xBuyer2') },
    }), res2);
    expect(res2.body.you.your_calls).toBe(1);
  });

  it('slateHandler: real known-picks yield BET; a mocked low-edge/null-kickoff fixture yields SKIP', () => {
    const res = makeRes();
    slateHandler(makeReq({ body: {} }), res);
    expect(res.body.fixtures.some((f: any) => f.verdict === 'BET')).toBe(true);

    vi.spyOn(knownPicks, 'loadKnownPicks').mockReturnValue([
      { fixture: 'Low Edge FC', competition: 'C', stage: 'GRP', kickoff_utc: undefined as any, side_label: 'x', model_prob: 0.5, reference_odds: 2.0 },
    ]);
    const res2 = makeRes();
    slateHandler(makeReq({ body: {} }), res2);
    const low = res2.body.fixtures.find((f: any) => f.id === 'Low Edge FC');
    expect(low.verdict).toBe('SKIP'); // edge 0.0 < 0.03
    expect(low.kickoff).toBeNull(); // undefined kickoff → null
  });

  it('ledgerHandler: unfiltered totals include the real row; filters by result and grade', () => {
    const res = makeRes();
    ledgerHandler(makeReq({ body: undefined }), res);
    expect(res.body.totals.n).toBe(3); // three real rows (win/loss/void) count
    expect(res.body.totals.roi_pct).not.toBe(0); // staked > 0 branch
    expect(res.body.anchor.merkle_root).toMatch(/^[0-9a-f]{64}$/);
    // rows carry both board: (placeholder) and xlayer: (real) receipts + win/loss/void PnL
    const receipts = res.body.settled.map((r: any) => r.receipt);
    expect(receipts.some((r: string) => r.startsWith('board:'))).toBe(true);
    expect(receipts.some((r: string) => r.startsWith('xlayer:'))).toBe(true);

    const byResult = makeRes();
    ledgerHandler(makeReq({ body: { filter: { result: 'loss' } } }), byResult);
    expect(byResult.body.settled.every((r: any) => r.result === 'loss')).toBe(true);

    const byGrade = makeRes();
    ledgerHandler(makeReq({ body: { filter: { grade: 'A' } } }), byGrade);
    expect(byGrade.body.settled.every((r: any) => r.grade === 'A')).toBe(true);

    // a filter that matches nothing → empty leaves → merkle_root null, roi 0
    const none = makeRes();
    ledgerHandler(makeReq({ body: { filter: { result: 'no-such-result' } } }), none);
    expect(none.body.settled).toEqual([]);
    expect(none.body.anchor.merkle_root).toBeNull();
    expect(none.body.totals).toEqual({ n: 0, roi_pct: 0 });
  });

  it('meHandler: 400 without address; summary+calls with history; forget deletes', () => {
    const noAddr = makeRes();
    meHandler(makeReq({ body: {} }), noAddr);
    expect(noAddr.statusCode).toBe(400);

    const undefBody = makeRes(); // req.body undefined → defaults to {} → still 400
    meHandler(makeReq({ body: undefined }), undefBody);
    expect(undefBody.statusCode).toBe(400);

    const db = getDb();
    appendBuyerCall(db, { buyer_from: '0xMe', pick_hash: 'h', fixture: 'f', verdict: 'APPROVED', grade: 'A', proposed_stake_pct: 6, ladder_stake_pct: 6, at: new Date().toISOString() });
    const read = makeRes();
    meHandler(makeReq({ body: { address: '0xMe' } }), read);
    expect(read.body.your_calls).toBe(1);
    expect(read.body.calls.length).toBe(1);

    const forget = makeRes();
    meHandler(makeReq({ body: { address: '0xMe', forget: true } }), forget);
    expect(forget.body.deleted).toBe(true);
    expect(forget.body.rows_removed).toBe(1);
  });

  it('receiptsVerifyHandler: 404, placeholder, and the real on-chain-receipt path (local facilitator)', async () => {
    const notFound = makeRes();
    await receiptsVerifyHandler(makeReq({ body: { pick_hash: 'f'.repeat(64) } }), notFound);
    expect(notFound.statusCode).toBe(404);

    const noId = makeRes(); // undefined body → defaults to {} → neither id → row undefined → 404
    await receiptsVerifyHandler(makeReq({ body: undefined }), noId);
    expect(noId.statusCode).toBe(404);

    const placeholder = makeRes();
    await receiptsVerifyHandler(makeReq({ body: { pick_hash: 'pw' } }), placeholder);
    expect(placeholder.body.status).toBe('placeholder_no_onchain_receipt');

    const real = makeRes(); // lookup by txHash → real row → LocalFacilitator.getSettleStatus → 'pending'
    await receiptsVerifyHandler(makeReq({ body: { txHash: '0xREAL' } }), real);
    expect(real.body.status).toBe('pending');
    expect(real.body.verified_at).toBeTruthy();
    expect(real.body.explorer_url).toContain('0xREAL');

    // subsequent ledger read now sees the reverify-cache write (existsSync true branch)
    const led = makeRes();
    ledgerHandler(makeReq({ body: {} }), led);
    const realRow = led.body.settled.find((r: any) => r.pick_hash === 'HREAL');
    expect(realRow.reverified_at).toBeTruthy();
  });

  it('receiptsVerifyHandler: facilitator without getSettleStatus and with a status-less success', async () => {
    // facilitator lacking getSettleStatus → falls back to the inline {success:false,status:'pending'}
    vi.spyOn(okx, 'buildFacilitatorClient').mockReturnValue({} as any);
    const noStatus = makeRes();
    await receiptsVerifyHandler(makeReq({ body: { pick_hash: 'HREAL' } }), noStatus);
    expect(noStatus.body.status).toBe('pending');

    // facilitator whose getSettleStatus returns success with no explicit status → 'success'
    vi.spyOn(okx, 'buildFacilitatorClient').mockReturnValue({
      getSettleStatus: async () => ({ success: true }),
    } as any);
    const success = makeRes();
    await receiptsVerifyHandler(makeReq({ body: { pick_hash: 'HREAL' } }), success);
    expect(success.body.status).toBe('success');

    // getSettleStatus resolving unsuccessful with no explicit status → 'pending' (ternary false side)
    vi.spyOn(okx, 'buildFacilitatorClient').mockReturnValue({
      getSettleStatus: async () => ({ success: false }),
    } as any);
    const pend = makeRes();
    await receiptsVerifyHandler(makeReq({ body: { pick_hash: 'HREAL' } }), pend);
    expect(pend.body.status).toBe('pending');
  });

  it('healthHandler reports row count + price', () => {
    const res = makeRes();
    healthHandler(makeReq(), res);
    expect(res.body.ok).toBe(true);
    expect(res.body.rows).toBeGreaterThanOrEqual(5);
    expect(res.body.pay_rail).toBe('okx');
  });
});
