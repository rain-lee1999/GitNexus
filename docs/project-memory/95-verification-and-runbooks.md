---
title: Verification and Runbooks
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/package.json
  - gitnexus/test/
update_trigger:
  - Build, test, or black-box acceptance gates change
related_paths:
  - gitnexus/package.json
  - gitnexus/test/
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/integration/cli-e2e.test.ts
supersedes: []
---

# Verification and Runbooks

Required for analyze/context boundary changes:

1. `cd gitnexus && git diff --check`
2. `cd gitnexus && npx tsc --noEmit`
3. `cd gitnexus && npm run build`
4. Run unit tests for run-analyze, ai-context, agent-context, status, CLI help, and skip-git.
5. Run CLI integration tests proving plain analyze leaves existing agent assets byte-identical.
6. Black-box plan/apply matrix:
   - plan writes no target files;
   - apply writes only declared targets;
   - second plan is unchanged;
   - wrong plan ID, concurrent edits, malformed markers, and symlinks fail closed;
   - fixed-skill fingerprint survives a target source-commit change.
7. Run the complete test suite; classify any reproduced pre-existing environment failure separately.
8. Run GitNexus `detect_changes` before commit.

Use isolated `HOME` and `GITNEXUS_HOME` for black-box tests. Snapshot tracked and untracked repository paths before/after; do not infer no side effect from exit status alone.
