---
title: CLI UX Guidelines
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/index.ts
  - gitnexus/src/cli/agent-context.ts
  - RUNBOOK.md
update_trigger:
  - Command names, options, output, or review flow changes
related_paths:
  - gitnexus/src/cli/index.ts
  - gitnexus/src/cli/agent-context.ts
related_tests:
  - gitnexus/test/unit/cli-index-help.test.ts
  - gitnexus/test/unit/agent-context.test.ts
supersedes: []
---

# CLI UX Guidelines

## Safe default

Users do not need an opt-out flag to protect tracked context: plain `analyze` is safe by default.

## Review/apply flow

1. `agent-context plan` requires an explicit absolute worktree root.
2. Text output shows repository path, SHA-256 plan ID, per-target action, full unified diff, and a no-write statement.
3. The operator reviews the diff and supplies that ID to `apply --expect`.
4. Apply rejects missing/stale IDs and reports written/unchanged counts.
5. A subsequent plan is idempotent and reports no changes.

Machine consumers use `--json`. Status recommends a safe plan first; it does not suggest that ordinary analyze will repair tracked context.

Errors must be actionable and fail closed for unhealthy indexes, malformed markers, symlinks, omitted targets, or concurrent edits.
