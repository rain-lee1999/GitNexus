---
title: Feature Status
layer: operational
status: active
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/
  - gitnexus/src/core/run-analyze.ts
  - .github/workflows/release-candidate.yml
  - .github/workflows/publish.yml
  - .github/workflows/docker.yml
update_trigger:
  - Feature implementation or verification status changes
related_paths:
  - gitnexus/src/cli/
  - gitnexus/src/core/run-analyze.ts
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/integration/cli-e2e.test.ts
supersedes: []
---

# Feature Status

| Feature                          | Status      | Verification | Evidence                                   | Notes                                               |
| -------------------------------- | ----------- | ------------ | ------------------------------------------ | --------------------------------------------------- |
| Safe-by-default plain analyze    | implemented | verified     | `run-analyze.test.ts`, `cli-e2e.test.ts`   | Full asset-tree and linked-install black boxes pass |
| Read-only agent-context planning | implemented | verified     | `agent-context.test.ts`, `cli-e2e.test.ts` | Target repo stays unchanged                         |
| Reviewed conflict-checked apply  | implemented | verified     | `agent-context.test.ts`, `cli-e2e.test.ts` | `--expect` mandatory; apply recomputes under lock   |
| Stable managed AGENTS block      | implemented | verified     | `ai-context.test.ts`                       | No volatile graph counts                            |
| Fixed-skill bundle fingerprint   | implemented | verified     | `status-enrichment.test.ts`                | Independent from source commit                      |
| Legacy generated skills          | implemented | verified     | `skill-gen.test.ts`, compatibility tests   | Explicit compatibility write path                   |
| Fork-safe registry publication   | implemented | verified     | actionlint, truth-table, release black box | Fork releases are GitHub-source-only                 |
