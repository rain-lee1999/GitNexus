---
title: Telemetry Map
layer: operational
status: active
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/agent-context.ts
  - gitnexus/src/cli/status.ts
update_trigger:
  - Operator-visible output or freshness diagnostics change
related_paths:
  - gitnexus/src/cli/agent-context.ts
  - gitnexus/src/cli/status.ts
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/unit/status-enrichment.test.ts
supersedes: []
---

# Telemetry Map

This lifecycle adds no remote telemetry. Observable local output is:

| Surface                | Event/data                                                          | Retention       |
| ---------------------- | ------------------------------------------------------------------- | --------------- |
| `agent-context plan`   | Repository path, plan ID, actions, full diff, no-write statement    | Terminal only   |
| `agent-context apply`  | Repository path, plan ID in JSON, written/unchanged paths or counts | Terminal only   |
| `status`               | Separate AGENTS, fixed-skill, and generated-skill freshness         | Terminal only   |
| Fixed-skill marker     | SHA-256 fingerprint of packaged fixed-skill content                 | Repository file |
| Generated-skill marker | Indexed source commit                                               | Repository file |

Plan output intentionally contains tracked file contents because the operator requested a review diff. Logs and status must not expose credentials, tokens, or unrelated repository contents.
