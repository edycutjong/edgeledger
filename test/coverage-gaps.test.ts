/**
 * Coverage completion for api/server.ts:
 *   - lines 98-99: the GET /api/edge `queryAsBody` wrapper. In demo mode the
 *     pay gate is absent, so a GET reaches the wrapper directly (an unpaid GET
 *     in gated mode is answered by the gate and never gets here).
 *   - line 81: the `catch` fall-through in the /api/edge res.json override,
 *     which only runs if the base64 PAYMENT-REQUIRED header fails to JSON.parse.
 *     The server never emits a malformed header, so we force that single parse
 *     to throw (scoped to the challenge string) on a real gated 402.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Server } from 'node:http';
import { createApp } from '../api/server';
import { resetDbForTests } from '../api/routes';

let demoServer: Server;
let gateServer: Server;
let demoBase: string;
let gateBase: string;

function listen(app: import('express').Express): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

beforeAll(async () => {
  ({ server: demoServer, base: demoBase } = await listen(createApp({ demo: true })));
  ({ server: gateServer, base: gateBase } = await listen(createApp({ demo: false })));
});

afterAll(() => {
  demoServer?.close();
  gateServer?.close();
  resetDbForTests(null);
});

describe('server.ts — GET /api/edge queryAsBody wrapper (demo mode, no gate)', () => {
  it('a GET /api/edge hydrates req.body from the query and reaches edgeHandler', async () => {
    const res = await fetch(`${demoBase}/api/edge`, { method: 'GET' });
    // No fixture in the query → edgeHandler answers 200 with the usage example.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { service: string };
    expect(body.service).toBe('EdgeLedger Verdict');
  });
});

describe('server.ts — res.json override catch fall-through on a gated 402', () => {
  it('falls through to the SDK body when the PAYMENT-REQUIRED header fails to parse', async () => {
    const realParse = JSON.parse.bind(JSON);
    const spy = vi.spyOn(JSON, 'parse').mockImplementation(((text: string, ...rest: unknown[]) => {
      // Only sabotage the override's decode of the challenge header; let every
      // other JSON.parse (body-parser, etc.) behave normally.
      if (typeof text === 'string' && text.includes('"accepts"')) throw new SyntaxError('forced');
      // @ts-expect-error passthrough to the real implementation
      return realParse(text, ...rest);
    }) as typeof JSON.parse);

    try {
      const res = await fetch(`${gateBase}/api/edge`, { method: 'GET' });
      expect(res.status).toBe(402); // gate still answers; override caught the parse error
    } finally {
      spy.mockRestore();
    }
  });
});
