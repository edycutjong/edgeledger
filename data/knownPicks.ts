/**
 * Known-fixture model coverage (fixtures/known-picks.json).
 *
 * PRD/COMPLEXITY explicitly rule out inventing a new per-request prediction
 * model for this build ("no new prediction model... accountability is the
 * gap, not model novelty"). So /api/edge only grades fixtures+selections this
 * file has a fair-probability estimate for; anything else honestly SKIPs
 * (PRODUCTION_PLAN honesty gate #3: never serve a fabricated/stale edge).
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config';

export interface KnownPick {
  fixture: string;
  competition: string;
  stage: string;
  kickoff_utc: string;
  side_label: string;
  model_prob: number;
  reference_odds: number;
}

const FILE = path.join(ROOT, 'fixtures', 'known-picks.json');

export function loadKnownPicks(): KnownPick[] {
  if (!fs.existsSync(FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  return (raw.picks ?? []) as KnownPick[];
}

/** Case-insensitive substring match on fixture, and on selection against side_label if given. */
export function findKnownPick(fixture: string, selection?: string): KnownPick | undefined {
  const picks = loadKnownPicks();
  const f = fixture.trim().toLowerCase();
  const candidates = picks.filter((p) => p.fixture.toLowerCase().includes(f) || f.includes(p.fixture.toLowerCase()));
  if (!selection) return candidates[0];
  const s = selection.trim().toLowerCase();
  return (
    candidates.find((p) => p.side_label.toLowerCase().includes(s) || s.includes(p.side_label.toLowerCase())) ??
    candidates[0]
  );
}

/** All known selections for a fixture (for slate mode's "best value on this fixture"). */
export function findKnownPicksForFixture(fixture: string): KnownPick[] {
  const picks = loadKnownPicks();
  const f = fixture.trim().toLowerCase();
  return picks.filter((p) => p.fixture.toLowerCase().includes(f) || f.includes(p.fixture.toLowerCase()));
}
