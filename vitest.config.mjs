import { defineConfig } from 'vitest/config';

// Test discovery mirrors tests/run-node-tests.sh's find-prune denylist
// (same exclusions, same rationale: avoid double-running tests in shared
// worktrees and skip non-source directories). Deliberately a denylist, not
// an allowlist, so future test locations aren't silently skipped.
export default defineConfig({
  test: {
    include: ['**/*.test.mjs'],
    exclude: [
      '**/.git/**',
      '**/node_modules/**',
      '**/.claude/worktrees/**',
    ],
  },
});
