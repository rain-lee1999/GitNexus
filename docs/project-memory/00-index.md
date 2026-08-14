---
title: Project Memory Index
layer: stable
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - docs/project-memory/
update_trigger:
  - Add, remove, or reclassify a durable memory document
  - Change project-memory routing or precedence
related_paths:
  - docs/project-memory/
related_tests:
  - /Users/rain/.codex/skills/project-memory/scripts/validate_memory.py
supersedes: []
---

# Project Memory Index

## Read protocol

1. Read this index first.
2. Read only the 2-4 files relevant to the current task.
3. Read `sessions/` only for handoff or recent execution context.
4. Code and passing tests outrank memory; unresolved conflicts are `needs-verification`.

## Memory map

| File                              | Layer       | Purpose                                      | Read when                                   | Update trigger                   | Source-of-truth / verification      |
| --------------------------------- | ----------- | -------------------------------------------- | ------------------------------------------- | -------------------------------- | ----------------------------------- |
| `10-product-spec.md`              | stable      | Product behavior and non-goals               | Evaluating intended CLI behavior            | User-visible capability changes  | CLI code + integration tests        |
| `20-architecture.md`              | stable      | Component ownership and lifecycle boundaries | Changing ingestion, context, or persistence | Module/data-flow changes         | Source modules + architecture tests |
| `30-ui-ux-guidelines.md`          | stable      | CLI review/apply interaction                 | Changing command surface or output          | Operator workflow changes        | Commander surface + CLI tests       |
| `40-interfaces-and-protocols.md`  | stable      | Commands, markers, and target contracts      | Integrating with GitNexus CLI/files         | Protocol or schema changes       | Source constants + contract tests   |
| `50-debug-control-plane.md`       | stable      | Diagnosis and safe recovery                  | Unexpected writes or apply refusal          | Debug/recovery changes           | Runbook + black-box tests           |
| `55-telemetry-map.md`             | operational | Local status and diagnostic events           | Inspecting observability/privacy            | Output/status changes            | CLI output tests                    |
| `60-feature-status.md`            | operational | Current capability status                    | Planning or release review                  | Feature verification changes     | Test evidence                       |
| `70-roadmap.md`                   | operational | Committed follow-up only                     | Scoping future work                         | Accepted roadmap changes         | Maintainer decision                 |
| `80-decisions.md`                 | operational | Accepted rationale and rejected alternatives | Revisiting architecture                     | Decision accepted/superseded     | Code + maintainer decision          |
| `90-known-issues.md`              | operational | Compatibility limits                         | Debugging edge behavior                     | Issue status changes             | Reproduction/tests                  |
| `95-verification-and-runbooks.md` | stable      | Required validation matrix                   | Before delivery/release                     | Test or release contract changes | Build/test scripts                  |
| `sessions/`                       | session     | Bounded handoff evidence                     | Resuming a recent task                      | Material task progress           | Session evidence only               |

`last_verified` changes only after re-reading the named source paths and running the relevant verification.
