# GitNexus Codex plugin

This directory is a self-contained local Codex marketplace and plugin bundle. It packages the pinned GitNexus stdio MCP server, a graph-aware workflow skill, and narrowly scoped Codex hooks using the current Codex hook schema.

## Install from this repository

```bash
codex plugin marketplace add ./gitnexus/codex-plugin --json
codex plugin add gitnexus@gitnexus --json
```

For an installed npm package, resolve its package root and add the bundled `codex-plugin` directory:

```bash
PACKAGE_ROOT="$(node -p "require('path').dirname(require.resolve('gitnexus/package.json'))")"
codex plugin marketplace add "$PACKAGE_ROOT/codex-plugin" --json
codex plugin add gitnexus@gitnexus --json
```

Restart Codex after installation. Open `/hooks` to review and trust the plugin hooks; Codex intentionally skips new or changed non-managed hooks until they are trusted. Do not use `--dangerously-bypass-hook-trust` for normal development.

## What the hooks do

The plugin has two intentionally separate paths:

- The `^Bash$` hooks preserve the advisory search integration. They enrich only `rg`/`grep` calls, and after a successful `git commit`, `merge`, `rebase`, `cherry-pick`, `pull`, or `reset` they run only `gitnexus refresh mark --path <worktree>`. They never block a shell command and never run `ensure` or `analyze`.
- The graph-query gate matches only these read-only MCP tools: `query`, `cypher`, `context`, `impact`, `route_map`, `tool_map`, `shape_check`, and `api_impact`. Its actual matcher is `^mcp__gitnexus__(query|cypher|context|impact|route_map|tool_map|shape_check|api_impact)$`; it does not match `detect_changes`, `list_repos`, `group_list`, `rename`, `group_sync`, or arbitrary MCP tools.

Before a matched graph query, the gate requires `repo` as an absolute worktree path. It deliberately refuses an omitted path or a registry alias, because the MCP server cannot infer a Codex client's worktree safely when several repositories are indexed. It then runs `gitnexus refresh status --json` for that worktree. A fresh result is allowed. A missing, stale, unhealthy, or unverifiable result is denied and asks the coordinator to queue a deduplicated background `ensure`; retry when it completes, or run `ensure` directly to wait. The hook itself never runs an index rebuild.

The hooks invoke an already-installed GitNexus CLI: set `GITNEXUS_CLI` to an absolute executable path to override it, or keep `gitnexus` on `PATH`. They never use a plugin-cache `dist` path, `npx`, or a package download.

`detect_changes` stays available while a worktree is dirty or stale: it maps diffs against the last committed graph and is the correct tool for WIP review.

## Initialize each worktree

Initialize every worktree independently, including the primary checkout:

```bash
gitnexus refresh init --path "$(git rev-parse --show-toplevel)"
gitnexus refresh ensure --path "$(git rev-parse --show-toplevel)"
```

`init` records an identity for that exact worktree. In a primary checkout using the conventional hooks directory, add `--install-git-hooks` to install non-overwriting wrappers for `post-commit`, `post-merge`, `post-rewrite`, and branch `post-checkout`. The wrappers use the bundled [Git hook template](hooks/gitnexus-git-hook.cjs) to write a stale marker only. Linked worktrees share the primary checkout's hook directory, so GitNexus deliberately skips automatic installation there. Existing Husky or other `core.hooksPath` dispatchers are also left untouched; add the template manually if needed.

### Optional Serena prewarm

Serena setup is worktree-specific and non-interactive. Pass every intended LSP language explicitly:

```bash
gitnexus refresh init --path "$(git rev-parse --show-toplevel)" \
  --with-serena \
  --serena-bin /absolute/path/to/serena \
  --serena-language typescript \
  --serena-language python
```

`--with-serena` requires at least one repeatable `--serena-language <language>` option, and `--serena-language` cannot be used alone. GitNexus runs `serena project index <worktree> --language <language> ...` under a single global Serena lock, so concurrent worktree initialization cannot race. You may provide the executable through `GITNEXUS_SERENA_BIN` instead of `--serena-bin`.

For a normal refresh, run:

```bash
gitnexus refresh status --path "$(git rev-parse --show-toplevel)" --json
gitnexus refresh ensure --path "$(git rev-parse --show-toplevel)"
```

Use `gitnexus refresh ensure --path <worktree> --force` only when a graph query must include uncommitted new or changed symbols. Ordinary WIP should use `detect_changes` instead.

When several worktrees are active, each has its own `.gitnexus` graph and analysis lock. Automatic `refresh ensure` uses sequential Tree-sitter parsing deliberately: it avoids `worker_threads` teardown hazards in native parser bindings, while a direct `gitnexus analyze` still uses its parallel worker default. Always pass the absolute worktree path as `repo` for every gated graph query; that lets the gate check the right index without relying on an ambiguous registry alias. The gate never accepts an alias.

The stale marker and query gate are coordination controls, not an implicit filesystem watcher. The gate may queue a demand-driven coordinator refresh; the coordinator serializes writers, while Git hooks only mark history changes.

The bundled MCP server is stdio-based and needs Node.js 20 or newer. Its package version is pinned to the plugin version for reproducible installation.
