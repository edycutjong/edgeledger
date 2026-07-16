import { vi } from 'vitest';

// Hermetic test baseline.
//
// config.ts loads build/.env.local via dotenv so the real API/server picks up
// credentials. During tests that file (or exported shell vars) must NOT leak in,
// or the suite stops being deterministic: the "credential-less" facilitator/data
// tests would see live keys, and config's `?? default` branches would never take
// their default arm. Tests that exercise the live / real-credentials branches opt
// in explicitly via vi.stubEnv(...) + vi.resetModules() + a fresh import.
//
// Two fronts:
//   1. Mock dotenv so config.ts's loadEnv() still runs (staying covered) but never
//      reads .env.local into process.env — reproducing the pristine CI environment.
//   2. delete() any of these keys a developer may have EXPORTED into the shell, so
//      the values stay UNSET (not '') and config's `?? default` arms are exercised.
vi.mock('dotenv', () => {
  const config = () => ({ parsed: {} });
  return { config, default: { config } };
});

for (const key of [
  'OKX_API_KEY',
  'OKX_SECRET_KEY',
  'OKX_PASSPHRASE',
  'FOOTBALL_DATA_KEY',
  'ODDS_API_KEY',
  'PAY_RAIL',
  'PAYTO_ADDRESS',
  'X402_NETWORK',
]) {
  delete process.env[key];
}
