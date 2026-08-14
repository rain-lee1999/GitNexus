---
title: Debug Control Plane
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/status.ts
  - RUNBOOK.md
update_trigger:
  - Diagnosis, health-gate, or recovery behavior changes
related_paths:
  - gitnexus/src/cli/status.ts
  - gitnexus/src/cli/agent-context.ts
related_tests:
  - gitnexus/test/unit/status-enrichment.test.ts
  - gitnexus/test/unit/status-health.test.ts
supersedes: []
---

# Debug Control Plane

## Unexpected tracked writes

1. Record `git status --short` and byte hashes of existing `AGENTS.md` / `.agents/skills/**`.
2. Resolve the active executable and source checkout; never infer live behavior from a different checkout.
3. Reproduce with isolated `HOME`, `GITNEXUS_HOME`, and a temporary Git fixture.
4. Run plain `analyze`; expected tracked delta is zero.
5. If `--skills` was supplied, classify the write as explicit compatibility behavior. Otherwise it is a regression.

## Context apply refusal

- Plan mismatch: rerun plan; desired state or a target changed.
- Missing/unhealthy index: repair graph state first; do not bypass health checks.
- Malformed managed block: repair or remove it manually, then re-plan.
- Symlinked path: replace it with an in-repository regular path.
- Concurrent edit: preserve the human edit and re-plan.

Do not use reset, restore, stash, or clean while diagnosing a checkout with unrelated user changes.
