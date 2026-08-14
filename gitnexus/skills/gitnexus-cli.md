---
name: gitnexus-cli
description: 'Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"'
---

# GitNexus CLI Commands

All commands work via `npx` — no global install required.

## Commands

### analyze — Build or refresh the graph index

```bash
npx gitnexus analyze
```

Run from the project root. This parses source files, builds the knowledge graph, writes it to `.gitnexus/`, and updates registry state. Plain `analyze` never writes `AGENTS.md` or `.agents/skills/`.

| Flag                | Effect                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `--force`           | Force full re-index even if up to date                                                               |
| `--embeddings`      | Enable embedding generation for semantic search (off by default)                                     |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |
| `--skills`          | Legacy explicit write path: generate functional-area skills and refresh managed context              |
| `--skip-agents-md`  | Legacy `--skills` only: leave the managed GitNexus section in `AGENTS.md` unchanged                  |
| `--index-only`      | Deprecated compatibility alias; plain `analyze` already leaves tracked agent assets unchanged        |

**When to run:** To build or repair the graph, generate embeddings, or intentionally use the legacy `--skills` write path. `refresh ensure` below can bootstrap the first graph index and handles normal staleness. The Codex hooks mark Git-history drift and gate stale graph queries; they never run `analyze` directly.

### agent-context — Review and explicitly apply tracked context

```bash
gitnexus agent-context plan --path /absolute/path/to/worktree
gitnexus agent-context apply --path /absolute/path/to/worktree --expect <plan-id>
```

`plan` reads the current index and repository assets, prints a full diff plus a plan ID, and writes no repository files. `apply --expect <plan-id>` is the normal reviewed command that updates the managed `AGENTS.md` block and the seven fixed `.agents/skills/gitnexus-*` files. The legacy explicit `analyze --skills` compatibility path may update the same managed assets while generating repo-specific skills. Managed skills are fingerprinted by their bundled content, not by the indexed source commit; repo-specific `gitnexus-generated-*` skills remain commit-freshness scoped.

### refresh — Worktree-safe graph freshness

```bash
# Read-only preflight. This does not create refresh state.
gitnexus refresh status --path /absolute/path/to/worktree
gitnexus refresh plan --path /absolute/path/to/worktree

# Only after every target in the plan is writable (or has scoped approval),
# run once per worktree; optional managed Git hooks only mark it stale.
gitnexus refresh init --path /absolute/path/to/worktree --install-git-hooks

# Normal refresh: one writer per worktree, graph + registry only.
gitnexus refresh ensure --path /absolute/path/to/worktree

```

`refresh plan` lists GitNexus-owned write targets. Pass `--install-git-hooks` to plan when needed so it declares each managed `post-*` wrapper or an explicit skip. `refresh init` / `refresh ensure` write the worktree `.gitnexus/`, applicable Git metadata, and `GITNEXUS_HOME` (global registry and locks). For `--with-serena`, the plan lists GitNexus-known Serena paths but reports `writeTargetsComplete: false`: external language servers/toolchains may write environment-specific caches or install paths, requiring separate authority. `refresh ensure` uses the compatibility `analyze --index-only` path and never updates `AGENTS.md` or `.agents/skills/`, but it is not read-only. It can bootstrap the first graph index. If every planned GitNexus target (and the disclosed external Serena scope, if enabled) is not authorized, report the missing paths and use stale graph results only with a warning, `detect_changes`, and source inspection. In a multi-worktree Codex session, freshness-gated graph tools (`query`, `cypher`, `context`, `impact`, `route_map`, `tool_map`, `shape_check`, and `api_impact`) require `repo` as the absolute worktree path; the Codex gate rejects aliases and never starts a refresh. `detect_changes` is not freshness-gated.

For Serena prewarm, pass the same `--with-serena`, `--serena-bin`, and `--serena-language` values to `refresh plan` first. That read-only plan additionally declares Serena's global config/lock and the resolved project-data directory.

### setup / doctor codex — Install and verify Codex integration

```bash
npx gitnexus setup
npx gitnexus doctor codex
```

`setup` installs the version-pinned Codex plugin plus seven detailed skills. Use `--codex-scope project` for project-local MCP config and repo skills. `doctor codex` verifies the CLI, config, skills, plugin/hooks, MCP registration, and a real protocol handshake.

### status — Check index freshness

```bash
npx gitnexus status
```

Shows whether the current repo has a GitNexus index, when it was last updated, and symbol/relationship counts. Use this to check if re-indexing is needed.

### clean — Delete the index

```bash
npx gitnexus clean
```

Deletes the `.gitnexus/` directory and unregisters the repo from the global registry. Use before re-indexing if the index is corrupt or after removing GitNexus from a project.

| Flag      | Effect                                            |
| --------- | ------------------------------------------------- |
| `--force` | Skip confirmation prompt                          |
| `--all`   | Clean all indexed repos, not just the current one |

### wiki — Generate documentation from the graph

```bash
npx gitnexus wiki
```

Generates repository documentation from the knowledge graph using an LLM. Requires an API key (saved to `~/.gitnexus/config.json` on first use).

| Flag                | Effect                                    |
| ------------------- | ----------------------------------------- |
| `--force`           | Force full regeneration                   |
| `--model <model>`   | LLM model (default: minimax/minimax-m2.5) |
| `--base-url <url>`  | LLM API base URL                          |
| `--api-key <key>`   | LLM API key                               |
| `--concurrency <n>` | Parallel LLM calls (default: 3)           |
| `--gist`            | Publish wiki as a public GitHub Gist      |

### list — Show all indexed repos

```bash
npx gitnexus list
```

Lists all repositories registered in `~/.gitnexus/registry.json`. The MCP `list_repos` tool provides the same information.

## After Indexing

1. **Read `gitnexus://repo/{name}/context`** to verify the index loaded
2. Use the other GitNexus skills (`exploring`, `debugging`, `impact-analysis`, `refactoring`) for your task

## Troubleshooting

- **"Not inside a git repository"**: Run from a directory inside a git repo
- **Graph index is stale or missing**: Run read-only `gitnexus refresh status --path <absolute-worktree>` and `gitnexus refresh plan --path <absolute-worktree>`; only with authority for every target, run `refresh init` / `refresh ensure`, then retry the graph call with `repo` set to that path
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding
