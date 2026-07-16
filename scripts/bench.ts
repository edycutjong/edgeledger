/**
 * bench.ts — latency of the x402 402-quote path, N=20, p50/p95.
 *
 *   npm run bench            # boots the app in-process, times 20 quote round-trips
 *
 * The 402-quote timing is real and needs no funds. Facilitator-confirm / total
 * paid-call timings are FUNDS-GATED and reported as N/A until the wallet is
 * gassed (then `paid-call-smoke.ts` fills them in). Writes fixtures/bench.json
 * for /api/verify + the README table.
 */
import fs from 'node:fs';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp } from '../api/server';
import { PATHS } from '../config';

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function main(): Promise<void> {
  const N = Number(process.argv[process.argv.indexOf('--n') + 1]) || 20;
  const app = createApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/api/edge`;

  // warmup
  await fetch(url, { method: 'POST' }).then((r) => r.arrayBuffer());

  const quoteTimes: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const res = await fetch(url, { method: 'POST' });
    await res.arrayBuffer();
    const dt = performance.now() - t0;
    if (res.status === 402) quoteTimes.push(dt);
  }
  server.close();

  quoteTimes.sort((a, b) => a - b);
  const result = {
    generated_at: new Date().toISOString(),
    samples: quoteTimes.length,
    quote_ms: {
      p50: round(pct(quoteTimes, 50)),
      p95: round(pct(quoteTimes, 95)),
      min: round(quoteTimes[0]),
      max: round(quoteTimes[quoteTimes.length - 1]),
    },
    facilitator_confirm_ms: null, // FUNDS-GATED
    total_paid_ms: null, // FUNDS-GATED
    note: 'quote_ms is the real unpaid 402 round-trip (in-process). Confirm/total are funds-gated — see DEMO.md.',
  };
  fs.writeFileSync(PATHS.bench(), JSON.stringify(result, null, 2));

  console.log(`bench: ${result.samples} quote round-trips`);
  console.log(`  402-quote  p50 ${result.quote_ms.p50}ms · p95 ${result.quote_ms.p95}ms (min ${result.quote_ms.min} / max ${result.quote_ms.max})`);
  console.log(`  facilitator-confirm: N/A (funds-gated) · total paid: N/A (funds-gated)`);
  console.log(`  wrote ${PATHS.bench()}`);
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
