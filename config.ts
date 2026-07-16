/**
 * EdgeLedger (OKX.AI edition) — central config.
 *
 * X Layer / OKX x402 constants are pinned from the SHIPPED @okxweb3 x402
 * packages' compiled .d.ts files (installed under node_modules), verified
 * 2026-07-15 by installing the real packages and reading their declarations — NOT
 * from ARCHITECTURE.md prose alone. Where the spec sketch disagreed with the
 * shipped types (e.g. the server-side `ExactEvmScheme` import path), the
 * shipped types win — see api/rails/okx.ts header comment.
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// Load build/.env.local (gitignored). Falls back to process env in CI.
const HERE = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(HERE, '.env.local') });

export const ROOT = HERE;

// ── X Layer networks (CAIP-2) ────────────────────────────────────────────────
export const NETWORKS = {
  mainnet: {
    caip2: 'eip155:196' as const,
    chainId: 196,
    name: 'X Layer',
    rpc: 'https://rpc.xlayer.tech',
    explorer: 'https://www.oklink.com/xlayer',
    // USD₮0 — zero-gas promo token on X Layer (EIP-3009 capable).
    usdt0: '0x779ded0c9e1022225f8e0630b35a9b54be713736' as `0x${string}`,
    // USDG — secondary zero-gas accepts asset (dual-stablecoin accepts, 1.5).
    usdg: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8' as `0x${string}`,
  },
  rehearsal: {
    caip2: 'eip155:1952' as const,
    chainId: 1952,
    name: 'X Layer Rehearsal (testnet)',
    rpc: 'https://testrpc.xlayer.tech',
    explorer: 'https://www.oklink.com/xlayer-test',
    usdt0: '0x779ded0c9e1022225f8e0630b35a9b54be713736' as `0x${string}`,
    usdg: '0x4ae46a509f6b1d9056937ba4500cb143933d2dc8' as `0x${string}`,
  },
} as const;

export type NetworkKey = keyof typeof NETWORKS;

/** Active network. Rehearsal per default (safe for local/CI); override with X402_NETWORK. */
export const ACTIVE_NETWORK: NetworkKey =
  (process.env.X402_NETWORK === 'eip155:196' ? 'mainnet' : 'rehearsal');

export const NET = NETWORKS[ACTIVE_NETWORK];

// ── Payment rail switch (ARCHITECTURE §Payment wiring) ───────────────────────
/** `okx` is the only rail implemented in this Tier-1 build; the switch exists
 * so `api/server.ts` can select a rail without touching business logic. */
export const PAY_RAIL = (process.env.PAY_RAIL ?? 'okx') as 'okx' | 'injective';

// ── Pricing ─────────────────────────────────────────────────────────────────
/** $0.05 in atomic 6dp units (USD₮0 / USDG both 6 decimals). */
export const PRICE_UNITS = process.env.EDGELEDGER_PRICE_UNITS ?? '50000';
export const ASSET_DECIMALS = 6;
export const PRICE_USD_DISPLAY = Number(PRICE_UNITS) / 10 ** ASSET_DECIMALS; // 0.05
export const PRICE_USD_STRING = `$${PRICE_USD_DISPLAY.toFixed(2)}`;

// ── Wallet / payment config ─────────────────────────────────────────────────
/** x402 receiver (payTo). Address only, no key — decoupled from the facilitator. */
export const PAYTO_ADDRESS = (process.env.PAYTO_ADDRESS ??
  '0x45078eD96C2bB171009A47a57aF5C085Bf4fD0e3') as `0x${string}`;

/** OKX Developer Portal facilitator credentials (production settlement). */
export const OKX_API_KEY = process.env.OKX_API_KEY ?? '';
export const OKX_SECRET_KEY = process.env.OKX_SECRET_KEY ?? '';
export const OKX_PASSPHRASE = process.env.OKX_PASSPHRASE ?? '';
export const HAS_REAL_OKX_CREDS = !!(OKX_API_KEY && OKX_SECRET_KEY && OKX_PASSPHRASE);

// ── Data API keys (unchanged from the ported build) ──────────────────────────
export const FOOTBALL_DATA_KEY = process.env.FOOTBALL_DATA_KEY ?? '';
export const ODDS_API_KEY = process.env.ODDS_API_KEY ?? '';

// football-data.org — FIFA World Cup 2026
export const FOOTBALL_DATA = {
  base: 'https://api.football-data.org/v4',
  competition: 2000,
  season: 2026,
  attribution: 'Football data provided by the Football-Data.org API',
};

// the-odds-api.com
export const ODDS_API = {
  base: 'https://api.the-odds-api.com/v4',
  sportH2H: 'soccer_fifa_world_cup',
  sportOutrights: 'soccer_fifa_world_cup_winner',
  regions: 'eu,uk',
  markets: 'h2h',
  oddsFormat: 'decimal',
};

// ── Server ──────────────────────────────────────────────────────────────────
export const PORT = Number(process.env.PORT ?? 8403);
export const API_BASE_URL = process.env.EDGELEDGER_API_URL ?? `http://localhost:${PORT}`;

// ── Conviction ladder / decay constants (engine/verdict.ts) ──────────────────
/** "edge halves ~30min to kickoff" — the signal-decay honesty field (PRD #5). */
export const DECAY_HALFLIFE_MIN = Number(process.env.EDGELEDGER_DECAY_HALFLIFE_MIN ?? 30);
/** Minimum probability-point edge to APPROVE (below this and >= 0 → SKIP). */
export const ACTION_THRESHOLD = 0.03;

// ── Paths ───────────────────────────────────────────────────────────────────
export const PATHS = {
  db: path.join(HERE, 'db', 'ledger.sqlite'),
  picksCsv: path.join(HERE, 'fixtures', 'picks.csv'),
  ledgerState: path.join(HERE, 'fixtures', 'ledger-state.json'),
  oddsSnapshots: path.join(HERE, 'fixtures', 'odds-snapshots'),
  anchors: path.join(HERE, 'fixtures', 'anchors.json'),
  nextPick: () => path.join(HERE, 'fixtures', 'next-pick.json'),
  bench: () => path.join(HERE, 'fixtures', 'bench.json'),
};

export function explorerTx(txhash: string, net: NetworkKey = ACTIVE_NETWORK): string {
  return `${NETWORKS[net].explorer}/tx/${txhash}`;
}
export function explorerAddress(addr: string, net: NetworkKey = ACTIVE_NETWORK): string {
  return `${NETWORKS[net].explorer}/address/${addr}`;
}
