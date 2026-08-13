---
name: gitnexus-code-intelligence
description: Use GitNexus MCP when exploring an indexed codebase, tracing a bug, checking blast radius before an edit, reviewing current changes, or performing a graph-aware rename.
---

# GitNexus code intelligence

Use the GitNexus knowledge graph before broad text search when the task depends on call relationships or execution flow.

## Route the task

- Architecture or unfamiliar behavior: `query` for the concept, then `context` on the key symbols. Read the returned process resource when a full trace matters.
- Debugging: `query` the symptom or error, use `context` on the suspect, then inspect its process and source.
- Before editing a shared symbol: call `impact` with `direction: "upstream"`. Review every depth-1 dependent and warn about HIGH or CRITICAL risk.
- Before finishing a change: call `detect_changes` and verify that affected symbols and processes match the intended scope.
- Rename: call `rename` with `dry_run: true`, review graph and text-search edits, then apply only when authorized.

## Repository selection and freshness

Call `list_repos` when the target is ambiguous and pass an absolute worktree path as `repo` on every graph query. The Codex freshness gate rejects an omitted `repo`, because the MCP server cannot safely infer the client worktree. Treat a freshness-gate warning as authoritative, but do not assume refresh is read-only: the gate runs only `refresh status` and never starts or queues a refresh. First inspect `gitnexus refresh status --path <absolute-worktree> --json` and `gitnexus refresh plan --path <absolute-worktree> --json`. `refresh init` / `refresh ensure` can write the worktree's `.gitnexus/`, Git metadata, and `$GITNEXUS_HOME`; run them only with write access to every GitNexus target or after scoped approval, then retry. Add `--install-git-hooks` to plan when that option is intended so each `post-*` wrapper or skipped path is declared. If initialization includes Serena, pass the same `--with-serena`, `--serena-bin`, and `--serena-language` values to plan: it lists GitNexus-known Serena config/lock/project-data paths but marks `writeTargetsComplete: false`, because external language-server/toolchain writes require separate authority. For uncommitted changes, use `detect_changes`; only use `gitnexus refresh ensure --path <absolute-worktree> --force` when a graph query must include new or changed WIP symbols.

Use `cypher` only when the standard tools cannot express the structural question; read `gitnexus://repo/{name}/schema` first.
