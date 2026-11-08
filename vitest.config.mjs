import { defineConfig } from 'vitest/config';

// Test discovery mirrors tests/run-node-tests.sh's find-prune denylist
// (same exclusions, same rationale: avoid double-running tests in shared
// worktrees and skip non-source directories). Deliberately a denylist, not
// an allowlist, so future test locations aren't silently skipped.
export default defineConfig({
  test: {
    // Tests that spawn git / shell child processes run past vitest's default
    // 5000ms when the full suite runs alongside parallel bats (CPU saturated),
    // failing with no assertion error. 60000ms is the value measured green
    // under that load; do not shorten it without measuring.
    testTimeout: 60000,
    include: ['**/*.test.mjs'],
    exclude: [
      '**/.git/**',
      '**/node_modules/**',
      '**/.claude/worktrees/**',
    ],
  },
});
