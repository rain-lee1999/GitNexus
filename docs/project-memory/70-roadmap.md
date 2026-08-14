---
title: Roadmap
layer: operational
status: active
last_updated: 2026-08-14
last_verified: 2026-08-14
owners:
  - repository maintainers
source_of_truth:
  - gitnexus/src/cli/analyze.ts
  - gitnexus/src/cli/skill-gen.ts
update_trigger:
  - A follow-up migration is accepted, deferred, or dropped
related_paths:
  - gitnexus/src/cli/analyze.ts
  - gitnexus/src/cli/skill-gen.ts
related_tests:
  - gitnexus/test/unit/skip-git-cli.test.ts
supersedes: []
---

# Roadmap

No additional migration is committed by this architecture change.

The legacy explicit `analyze --skills` path remains supported because repo-specific skill generation currently consumes the in-memory analysis result. Moving it behind a separate command requires an independently accepted design and demonstrated user need. Do not introduce a second implicit path or automatic fallback meanwhile.
