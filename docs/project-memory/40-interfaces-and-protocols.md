---
title: Interfaces and Protocols
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/index.ts
  - gitnexus/src/cli/ai-context.ts
  - gitnexus/src/cli/agent-context-plan.ts
  - gitnexus/src/cli/agent-context-apply.ts
update_trigger:
  - CLI contract, marker schema, target list, or plan schema changes
related_paths:
  - gitnexus/src/cli/
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/unit/status-enrichment.test.ts
supersedes: []
---

# Interfaces and Protocols

## Commands

- `gitnexus analyze [path]`: graph/index operation; no tracked agent writes unless explicit `--skills` is present.
- `gitnexus analyze --index-only`: deprecated compatibility alias with the same tracked-context boundary as the default.
- `gitnexus agent-context plan --path <absolute-worktree> [--name <display-name>] [--json]`: target-repository read-only plan.
- `gitnexus agent-context apply --path <absolute-worktree> --expect <plan-id> [--name <display-name>] [--json]`: explicit write; `--expect` is mandatory.

## Managed targets

- `AGENTS.md`: exactly one ordered managed block.
- Seven `.agents/skills/gitnexus-*/SKILL.md` fixed-skill files.
- `.agents/skills/.gitnexus-managed-commit`: compatibility filename containing `sha256:<bundle-digest>`.

Context schema marker: `<!-- gitnexus:context-version:2 -->`.

Duplicate, half-present, reversed, or inline-only markers do not form a valid managed block. Symlinked targets or ancestors are rejected. Plan ID hashes repository root, display name, and each target's before/after hashes.

Repo-specific `gitnexus-generated-*` and `.gitnexus-generated-commit` remain commit-fresh and are owned by explicit `analyze --skills`.
