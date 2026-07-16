/**
 * Coverage completion for the data layer (football.ts, odds.ts, knownPicks.ts,
 * snapshot.ts). Live-network paths are exercised with a stubbed global fetch;
 * any fixture files written during the test are backed up and restored so the
 * committed seed data is never mutated.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config';
import { nextFixture, stageLabel, type FdMatch } from '../data/football';
import {
  fetchWorldCupOdds, archiveSnapshot, priceForSide, closingLineFromSnapshots, type OddsGame,
} from '../data/odds';
import { loadKnownPicks, findKnownPick, findKnownPicksForFixture } from '../data/knownPicks';

const WC_MATCHES = path.join(ROOT, 'fixtures', 'wc-matches.json');
const SNAP_DIR = path.join(ROOT, 'fixtures', 'odds-snapshots');

function snapshotFiles(): Set<string> {
  return new Set(fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR) : []);
}
function cleanupNewSnapshots(before: Set<string>): void {
  for (const f of fs.readdirSync(SNAP_DIR)) {
    if (!before.has(f)) fs.unlinkSync(path.join(SNAP_DIR, f));
  }
}

// ── football.ts ──────────────────────────────────────────────────────────────
describe('data/football — cache reads, live fetch, and helpers', () => {
  it('nextFixture returns the earliest upcoming non-finished match and undefined when none', () => {
    const matches: FdMatch[] = [
      { id: 1, utcDate: '2026-07-14T19:00:00Z', status: 'SCHEDULED', stage: 'SEMI_FINALS', homeTeam: { name: 'A' }, awayTeam: { name: 'B' }, score: { winner: null, fullTime: { home: null, away: null } } },
      { id: 2, utcDate: '2026-07-10T19:00:00Z', status: 'FINISHED', stage: 'QUARTER_FINALS', homeTeam: { name: 'C' }, awayTeam: { name: 'D' }, score: { winner: 'HOME_TEAM', fullTime: { home: 2, away: 1 } } },
      { id: 3, utcDate: '2026-07-16T19:00:00Z', status: 'SCHEDULED', stage: 'FINAL', homeTeam: { name: 'E' }, awayTeam: { name: 'F' }, score: { winner: null, fullTime: { home: null, away: null } } },
    ];
    const now = new Date('2026-07-12T00:00:00Z');
    expect(nextFixture(matches, now)?.id).toBe(1);
    expect(nextFixture([], now)).toBeUndefined();
  });

  it('stageLabel maps known stages and passes unknown ones through', () => {
    expect(stageLabel('GROUP_STAGE')).toBe('GRP');
    expect(stageLabel('LAST_16')).toBe('R16');
    expect(stageLabel('QUARTER_FINALS')).toBe('QF');
    expect(stageLabel('SEMI_FINALS')).toBe('SF');
    expect(stageLabel('FINAL')).toBe('F');
    expect(stageLabel('THIRD_PLACE')).toBe('3P');
    expect(stageLabel('MYSTERY')).toBe('MYSTERY');
  });

  it('fetchWorldCupMatches serves the committed cache when no key is configured', async () => {
    const { fetchWorldCupMatches } = await import('../data/football');
    const { matches, source } = await fetchWorldCupMatches();
    expect(source).toBe('cache');
    expect(matches.length).toBeGreaterThan(0);
  });

  it('fetchWorldCupMatches(force) throws when no key and no cache is usable', async () => {
    const { fetchWorldCupMatches } = await import('../data/football');
    await expect(fetchWorldCupMatches({ force: true })).rejects.toThrow(/FOOTBALL_DATA_KEY not set/);
  });

  it('fetchWorldCupMatches(force) hits the live API and caches the response (key present)', async () => {
    const original = fs.readFileSync(WC_MATCHES, 'utf8');
    const mockMatches = [{ id: 99, utcDate: '2026-07-18T19:00:00Z', status: 'SCHEDULED', stage: 'FINAL', homeTeam: { name: 'X' }, awayTeam: { name: 'Y' }, score: { winner: null, fullTime: { home: null, away: null } } }];
    try {
      vi.resetModules();
      vi.stubEnv('FOOTBALL_DATA_KEY', 'test-key');
      const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ matches: mockMatches }) }));
      vi.stubGlobal('fetch', fetchMock);
      const { fetchWorldCupMatches } = await import('../data/football');
      const res = await fetchWorldCupMatches({ force: true });
      expect(res.source).toBe('live');
      expect(res.matches[0].id).toBe(99);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      fs.writeFileSync(WC_MATCHES, original);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('fetchWorldCupMatches serves a fresh (<60s) cache even when a key is configured', async () => {
    const original = fs.readFileSync(WC_MATCHES, 'utf8');
    try {
      fs.writeFileSync(WC_MATCHES, JSON.stringify({ fetched_at: new Date().toISOString(), matches: [{ id: 7 }] }));
      vi.resetModules();
      vi.stubEnv('FOOTBALL_DATA_KEY', 'test-key');
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      const { fetchWorldCupMatches } = await import('../data/football');
      const res = await fetchWorldCupMatches(); // key set, but cache is <60s old → cache branch
      expect(res.source).toBe('cache');
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fs.writeFileSync(WC_MATCHES, original);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('fetchWorldCupMatches(force) throws on a non-OK API response', async () => {
    const original = fs.readFileSync(WC_MATCHES, 'utf8');
    try {
      vi.resetModules();
      vi.stubEnv('FOOTBALL_DATA_KEY', 'test-key');
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403, text: async () => 'forbidden' })));
      const { fetchWorldCupMatches } = await import('../data/football');
      await expect(fetchWorldCupMatches({ force: true })).rejects.toThrow(/football-data 403/);
    } finally {
      fs.writeFileSync(WC_MATCHES, original);
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

// ── odds.ts ──────────────────────────────────────────────────────────────────
describe('data/odds — cache/live fetch, archive, and price selection', () => {
  let before: Set<string>;
  beforeEach(() => { before = snapshotFiles(); });
  afterEach(() => { cleanupNewSnapshots(before); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.resetModules(); });

  it('serves the newest committed snapshot when no key is configured (stale cache)', async () => {
    const { games, source, capturedAt } = await fetchWorldCupOdds();
    expect(source).toBe('cache');
    expect(Array.isArray(games)).toBe(true);
    expect(typeof capturedAt).toBe('string');
  });

  it('serves a fresh (<5min) snapshot via the freshness branch', async () => {
    const fresh = path.join(SNAP_DIR, 'odds-fresh-test.json');
    fs.writeFileSync(fresh, JSON.stringify({ captured_at: '2026-01-01T00:00:00Z', games: [{ id: 'g', commence_time: 'now', home_team: 'H', away_team: 'A', bookmakers: [] }] }));
    const now = Date.now();
    fs.utimesSync(fresh, now / 1000, now / 1000); // make it the freshest file
    const { source } = await fetchWorldCupOdds();
    expect(source).toBe('cache');
  });

  it('hits the live API (key set, stale committed cache, no force) and archives the snapshot', async () => {
    // Covers odds.ts line 70's `!ODDS_API_KEY` arm evaluating FALSE on the
    // non-force path: key present + newest snapshot stale → cache is skipped and
    // the live fetch branch runs. (The other odds live test uses force:true,
    // which short-circuits at `!opts.force` before this operand is reached.)
    const mockGames = [{ id: 'live-g', commence_time: '2026-07-18T19:00:00Z', home_team: 'H', away_team: 'A', bookmakers: [] }];
    vi.resetModules();
    vi.stubEnv('ODDS_API_KEY', 'test-key');
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => mockGames,
      headers: { get: () => null },
    }));
    vi.stubGlobal('fetch', fetchMock);
    // A fresh git checkout (e.g. CI) resets committed-file mtimes to ~now, which
    // would make the newest snapshot look "fresh" (< CACHE_TTL) and short-circuit
    // to cache. Age every committed snapshot so the "stale committed cache"
    // precondition holds deterministically regardless of checkout time.
    const staleSec = (Date.now() - 60 * 60 * 1000) / 1000; // 1h ago
    for (const f of fs.readdirSync(SNAP_DIR)) {
      fs.utimesSync(path.join(SNAP_DIR, f), staleSec, staleSec);
    }
    const { fetchWorldCupOdds: liveFetch } = await import('../data/odds');
    const res = await liveFetch(); // no force; committed snapshots are stale
    expect(res.source).toBe('live');
    expect(res.games[0].id).toBe('live-g');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('throws when forced with no key and (skipping cache) no snapshot to fall back on', async () => {
    await expect(fetchWorldCupOdds({ force: true })).rejects.toThrow(/ODDS_API_KEY not set/);
  });

  it('throws (no key, no snapshot dir) when the snapshots directory is absent', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false); // newestSnapshotFile → undefined
    await expect(fetchWorldCupOdds()).rejects.toThrow(/ODDS_API_KEY not set/);
    vi.restoreAllMocks();
  });

  it('reads a bare-array snapshot (no games/captured_at wrapper) via the fallback branches', async () => {
    const bare = path.join(SNAP_DIR, 'odds-bare-test.json');
    fs.writeFileSync(bare, JSON.stringify([{ id: 'g', commence_time: 'x', home_team: 'H', away_team: 'A', bookmakers: [] }]));
    const now = Date.now();
    fs.utimesSync(bare, now / 1000, now / 1000); // freshest → selected
    const { games, source, capturedAt } = await fetchWorldCupOdds();
    expect(source).toBe('cache');
    expect(games[0].id).toBe('g'); // raw.games ?? raw → raw (the array)
    expect(typeof capturedAt).toBe('string'); // raw.captured_at ?? mtime ISO
  });

  it('archiveSnapshot writes a self-describing raw file and returns its path', () => {
    const games: OddsGame[] = [{ id: 'g1', commence_time: '2026-07-14T19:00:00Z', home_team: 'France', away_team: 'Spain', bookmakers: [] }];
    const file = archiveSnapshot(games, new Date().toISOString(), { remaining: '400', used: '100' });
    expect(fs.existsSync(file)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(raw.games[0].home_team).toBe('France');
    expect(raw.quota.remaining).toBe('400');
  });

  it('priceForSide returns the median book price per side and undefined when absent', () => {
    const game: OddsGame = {
      id: 'g', commence_time: 'x', home_team: 'France', away_team: 'Spain',
      bookmakers: [
        { key: 'b1', markets: [{ key: 'h2h', outcomes: [{ name: 'France', price: 2.0 }, { name: 'Spain', price: 3.0 }, { name: 'Draw', price: 3.5 }] }] },
        { key: 'b2', markets: [{ key: 'h2h', outcomes: [{ name: 'France', price: 2.2 }, { name: 'Spain', price: 3.1 }, { name: 'Draw', price: 3.6 }] }] },
        { key: 'b3', markets: [{ key: 'totals', outcomes: [{ name: 'Over', price: 1.9 }] }] },
      ],
    };
    expect(priceForSide(game, 'HOME')).toBe(2.2);
    expect(priceForSide(game, 'AWAY')).toBe(3.1);
    expect(priceForSide(game, 'DRAW')).toBe(3.6);
    const bare: OddsGame = { id: 'x', commence_time: 'x', home_team: 'A', away_team: 'B', bookmakers: [] };
    expect(priceForSide(bare, 'HOME')).toBeUndefined();
  });

  it('closingLineFromSnapshots picks the last pre-kickoff snapshot', () => {
    const snaps = [
      { captured_at: '2026-07-14T17:00:00Z', odds: 2.0 },
      { captured_at: '2026-07-14T18:30:00Z', odds: 2.1 },
      { captured_at: '2026-07-14T20:00:00Z', odds: 2.4 },
    ];
    expect(closingLineFromSnapshots(snaps, '2026-07-14T19:00:00Z')?.odds).toBe(2.1);
    expect(closingLineFromSnapshots([], '2026-07-14T19:00:00Z')).toBeUndefined();
  });

  it('fetches live odds and archives them when a key is present', async () => {
    vi.resetModules();
    vi.stubEnv('ODDS_API_KEY', 'test-key');
    const games = [{ id: 'live1', commence_time: '2026-07-14T19:00:00Z', home_team: 'France', away_team: 'Spain', bookmakers: [] }];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => games, headers: { get: () => '400' } })));
    const mod = await import('../data/odds');
    const res = await mod.fetchWorldCupOdds({ force: true });
    expect(res.source).toBe('live');
    expect(res.games[0].id).toBe('live1');
  });

  it('throws on a non-OK live odds response', async () => {
    vi.resetModules();
    vi.stubEnv('ODDS_API_KEY', 'test-key');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429, text: async () => 'rate limited' })));
    const mod = await import('../data/odds');
    await expect(mod.fetchWorldCupOdds({ force: true })).rejects.toThrow(/the-odds-api 429/);
  });
});

// ── knownPicks.ts ────────────────────────────────────────────────────────────
describe('data/knownPicks — matching + empty/absent file branches', () => {
  afterEach(() => vi.restoreAllMocks());

  it('findKnownPick matches by fixture with and without a selection', () => {
    expect(findKnownPick('SF: FRA vs ESP')?.fixture).toBe('SF: FRA vs ESP'); // no selection → first candidate
    expect(findKnownPick('SF: FRA vs ESP', 'Spain to advance')?.side_label).toBe('Spain to advance');
    expect(findKnownPick('nonexistent fixture')).toBeUndefined();
  });

  it('findKnownPicksForFixture matches both substring directions', () => {
    expect(findKnownPicksForFixture('SF: FRA vs ESP').length).toBeGreaterThanOrEqual(2); // p.fixture.includes(f)
    expect(findKnownPicksForFixture('SF: FRA vs ESP (semifinal)').length).toBeGreaterThanOrEqual(2); // f.includes(p.fixture)
  });

  it('returns [] when the known-picks file is absent', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    expect(loadKnownPicks()).toEqual([]);
  });

  it('returns [] when the file has no picks array', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}' as any);
    expect(loadKnownPicks()).toEqual([]);
  });
});

// ── snapshot.ts (CLI entrypoint) ─────────────────────────────────────────────
describe('data/snapshot — CLI main + entrypoint guard', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let before: Set<string>;
  beforeAll(() => { before = snapshotFiles(); });
  beforeEach(() => {
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); });
  afterAll(() => cleanupNewSnapshots(before));

  it('main() logs a cache summary on the happy path', async () => {
    const { main } = await import('../data/snapshot');
    await main([]); // no --force → cache
    expect(logSpy).toHaveBeenCalled();
    expect(String(logSpy.mock.calls[0][0])).toMatch(/snapshot: \d+ games \(cache\)/);
  });

  it('main() reports failure and exits non-zero when the fetch throws', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => undefined as never));
    const { main } = await import('../data/snapshot');
    await main(['--force']); // force + no key → throws → catch → exit(1)
    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('runIfEntrypoint runs main only when argv[1] is this module', async () => {
    const mod = await import('../data/snapshot');
    const url = 'file:///virtual/snapshot.ts';
    const { fileURLToPath } = await import('node:url');
    // false branch: argv[1] does not match
    mod.runIfEntrypoint(['node', '/some/other/file.ts'], url);
    // true branch: argv[1] equals this module's path → invokes main([...]) (cache path)
    mod.runIfEntrypoint(['node', fileURLToPath(url)], url);
    await new Promise((r) => setTimeout(r, 50)); // let the async main settle
    expect(logSpy).toHaveBeenCalled();
  });
});
