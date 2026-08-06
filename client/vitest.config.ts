import { defineConfig } from 'vitest/config';

// Single vitest config drives tests for both the client and the server's
// pure-logic modules (RoomManager). All suites run in Node; no DOM required.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', '../server/src/**/*.test.ts'],
  },
});
