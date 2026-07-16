/**
 * Odds snapshotter CLI — captures one the-odds-api snapshot into
 * fixtures/odds-snapshots/ (the closing-line honesty trail, I4).
 *
 *   npm run snapshot            # cache-first (won't spend quota if fresh)
 *   npm run snapshot -- --force # force a live fetch (spends 1 quota unit)
 *
 * Budget: ~500/mo. Run only around kickoffs, never in a loop.
 */
import { fileURLToPath } from 'node:url';
import { fetchWorldCupOdds } from './odds';

export async function main(argv: string[] = process.argv): Promise<void> {
  const force = argv.includes('--force');
  try {
    const { games, source, capturedAt } = await fetchWorldCupOdds({ force });
    console.log(`snapshot: ${games.length} games (${source}) @ ${capturedAt}`);
    if (source === 'cache') console.log('  (used cache — pass --force to spend a quota unit)');
    for (const g of games.slice(0, 6)) {
      console.log(`  ${g.home_team} vs ${g.away_team} @ ${g.commence_time} (${g.bookmakers.length} books)`);
    }
  } catch (e) {
    console.error(`snapshot failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

/** Run only when this module is the process entrypoint (`tsx data/snapshot.ts`). */
export function runIfEntrypoint(argv: string[], moduleUrl: string): void {
  if (argv[1] && fileURLToPath(moduleUrl) === argv[1]) void main(argv);
}

runIfEntrypoint(process.argv, import.meta.url);
