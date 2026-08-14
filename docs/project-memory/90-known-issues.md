---
title: Known Issues
layer: operational
status: active
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/ai-context.ts
  - gitnexus/src/cli/agent-context.ts
update_trigger:
  - Compatibility limits or lifecycle defects change
related_paths:
  - gitnexus/src/cli/ai-context.ts
  - gitnexus/src/cli/agent-context.ts
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/unit/status-enrichment.test.ts
supersedes: []
---

# Known Issues

## KI-001 Legacy marker filename

- Status: open
- `.agents/skills/.gitnexus-managed-commit` is retained for compatibility, but its value is now `sha256:<digest>`, not a Git commit.

## KI-002 Legacy explicit generated-skill path

- Status: open
- `analyze --skills` may update generated skills, fixed skills, and the managed AGENTS block. Plain analyze does not.

## KI-003 Existing healthy index required

- Status: open
- `agent-context` does not bootstrap or repair graph state and rejects a missing/unhealthy index.

## KI-004 Cooperative concurrency boundary

- Status: open
- Apply serializes GitNexus writers and validates before-content snapshots. Node's path-based filesystem API does not provide a compare-and-swap rename: a hostile, non-cooperating process can still replace an ancestor with a symlink or edit a target in the final check/rename window. Treat apply as a trusted-checkout coordination boundary, not a hostile-filesystem security boundary. Re-running plan/apply converges and the marker is written last.

## KI-005 AGENTS status is schema freshness, not a content proof

- Status: open
- `gitnexus status` treats a well-paired, current-version managed AGENTS block as current. Custom `--name` values or manual edits inside that block are not content-hashed by status; `gitnexus agent-context plan` is the authoritative desired-content comparison.

## KI-006 Legacy `analyze --skills` is not a reviewed transaction

- Status: open
- The explicit compatibility path updates generated skills and managed context across multiple files. An I/O or malformed-context failure may leave a partial update; inspect `gitnexus status`, repair the input, and rerun it. Use `agent-context plan/apply` when a reviewed fixed-context transaction is required.
