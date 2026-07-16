import { describe, it, expect } from 'vitest';
import { canonicalize, pickHash, sha256Hex, verifyPickHash } from '../engine/hash';
import { buildPick } from '../engine/index';

describe('pick-commit hashing (I2)', () => {
  it('canonicalize sorts keys at every depth (order-independent)', () => {
    const a = { b: 1, a: { z: 2, y: [3, { q: 4, p: 5 }] } };
    const b = { a: { y: [3, { p: 5, q: 4 }], z: 2 }, b: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });

  it('pickHash is stable across key reordering', () => {
    const p1 = { fixture: 'A', model_prob: 0.5, side: 'HOME' };
    const p2 = { side: 'HOME', fixture: 'A', model_prob: 0.5 };
    expect(pickHash(p1)).toBe(pickHash(p2));
  });

  it('different picks hash differently', () => {
    expect(pickHash({ x: 1 })).not.toBe(pickHash({ x: 2 }));
  });

  it('sha256Hex is 64 hex chars', () => {
    expect(sha256Hex('hello')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('a built pick re-hashes to its committed hash from raw JSON (auditor path)', () => {
    const { pick, pick_hash } = buildPick({
      fixture: 'SF: FRA vs ESP',
      competition: 'FIFA World Cup 2026',
      kickoff_utc: '2026-07-14T19:00:00Z',
      side: 'HOME',
      side_label: 'France ML',
      model_prob: 0.58,
      market_odds: 2.17,
      issued_at: '2026-07-12T09:00:00Z',
    });
    const rawJson = JSON.stringify(pick);
    const v = verifyPickHash(rawJson, pick_hash);
    expect(v.ok).toBe(true);
    expect(v.actual).toBe(pick_hash);
  });

  it('tampering with served JSON is detected', () => {
    const { pick, pick_hash } = buildPick({
      fixture: 'SF: FRA vs ESP',
      competition: 'FIFA World Cup 2026',
      kickoff_utc: '2026-07-14T19:00:00Z',
      side: 'HOME',
      side_label: 'France ML',
      model_prob: 0.58,
      market_odds: 2.17,
      issued_at: '2026-07-12T09:00:00Z',
    });
    const tampered = { ...pick, model_prob: 0.99 };
    const v = verifyPickHash(JSON.stringify(tampered), pick_hash);
    expect(v.ok).toBe(false);
  });

  it('buildPick is deterministic given the same input', () => {
    const input = {
      fixture: 'F: ARG vs FRA',
      competition: 'FIFA World Cup 2026',
      kickoff_utc: '2026-07-19T19:00:00Z',
      side: 'HOME' as const,
      side_label: 'Argentina ML',
      model_prob: 0.5123456,
      market_odds: 2.05,
      issued_at: '2026-07-19T09:00:00Z',
    };
    expect(buildPick(input).pick_hash).toBe(buildPick(input).pick_hash);
  });
});
