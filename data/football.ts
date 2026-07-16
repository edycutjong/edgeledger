/**
 * football-data.org client — FIFA World Cup 2026 fixtures + results (free tier).
 *
 * Free tier: 10 req/min, no odds. Header `X-Auth-Token`. We cache the matches
 * payload to fixtures/ and only refetch when asked, to respect the rate limit.
 *
 * ToS: any UI that shows this data must display
 * "Football data provided by the Football-Data.org API".
 */
import fs from 'node:fs';
import path from 'node:path';
import { FOOTBALL_DATA, FOOTBALL_DATA_KEY, PATHS } from '../config';

export interface FdMatch {
  id: number;
  utcDate: string;
  status: string; // SCHEDULED | LIVE | IN_PLAY | PAUSED | FINISHED
  stage: string; // GROUP_STAGE | LAST_16 | QUARTER_FINALS | SEMI_FINALS | FINAL
  homeTeam: { name: string; shortName?: string; tla?: string };
  awayTeam: { name: string; shortName?: string; tla?: string };
  score: { winner: string | null; fullTime: { home: number | null; away: number | null } };
}

const CACHE_FILE = path.join(PATHS.oddsSnapshots, '..', 'wc-matches.json');

export async function fetchWorldCupMatches(
  opts: { force?: boolean } = {},
): Promise<{ matches: FdMatch[]; source: 'live' | 'cache' }> {
  if (!opts.force && fs.existsSync(CACHE_FILE)) {
    const cached = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!FOOTBALL_DATA_KEY || Date.now() - new Date(cached.fetched_at).getTime() < 60_000) {
      return { matches: cached.matches, source: 'cache' };
    }
  }
  if (!FOOTBALL_DATA_KEY) throw new Error('FOOTBALL_DATA_KEY not set and no cache available');

  const url = `${FOOTBALL_DATA.base}/competitions/${FOOTBALL_DATA.competition}/matches?season=${FOOTBALL_DATA.season}`;
  const res = await fetch(url, { headers: { 'X-Auth-Token': FOOTBALL_DATA_KEY } });
  if (!res.ok) throw new Error(`football-data ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { matches: FdMatch[] };
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify({ fetched_at: new Date().toISOString(), matches: body.matches }, null, 2));
  return { matches: body.matches, source: 'live' };
}

/** The next unplayed knockout fixture (SF/Final), else the next scheduled match. */
export function nextFixture(matches: FdMatch[], now = new Date()): FdMatch | undefined {
  const upcoming = matches
    .filter((m) => new Date(m.utcDate).getTime() > now.getTime() && m.status !== 'FINISHED')
    .sort((a, b) => new Date(a.utcDate).getTime() - new Date(b.utcDate).getTime());
  return upcoming[0];
}

export function stageLabel(stage: string): string {
  const map: Record<string, string> = {
    GROUP_STAGE: 'GRP',
    LAST_16: 'R16',
    QUARTER_FINALS: 'QF',
    SEMI_FINALS: 'SF',
    FINAL: 'F',
    THIRD_PLACE: '3P',
  };
  return map[stage] ?? stage;
}
