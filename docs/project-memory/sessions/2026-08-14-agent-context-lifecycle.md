---
title: Agent Context Lifecycle Handoff
layer: session
status: active
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/agent-context.ts
  - gitnexus/src/core/run-analyze.ts
update_trigger:
  - Final verification or delivery outcome changes
related_paths:
  - gitnexus/src/cli/
  - docs/project-memory/
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/integration/cli-e2e.test.ts
supersedes: []
---

# Agent Context Lifecycle Handoff

## Task Summary

Separate frequent graph indexing from reviewable tracked agent-context writes.

## Assumptions

- Tracked `AGENTS.md` and `.agents/skills/**` are team policy/artifacts, not an indexing cache.
- Legacy `analyze --skills` remains an explicit compatibility operation.

## Key Findings

- Plain analysis previously invoked context generation from `runFullAnalysis`.
- `--skip-agents-md` did not represent a complete zero-write guarantee for skills.
- Fixed skills and generated skills require different freshness keys.

## Files Changed

Source, tests, root documentation, packaged skills, and this project-memory tree are updated around the new lifecycle.

## Tests / Verification

Targeted unit/integration tests, build, typecheck, full-suite coverage, project-memory validation, linked-install validation, and black-box side-effect matrices passed. One pre-existing environment-dependent doctor test still fails when its own fixture clears `PATH`; the base file contains the same condition.

## Unresolved Questions

None in the accepted command contract. Any future removal of legacy `analyze --skills` requires a separate decision.

## Handoff Notes

The final side-effect matrix, full test coverage, `detect_changes`, package-source fingerprint comparison, and Git tracked-file verification are delivery gates for future lifecycle changes.

## Memory Changes

Bootstrapped canonical project memory for architecture, protocol, UX, diagnostics, status, decisions, known issues, and verification.
