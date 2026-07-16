import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    globals: false,
    testTimeout: 20000,
    // Pin a credential-less baseline before any test imports config.ts, so a
    // developer's build/.env.local (real keys) can't leak into the suite.
    setupFiles: ['./test/setup.ts'],
    // handshake/integration tests boot an Express server; keep them serial-safe.
    pool: 'forks',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['engine/**', 'api/**', 'data/**', 'db/**', 'config.ts'],
      // engine/types.ts is a declaration-only module (interfaces/type aliases). It is
      // fully erased by the TS transpiler and emits ZERO runtime statements, so there is
      // nothing executable to cover (v8 records s={}, f={}, b={}). It is excluded here
      // for the same reason as *.d.ts files — a pure type surface, not testable code.
      exclude: ['e2e/**', 'scripts/**', 'test/**', 'fixtures/**', '**/*.d.ts', 'engine/types.ts'],
    },
  },
});
