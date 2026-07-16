/**
 * Coverage completion for config.ts: the explorer URL helpers (both the
 * explicit-network and default-network branches), the PATHS lazy path
 * builders, and the two env-driven branches (mainnet selection +
 * HAS_REAL_OKX_CREDS) exercised via an isolated module reload.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  explorerTx, explorerAddress, PATHS, NETWORKS, ACTIVE_NETWORK, HAS_REAL_OKX_CREDS,
} from '../config';

describe('config.ts — explorer helpers + PATHS builders', () => {
  it('explorerTx / explorerAddress use the active network by default and honor an explicit one', () => {
    expect(explorerTx('0xdeadbeef')).toContain(NETWORKS[ACTIVE_NETWORK].explorer);
    expect(explorerTx('0xdeadbeef')).toContain('/tx/0xdeadbeef');
    expect(explorerTx('0xabc', 'mainnet')).toContain(NETWORKS.mainnet.explorer);
    expect(explorerAddress('0x1111')).toContain('/address/0x1111');
    expect(explorerAddress('0x1111', 'rehearsal')).toContain(NETWORKS.rehearsal.explorer);
  });

  it('PATHS lazy builders resolve to the fixtures directory', () => {
    expect(PATHS.nextPick()).toMatch(/fixtures\/next-pick\.json$/);
    expect(PATHS.bench()).toMatch(/fixtures\/bench\.json$/);
  });

  it('HAS_REAL_OKX_CREDS is false in the default (credential-less) test env', () => {
    expect(HAS_REAL_OKX_CREDS).toBe(false);
  });
});

describe('config.ts — env-driven branches via isolated reload', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('X402_NETWORK=eip155:196 selects the X Layer mainnet + creds flip HAS_REAL_OKX_CREDS on', async () => {
    vi.resetModules();
    vi.stubEnv('X402_NETWORK', 'eip155:196');
    vi.stubEnv('OKX_API_KEY', 'k');
    vi.stubEnv('OKX_SECRET_KEY', 's');
    vi.stubEnv('OKX_PASSPHRASE', 'p');
    vi.stubEnv('PAYTO_ADDRESS', '0x00000000000000000000000000000000000000ff');
    vi.stubEnv('EDGELEDGER_PRICE_UNITS', '60000');
    vi.stubEnv('PORT', '9999');
    vi.stubEnv('EDGELEDGER_API_URL', 'http://example.test');
    vi.stubEnv('EDGELEDGER_DECAY_HALFLIFE_MIN', '45');
    vi.stubEnv('PAY_RAIL', 'okx');
    vi.stubEnv('FOOTBALL_DATA_KEY', 'fk');
    vi.stubEnv('ODDS_API_KEY', 'ok');
    const mod = await import('../config');
    expect(mod.ACTIVE_NETWORK).toBe('mainnet');
    expect(mod.NET.chainId).toBe(196);
    expect(mod.HAS_REAL_OKX_CREDS).toBe(true);
    expect(mod.PRICE_UNITS).toBe('60000');
    expect(mod.PORT).toBe(9999);
    expect(mod.DECAY_HALFLIFE_MIN).toBe(45);
    expect(mod.explorerTx('0xaa')).toContain(mod.NETWORKS.mainnet.explorer);
  });
});
