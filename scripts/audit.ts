/**
 * edgeledger-audit — independent re-verification of the ledger.
 *
 *   npm run audit -- <receipt_tx>   # audit one pick: re-hash + block-time vs kickoff
 *   npm run audit -- --all          # audit EVERY pick + recompute daily Merkle roots
 *                                   #   vs the on-chain anchor (fixtures/anchors.json)
 *
 * Reads fixtures/ledger-state.json (committed) so it runs with no server and no
 * network. This is the "one command = full independent audit" artifact.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verifyPickHash } from '../engine/hash';
import { buildMerkleTree } from '../engine/merkle';
import type { LedgerRow } from '../engine/types';
import { PATHS } from '../config';

interface State { rows: LedgerRow[] }

function loadState(): State {
  if (!fs.existsSync(PATHS.ledgerState)) {
    console.error('✗ fixtures/ledger-state.json missing — run `npm run settle` first.');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(PATHS.ledgerState, 'utf8'));
}

function auditRow(r: LedgerRow): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  const h = verifyPickHash(r.raw_json, r.pick_hash);
  if (!h.ok) problems.push(`I2 hash mismatch (recomputed ${h.actual.slice(0, 12)}…)`);
  const pre = new Date(r.receipt_block_time).getTime() < new Date(r.kickoff_utc).getTime();
  if (!pre) problems.push('I1 receipt_block_time >= kickoff_utc');
  return { ok: problems.length === 0, problems };
}

function auditOne(tx: string): void {
  const { rows } = loadState();
  const r = rows.find((x) => x.receipt_tx === tx);
  if (!r) {
    console.error(`✗ no ledger row for receipt ${tx}`);
    process.exit(1);
  }
  const { ok, problems } = auditRow(r);
  const deltaH = (new Date(r.kickoff_utc).getTime() - new Date(r.receipt_block_time).getTime()) / 3.6e6;
  console.log(`Audit ${tx}`);
  console.log(`  fixture        : ${r.fixture} — ${r.side_label}`);
  console.log(`  pick_hash      : ${r.pick_hash}`);
  console.log(`  I2 re-hash     : ${verifyPickHash(r.raw_json, r.pick_hash).ok ? 'OK ✓' : 'FAIL ✗'}`);
  console.log(`  I1 pre-kickoff : ${deltaH.toFixed(1)}h before kickoff ${deltaH > 0 ? '✓' : '✗'}`);
  console.log(`  placeholder    : ${r.is_placeholder} ${r.is_placeholder ? '(synthetic receipt — not on-chain)' : ''}`);
  console.log(`  result / CLV   : ${r.result} / ${(r.clv_pct * 100).toFixed(2)}%`);
  console.log(ok ? '\n✓ PASS' : `\n✗ FAIL: ${problems.join('; ')}`);
  process.exit(ok ? 0 : 1);
}

function auditAll(): void {
  const { rows } = loadState();
  let hashFails = 0, timeFails = 0;
  for (const r of rows) {
    const { problems } = auditRow(r);
    if (problems.some((p) => p.startsWith('I2'))) hashFails++;
    if (problems.some((p) => p.startsWith('I1'))) timeFails++;
  }

  // I3: distinct receipts == rows
  const distinctReceipts = new Set(rows.map((r) => r.receipt_tx)).size;
  const i3 = distinctReceipts === rows.length;

  // I5: recompute daily Merkle roots and diff against the ON-CHAIN anchor.
  // Only rows in anchors.json with onchain=true (a posted AnchorPosted tx) count
  // as a chain commitment; off-chain computed roots are informational.
  const anchors: Record<string, { merkleRoot: string; count: number; tx?: string; onchain?: boolean }> =
    fs.existsSync(PATHS.anchors) ? JSON.parse(fs.readFileSync(PATHS.anchors, 'utf8')) : {};
  const strip0x = (s: string) => s.replace(/^0x/i, '');
  const byDay = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const day = new Date(r.settled_at).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(r);
  }
  let anchorChecked = 0, anchorMatched = 0;
  const dayLines: string[] = [];
  for (const [day, dayRows] of [...byDay.entries()].sort()) {
    const leaves = dayRows.sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.pick_hash);
    const root = buildMerkleTree(leaves).root;
    const onchain = anchors[day];
    let status = 'not anchored on-chain';
    if (onchain?.onchain && onchain.tx) {
      anchorChecked++;
      if (strip0x(onchain.merkleRoot) === root) { anchorMatched++; status = `MATCHES chain ✓ (${onchain.tx.slice(0, 12)}…)`; }
      else status = 'MISMATCH vs chain ✗';
    }
    dayLines.push(`    ${day}: ${dayRows.length} picks · root ${root.slice(0, 16)}… · ${status}`);
  }

  console.log('edgeledger-audit --all');
  console.log(`  rows audited   : ${rows.length}`);
  console.log(`  I1 pre-kickoff : ${rows.length - timeFails}/${rows.length} ok`);
  console.log(`  I2 re-hash     : ${rows.length - hashFails}/${rows.length} ok`);
  console.log(`  I3 rows==recpts: ${i3 ? 'OK ✓' : `FAIL ✗ (${distinctReceipts} receipts)`}`);
  console.log(`  I5 daily roots : ${byDay.size} days; ${anchorMatched}/${anchorChecked} anchored roots match chain`);
  console.log(dayLines.join('\n'));
  const pass = hashFails === 0 && timeFails === 0 && i3 && anchorChecked === anchorMatched;
  console.log(pass ? '\n✓ LEDGER PASSES INDEPENDENT AUDIT' : '\n✗ AUDIT FOUND PROBLEMS');
  process.exit(pass ? 0 : 1);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes('--all')) auditAll();
  else if (args[0] && !args[0].startsWith('--')) auditOne(args[0]);
  else {
    console.log('usage: npm run audit -- <receipt_tx> | --all');
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
