---
title: Decisions
layer: operational
status: canonical
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/core/run-analyze.ts
  - gitnexus/src/cli/agent-context.ts
  - .github/workflows/release-candidate.yml
  - .github/workflows/publish.yml
  - .github/workflows/docker.yml
update_trigger:
  - A lifecycle decision is accepted or superseded
related_paths:
  - gitnexus/src/core/run-analyze.ts
  - gitnexus/src/cli/agent-context.ts
related_tests:
  - gitnexus/test/unit/agent-context.test.ts
  - gitnexus/test/integration/cli-e2e.test.ts
supersedes: []
---

# Decisions

## D-0001 Separate indexing from tracked context

- Status: accepted
- Date: 2026-08-14

Plain analysis owns graph/index state only. Tracked context requires explicit plan/apply.

Why: index refresh is frequent and automated, while tracked agent policy is team-reviewed. `--skip-agents-md` was insufficient because it did not cover every skill write. A primary-dirty guard alone would preserve hidden writes elsewhere.

Consequences: ordinary refresh cannot dirty agent assets; context updates are a separate review event. Legacy `--skills` remains an explicit compatibility exception.

## D-0002 Use lifecycle-specific freshness

- Status: accepted
- Date: 2026-08-14

Fixed packaged skills use a content fingerprint. Repo-specific generated skills use indexed source commit because their content derives from source analysis.

## D-0003 Require reviewed plan identity

- Status: accepted
- Date: 2026-08-14

Apply requires `--expect <plan-id>`, recomputes desired state under the worktree lock, validates all target snapshots before writing, and refuses drift.

### Verification

- Status: verified
- Evidence: unit/integration tests, full-suite coverage, and the black-box matrix listed in `95-verification-and-runbooks.md`.

## D-0004 Keep registry publication canonical-repository-only

- Status: accepted
- Date: 2026-08-14

RC tags, npm publication, container pushes, signing, and attestations require `github.repository == 'abhigyanpatwari/GitNexus'`. Forks retain PR CI and manual Docker dry-runs; a fork release is an explicit GitHub source release and must not claim npm or container artifacts.

Why: package ownership, trusted publishing, Docker Hub credentials, and documented Cosign identities belong to the canonical repository. Letting the same tag workflow run in a fork creates partial tags and misleading failed releases rather than a usable artifact.
