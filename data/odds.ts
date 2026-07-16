/**
 * the-odds-api.com client + closing-line logic (invariant I4).
 *
 * QUOTA IS PRECIOUS (500/mo). We cache aggressively: a live fetch is only made
 * when explicitly requested AND no fresh (< CACHE_TTL) snapshot exists. Raw
 * responses are archived to fixtures/odds-snapshots/ so the demo can run from a
 * committed snapshot if the API is rate-limited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ODDS_API, ODDS_API_KEY, PATHS } from '../config';

export interface OddsSnapshotPoint {
  captured_at: string; // ISO
  odds: number; // decimal odds for the tracked side
}

/**
 * I4: the closing line is the LAST odds snapshot captured at or before kickoff.
 * Post-kickoff snapshots are ignored. Pure + fully unit-tested.
 */
export function closingLineFromSnapshots<T extends { captured_at: string }>(
  snapshots: T[],
  kickoffUtc: string,
): T | undefined {
  const k = new Date(kickoffUtc).getTime();
  const eligible = snapshots
    .filter((s) => new Date(s.captured_at).getTime() <= k)
    .sort((a, b) => new Date(a.captured_at).getTime() - new Date(b.captured_at).getTime());
  return eligible.length ? eligible[eligible.length - 1] : undefined;
}

export interface OddsGame {
  id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmakers: {
    key: string;
    markets: { key: string; outcomes: { name: string; price: number }[] }[];
  }[];
}

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes — matches the documented snapshot cadence

function newestSnapshotFile(): { file: string; mtime: number } | undefined {
  if (!fs.existsSync(PATHS.oddsSnapshots)) return undefined;
  const files = fs
    .readdirSync(PATHS.oddsSnapshots)
    .filter((f) => f.startsWith('odds-') && f.endsWith('.json'))
    .map((f) => {
      const full = path.join(PATHS.oddsSnapshots, f);
      return { file: full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files[0];
}

/**
 * Fetch World Cup h2h odds. Cache-first: reuses the newest archived snapshot if
 * it is < 5 min old (or if force=false and any snapshot exists in offline mode).
 * Returns { games, source: 'live' | 'cache' }.
 */
export async function fetchWorldCupOdds(
  opts: { force?: boolean } = {},
): Promise<{ games: OddsGame[]; source: 'live' | 'cache'; capturedAt: string }> {
  const newest = newestSnapshotFile();
  const fresh = newest && Date.now() - newest.mtime < CACHE_TTL_MS;

  if (!opts.force && newest && (fresh || !ODDS_API_KEY)) {
    const raw = JSON.parse(fs.readFileSync(newest.file, 'utf8'));
    return { games: raw.games ?? raw, source: 'cache', capturedAt: raw.captured_at ?? new Date(newest.mtime).toISOString() };
  }

  if (!ODDS_API_KEY) throw new Error('ODDS_API_KEY not set and no cached snapshot available');

  const url =
    `${ODDS_API.base}/sports/${ODDS_API.sportH2H}/odds` +
    `?regions=${ODDS_API.regions}&markets=${ODDS_API.markets}` +
    `&oddsFormat=${ODDS_API.oddsFormat}&apiKey=${ODDS_API_KEY}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`the-odds-api ${res.status}: ${await res.text()}`);
  const games = (await res.json()) as OddsGame[];
  const capturedAt = new Date().toISOString();
  archiveSnapshot(games, capturedAt, {
    remaining: res.headers.get('x-requests-remaining'),
    used: res.headers.get('x-requests-used'),
  });
  return { games, source: 'live', capturedAt };
}

/** Archive a raw odds response (closing-line honesty trail, I4). */
export function archiveSnapshot(
  games: OddsGame[],
  capturedAt: string,
  quota?: { remaining: string | null; used: string | null },
): string {
  fs.mkdirSync(PATHS.oddsSnapshots, { recursive: true });
  const stamp = capturedAt.replace(/[:.]/g, '-');
  const file = path.join(PATHS.oddsSnapshots, `odds-${stamp}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({ captured_at: capturedAt, sport: ODDS_API.sportH2H, quota, games }, null, 2),
  );
  return file;
}

/** Extract the decimal price for one side of a game (median across books). */
export function priceForSide(game: OddsGame, side: 'HOME' | 'AWAY' | 'DRAW'): number | undefined {
  const name =
    side === 'HOME' ? game.home_team : side === 'AWAY' ? game.away_team : 'Draw';
  const prices: number[] = [];
  for (const b of game.bookmakers) {
    const h2h = b.markets.find((m) => m.key === 'h2h');
    const outcome = h2h?.outcomes.find((o) => o.name === name);
    if (outcome) prices.push(outcome.price);
  }
  if (prices.length === 0) return undefined;
  prices.sort((a, b) => a - b);
  return prices[Math.floor(prices.length / 2)];
}
