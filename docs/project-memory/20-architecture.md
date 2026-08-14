---
title: Architecture
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/core/run-analyze.ts
  - gitnexus/src/cli/agent-context.ts
  - gitnexus/src/cli/agent-context-plan.ts
  - gitnexus/src/cli/agent-context-apply.ts
update_trigger:
  - Ownership, lifecycle, or data-flow boundaries change
related_paths:
  - gitnexus/src/core/run-analyze.ts
  - gitnexus/src/cli/
related_tests:
  - gitnexus/test/unit/run-analyze.test.ts
  - gitnexus/test/unit/agent-context.test.ts
supersedes: []
---

# Architecture

## Ownership

- `run-analyze.ts`: ingestion, LadybugDB persistence, search indexes, embeddings, repository metadata, registry finalization, and index health. It has no agent-context writer dependency.
- `agent-context-plan.ts`: computes desired tracked context in a temporary staging root and returns content-addressed before/after changes.
- `agent-context-apply.ts`: validates an issued plan, preflights all targets, rejects unsafe paths/conflicts, and applies managed files.
- `agent-context.ts`: validates the absolute Git worktree and healthy index, requires the reviewed plan ID, and holds the worktree writer lock across apply planning and writes.
- `ai-context.ts`: renders the managed `AGENTS.md` block and seven fixed bundled skills.
- `skill-gen.ts`: owns repo-specific `gitnexus-generated-*` skills.

## Independent lifecycles

1. Graph lifecycle: `analyze` or `refresh ensure` updates `.gitnexus/`, metadata, and registry.
2. Fixed context lifecycle: `agent-context plan` then `agent-context apply --expect`.
3. Generated-skill lifecycle: explicit legacy `analyze --skills`, keyed to indexed source commit.

The fixed bundle uses a deterministic SHA-256 content fingerprint. Context rendering is stable across graph-count and target-commit changes unless the actual desired instructions change.
