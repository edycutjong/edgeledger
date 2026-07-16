/**
 * Coverage completion for api/server.ts: the CORS OPTIONS pre-flight branch,
 * the GET /api index route, and the main()/runIfEntrypoint bootstrap (started
 * on the real port, then closed). Console output is silenced during boot.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApp, main, runIfEntrypoint } from '../api/server';
import { resetDbForTests } from '../api/routes';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = createApp({ demo: true });
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
  resetDbForTests(null);
});

function closeServer(s: Server): Promise<void> {
  return new Promise((resolve) => s.close(() => resolve()));
}

/** Resolve once the server is listening AND its listen callback has flushed. */
function booted(s: Server): Promise<void> {
  return new Promise((resolve) => {
    const done = () => setTimeout(resolve, 60); // let the listen callback (logs) run
    if (s.listening) done();
    else s.once('listening', done);
  });
}

describe('api/server — CORS pre-flight + index route', () => {
  it('an OPTIONS pre-flight is answered 204 with CORS headers', async () => {
    const res = await fetch(`${base}/api/edge`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
  });

  it('GET /api returns the service index', async () => {
    const res = await fetch(`${base}/api`, { method: 'GET' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.service).toBe('edgeledger-okx-api');
    expect(body.see).toContain('/health');
  });
});

describe('api/server — main() + runIfEntrypoint bootstrap', () => {
  afterEach(() => resetDbForTests(null));

  it('main() boots a live listener (default + --demo argv variants)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const s1 = main(['node', 'server.ts']);
    await booted(s1);
    await closeServer(s1);

    const s2 = main(['node', 'server.ts', '--demo']);
    await booted(s2);
    await closeServer(s2);

    expect(logSpy).toHaveBeenCalled(); // covers the listen-callback body (default + --demo)
    logSpy.mockRestore();
  });

  it('runIfEntrypoint boots only when argv[1] matches the module URL', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const url = 'file:///virtual/server.ts';

    // false branch — argv[1] mismatch → no server
    expect(runIfEntrypoint(['node', '/other/file.ts'], url)).toBeUndefined();

    // true branch — argv[1] equals the module path → returns a live server
    const s = runIfEntrypoint(['node', fileURLToPath(url)], url);
    expect(s).toBeDefined();
    await booted(s!);
    await closeServer(s!);
    logSpy.mockRestore();
  });
});
