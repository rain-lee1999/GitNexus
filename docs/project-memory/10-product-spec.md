---
title: Product Specification
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/index.ts
  - gitnexus/src/cli/analyze.ts
  - gitnexus/src/cli/agent-context.ts
update_trigger:
  - User-visible analyze or agent-context behavior changes
related_paths:
  - gitnexus/src/cli/
  - gitnexus/src/core/run-analyze.ts
related_tests:
  - gitnexus/test/integration/cli-e2e.test.ts
  - gitnexus/test/unit/agent-context.test.ts
supersedes: []
---

# Product Specification

GitNexus indexes a repository into local graph state and can separately materialize repository-local instructions for coding agents.

## Required behavior

- Plain `gitnexus analyze` updates graph/index state, metadata, registry state, applicable Git exclude metadata, and GitNexus home state. It leaves `AGENTS.md` and `.agents/skills/**` byte-identical.
- `gitnexus agent-context plan --path <absolute-worktree>` shows every managed target and diff without modifying the target repository.
- `gitnexus agent-context apply --path <absolute-worktree> --expect <plan-id>` writes only the reviewed current plan and refuses drift.
- Managed `AGENTS.md` output excludes volatile graph statistics.
- Fixed skills refresh when packaged skill content changes, not whenever target source code commits change.
- Repo-specific generated skills remain available through the explicit compatibility command `analyze --skills`.

## Non-goals

- Context commands do not bootstrap or repair an index.
- Plain analyze does not infer whether tracked team policy should be rewritten.
- The compatibility `--skills` path is not silently invoked by refresh, update, or MCP operations.
