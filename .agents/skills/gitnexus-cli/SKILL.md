---
name: gitnexus-cli
description: 'Use when the user needs to run GitNexus CLI commands like analyze/index a repo, check status, clean the index, generate a wiki, or list indexed repos. Examples: "Index this repo", "Reanalyze the codebase", "Generate a wiki"'
---

# GitNexus CLI Commands

All commands work via `npx` — no global install required.

## Commands

### analyze — Generate managed assets or explicitly rebuild

```bash
npx gitnexus analyze
```

Run from the project root. This parses source files, builds the knowledge graph, writes it to `.gitnexus/`, updates the managed section in `AGENTS.md`, and installs Codex-native repo skills under `.agents/skills/`.

| Flag                | Effect                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `--force`           | Force full re-index even if up to date                                                               |
| `--embeddings`      | Enable embedding generation for semantic search (off by default)                                     |
| `--drop-embeddings` | Drop existing embeddings on rebuild. By default, an `analyze` without `--embeddings` preserves them. |
| `--skills`          | Generate functional-area skills as `.agents/skills/gitnexus-generated-*`                             |
| `--skip-agents-md`  | Leave the managed GitNexus section in `AGENTS.md` unchanged                                          |

**When to run:** To generate managed `AGENTS.md`/skills, generate embeddings or functional-area skills, or perform an explicit repair (`--force`). `refresh ensure` below can bootstrap the first graph index and handles normal staleness. The Codex hooks mark Git-history drift and gate stale graph queries; they never run `analyze` directly.

### refresh — Worktree-safe graph freshness

```bash
# Run once per worktree; optional managed Git hooks only mark it stale.
gitnexus refresh init --path /absolute/path/to/worktree --install-git-hooks

# Normal refresh: one writer per worktree, graph + registry only.
gitnexus refresh ensure --path /absolute/path/to/worktree

# Inspect the target worktree before or after a refresh.
gitnexus refresh status --path /absolute/path/to/worktree
```

`refresh ensure` runs `analyze --index-only`, so it never updates `AGENTS.md` or `.agents/skills/`. It can bootstrap the first graph index. In a multi-worktree Codex session, the freshness-gated graph tools (`query`, `cypher`, `context`, `impact`, `route_map`, `tool_map`, `shape_check`, and `api_impact`) require `repo` as the absolute worktree path; the Codex gate rejects aliases. `detect_changes` is not freshness-gated.

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
- **Graph index is stale or missing**: Run `gitnexus refresh ensure --path <absolute-worktree>`, then retry the graph call with `repo` set to that path
- **Embeddings slow**: Omit `--embeddings` (it's off by default) or set `OPENAI_API_KEY` for faster API-based embedding
