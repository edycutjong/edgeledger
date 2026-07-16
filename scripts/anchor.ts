/**
 * anchor.ts — Merkle-ize each day's pick hashes and write fixtures/anchors.json.
 *
 *   npm run settle && npx tsx scripts/anchor.ts        # compute daily roots (off-chain)
 *   npx tsx scripts/anchor.ts --onchain <day> <tx>     # record a real AnchorPosted tx
 *
 * The off-chain roots are what LedgerAnchor.postAnchor(day, root, count) commits
 * on X Layer (eip155:196). Recording the tx here lets /api/anchor/:day and
 * `edgeledger-audit --all` diff the DB against the chain (I5). Deploying the
 * contract + posting a root is FUNDS-GATED (needs OKB gas on X Layer) — see
 * contracts/DEPLOY.md.
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildMerkleTree } from '../engine/merkle';
import type { LedgerRow } from '../engine/types';
import { PATHS } from '../config';

function loadRows(): LedgerRow[] {
  return JSON.parse(fs.readFileSync(PATHS.ledgerState, 'utf8')).rows;
}

function readAnchors(): Record<string, any> {
  return fs.existsSync(PATHS.anchors) ? JSON.parse(fs.readFileSync(PATHS.anchors, 'utf8')) : {};
}

/** dayNumber = whole days since epoch (fits the contract's uint32 day param). */
function dayNumber(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 86_400_000);
}

function computeAll(): void {
  const rows = loadRows();
  const byDay = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    const day = new Date(r.settled_at).toISOString().slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(r);
  }
  const existing = readAnchors();
  const out: Record<string, any> = { ...existing };
  for (const [day, dayRows] of [...byDay.entries()].sort()) {
    const leaves = dayRows.sort((a, b) => a.id.localeCompare(b.id)).map((r) => r.pick_hash);
    const { root } = buildMerkleTree(leaves);
    out[day] = {
      day,
      day_number: dayNumber(day + 'T00:00:00Z'),
      merkleRoot: '0x' + root,
      count: dayRows.length,
      tx: existing[day]?.tx ?? null, // real AnchorPosted tx once deployed (funds-gated)
      onchain: existing[day]?.onchain ?? false,
    };
  }
  fs.writeFileSync(PATHS.anchors, JSON.stringify(out, null, 2));
  console.log(`anchor: computed ${byDay.size} daily Merkle roots → ${PATHS.anchors}`);
  for (const [day, a] of Object.entries(out)) {
    console.log(`  ${day}: root ${(a as any).merkleRoot.slice(0, 20)}… · ${(a as any).count} picks · onchain=${(a as any).onchain}`);
  }
  console.log('\nTo commit a root on-chain: deploy contracts/LedgerAnchor.sol to X Layer (eip155:196), then');
  console.log('  postAnchor(day_number, merkleRoot, count)  → record the tx with --onchain.');
  console.log('(CREDENTIAL/FUNDS-GATED — needs OKX Developer Portal creds + gas. See DEMO.md.)');
}

function recordOnchain(day: string, tx: string): void {
  const anchors = readAnchors();
  if (!anchors[day]) {
    console.error(`✗ no computed anchor for ${day} — run without args first.`);
    process.exit(1);
  }
  // Honesty guard: only accept a real-looking 32-byte tx hash.
  if (!/^0x[0-9a-fA-F]{64}$/.test(tx)) {
    console.error('✗ refusing to record a non-txhash. Provide the real AnchorPosted tx (0x + 64 hex).');
    process.exit(1);
  }
  anchors[day].tx = tx;
  anchors[day].onchain = true;
  fs.writeFileSync(PATHS.anchors, JSON.stringify(anchors, null, 2));
  console.log(`anchor: recorded on-chain tx for ${day}: ${tx}`);
}

function main(): void {
  const i = process.argv.indexOf('--onchain');
  if (i >= 0) recordOnchain(process.argv[i + 1], process.argv[i + 2]);
  else computeAll();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
