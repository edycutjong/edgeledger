/**
 * check_submission_readiness.ts — gate before recording/submitting.
 *
 *   npm run readiness
 *
 * Verifies the concrete deliverables exist and the live 402 works. Prints a
 * pass/fail table; exits nonzero if any REQUIRED check fails. "Funds-gated"
 * items (real paid mainnet receipt, on-chain anchor) are reported as PENDING
 * (not failures) — they unblock once OKX Developer Portal credentials + a
 * funded buyer wallet are available (see DEMO.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../api/server';
import { ROOT, PATHS, PRICE_UNITS } from '../config';

interface Check { name: string; ok: boolean; required: boolean; detail: string }

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel));
}

async function live402(): Promise<{ ok: boolean; detail: string }> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/edge`, { method: 'POST' });
    // The real x402ResourceServer's default unpaid response BODY is `{}` — the
    // challenge rides the base64 PAYMENT-REQUIRED header (ARCHITECTURE's
    // review-gate self-check: "header and/or JSON body").
    const header = res.headers.get('payment-required');
    const body = header ? JSON.parse(Buffer.from(header, 'base64').toString('utf8')) : null;
    const hasVersion = body?.x402Version === 2;
    const hasAccepts = Array.isArray(body?.accepts) && body.accepts.length >= 2;
    const amountOk = body?.accepts?.[0]?.amount === PRICE_UNITS;
    const ok = res.status === 402 && hasVersion && hasAccepts && amountOk;
    return { ok, detail: `HTTP ${res.status}, x402Version=${body?.x402Version}, accepts=${body?.accepts?.length}, amount=${body?.accepts?.[0]?.amount}` };
  } finally {
    server.close();
  }
}

/** Unpaid GET must serve the same 402 challenge as POST — OKX's review probe is a GET. */
async function getProbe402(): Promise<{ ok: boolean; detail: string }> {
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const res = await fetch(`http://127.0.0.1:${port}/api/edge`, { method: 'GET' });
    const hasHeader = !!res.headers.get('payment-required');
    return { ok: res.status === 402 && hasHeader, detail: `HTTP ${res.status}, PAYMENT-REQUIRED header=${hasHeader}` };
  } finally {
    server.close();
  }
}

async function main(): Promise<void> {
  const checks: Check[] = [];

  // Ledger
  let rows = 0, placeholders = 0, hasLoss = false;
  if (exists('fixtures/ledger-state.json')) {
    const s = JSON.parse(fs.readFileSync(PATHS.ledgerState, 'utf8'));
    rows = s.rows.length;
    placeholders = s.rows.filter((r: any) => r.is_placeholder).length;
    hasLoss = s.rows.some((r: any) => r.result === 'loss');
  }
  checks.push({ name: 'Ledger ≥ 20 settled rows', ok: rows >= 20, required: true, detail: `${rows} rows` });
  checks.push({ name: 'Losses kept public (I3 honesty)', ok: hasLoss, required: true, detail: hasLoss ? 'yes' : 'no losses found' });

  // Live 402 review-gate self-check (POST + GET probe)
  const l = await live402();
  checks.push({ name: 'Live 402 quote (real okx middleware, x402Version:2)', ok: l.ok, required: true, detail: l.detail });
  const g = await getProbe402();
  checks.push({ name: 'GET /api/edge unpaid → 402 + PAYMENT-REQUIRED header', ok: g.ok, required: true, detail: g.detail });

  // Docs / artifacts
  checks.push({ name: 'DEMO.md', ok: exists('DEMO.md'), required: true, detail: '' });
  checks.push({ name: 'Agent Skill SKILL.md', ok: exists('skills/worldcup-edgeledger/SKILL.md'), required: false, detail: '' });
  checks.push({ name: 'LedgerAnchor.sol', ok: exists('contracts/LedgerAnchor.sol'), required: false, detail: '' });
  checks.push({ name: 'picks.csv seed', ok: exists('fixtures/picks.csv'), required: true, detail: '' });
  checks.push({ name: 'known-picks.json model coverage', ok: exists('fixtures/known-picks.json'), required: true, detail: '' });
  checks.push({ name: 'Daily Merkle anchors computed', ok: exists('fixtures/anchors.json'), required: false, detail: 'off-chain roots' });
  checks.push({ name: 'Bench results', ok: exists('fixtures/bench.json'), required: false, detail: '' });

  // Funds/credential-gated (PENDING, not failures)
  const bench = exists('fixtures/bench.json') ? JSON.parse(fs.readFileSync(PATHS.bench(), 'utf8')) : {};
  checks.push({ name: 'Real paid mainnet receipt', ok: !!bench.first_paid_receipt, required: false, detail: bench.first_paid_receipt ? bench.first_paid_receipt.tx : 'PENDING (OKX creds + funded buyer wallet)' });
  const anchors = exists('fixtures/anchors.json') ? JSON.parse(fs.readFileSync(PATHS.anchors, 'utf8')) : {};
  const anyOnchain = Object.values(anchors).some((a: any) => a.onchain);
  checks.push({ name: 'On-chain LedgerAnchor root', ok: anyOnchain, required: false, detail: anyOnchain ? 'posted' : 'PENDING (deploy + funds)' });

  // Print
  const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - s.length));
  console.log('\nEdgeLedger (OKX.AI edition) — submission readiness\n');
  console.log(pad('  CHECK', 46) + pad('STATUS', 10) + 'DETAIL');
  console.log('  ' + '-'.repeat(80));
  let requiredFail = 0;
  for (const c of checks) {
    const status = c.ok ? 'PASS' : c.required ? 'FAIL' : 'PENDING';
    if (!c.ok && c.required) requiredFail++;
    console.log(pad('  ' + c.name, 46) + pad(status, 10) + c.detail);
  }
  console.log('  ' + '-'.repeat(80));
  console.log(`  ${placeholders}/${rows} ledger rows are placeholder (labeled, excluded from /api/ledger totals).`);
  if (requiredFail === 0) console.log('\n✓ ALL REQUIRED CHECKS PASS (credential/funds-gated items pending).');
  else console.log(`\n✗ ${requiredFail} REQUIRED CHECK(S) FAILED.`);
  process.exit(requiredFail === 0 ? 0 : 1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
