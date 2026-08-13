<!-- version: 1.8.0 -->
<!-- Last updated: 2026-08-13 -->

Last reviewed: 2026-08-13

**Project:** GitNexus · **Environment:** dev · **Maintainer:** repository maintainers (see GitHub)

## Scope

| Boundary       | Rule                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **Reads**      | `gitnexus/`, `gitnexus-web/`, `eval/`, plugin packages, `.github/`, `.gitnexus/`, docs.                                     |
| **Writes**     | Only paths required for the change; keep diffs minimal. Update lockfiles when deps change.                                  |
| **Executes**   | `npm`, `npx`, `node` under `gitnexus/` and `gitnexus-web/`; `uv run` for Python under `eval/`; documented CI/dev workflows. |
| **Off-limits** | Real `.env` / secrets, production credentials, unrelated repos, destructive git ops without confirmation.                   |

## Model Configuration

- **Primary:** Use a named model (e.g. Claude Sonnet 4.x). Avoid `Auto` or unversioned `latest` when reproducibility matters.
- **Notes:** The GitNexus CLI indexer does not call an LLM.

## Execution Sequence (complex tasks)

For multi-step work, state up front:

1. Which rules in this file and **[GUARDRAILS.md](GUARDRAILS.md)** apply (and any relevant Signs).
2. Current **Scope** boundaries.
3. Which **validation commands** you will run (`cd gitnexus && npm test`, `npx tsc --noEmit`).

On long threads, _"Remember: apply all AGENTS.md rules"_ re-weights these instructions against context dilution.

## Codex hooks

The bundled GitNexus Codex plugin provides **PreToolUse** search enrichment plus a graph-query freshness gate, and **PostToolUse** Git-history stale markers. Review and trust them through `/hooks`; they never run `analyze` directly.

## Context budget

Commands and gotchas live under **Repo reference** below and in **[CONTRIBUTING.md](CONTRIBUTING.md)**. If always-on rules grow, split into repo-scoped Codex skills under **`.agents/skills/`**. **Cursor:** project-wide rules remain in `.cursor/index.mdc`.

## Reference docs

- **[ARCHITECTURE.md](ARCHITECTURE.md)**, **[CONTRIBUTING.md](CONTRIBUTING.md)**, **[GUARDRAILS.md](GUARDRAILS.md)**
- **Call-resolution DAG (legacy path):** See ARCHITECTURE.md § Call-Resolution DAG. Typed 6-stage DAG inside the `parse` phase; language-specific behavior behind `inferImplicitReceiver` / `selectDispatch` hooks on `LanguageProvider`. Shared code in `gitnexus/src/core/ingestion/` must not name languages. Types: `gitnexus/src/core/ingestion/call-types.ts`.
- **Scope-resolution pipeline (RFC #909 Ring 3):** See ARCHITECTURE.md § Scope-Resolution Pipeline. Replaces the legacy DAG for languages in `MIGRATED_LANGUAGES` (see `registry-primary-flag.ts`). A language plugs in by implementing `ScopeResolver` (`scope-resolution/contract/scope-resolver.ts`) and registering it in `SCOPE_RESOLVERS`. CI parity gate runs BOTH paths per migrated language on every PR.
- **Cursor:** `.cursor/index.mdc` (always-on); `.cursor/rules/*.mdc` (glob-scoped). Legacy `.cursorrules` deprecated.
- **GitNexus:** Codex skills are direct children of `.agents/skills/gitnexus-*`; MCP rules are in the `gitnexus:start` block below.

## Changelog

| Date       | Version | Change                                                                                                                                                                                                                                                  |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-13 | 1.8.0   | Migrated GitNexus assets and hooks to the Codex-native plugin, `AGENTS.md`, and `.agents/skills/` layout.                                                                                                                                               |
| 2026-04-23 | 1.7.0   | TypeScript added to `MIGRATED_LANGUAGES` (registry-primary call resolution by default).                                                                                                                                                                 |
| 2026-04-20 | 1.6.0   | Added scope-resolution pipeline pointer (RFC #909 Ring 3); Python migrated to registry-primary.                                                                                                                                                         |
| 2026-04-19 | 1.5.0   | Cross-repo impact (#794): `impact`/`query`/`context` accept `repo: "@<group>"` + `service`. Removed `group_query`/`group_contracts`/`group_status` MCP tools; added `gitnexus://group/{name}/contracts` and `gitnexus://group/{name}/status` resources. |
| 2026-04-16 | 1.4.0   | Fixed: web UI description, pre-commit behavior, MCP tools (7->16), added gitnexus-shared, removed stale vite-plugin-wasm gotcha.                                                                                                                        |
| 2026-04-13 | 1.3.0   | Updated GitNexus index stats after DAG refactor.                                                                                                                                                                                                        |
| 2026-03-24 | 1.2.0   | Fixed gitnexus:start block duplication.                                                                                                                                                                                                                 |
| 2026-03-23 | 1.1.0   | Updated agent instructions, references, Cursor layout.                                                                                                                                                                                                  |
| 2026-03-22 | 1.0.0   | Initial structured header and changelog.                                                                                                                                                                                                                |

---

<!-- gitnexus:start -->
<!-- gitnexus:context-version:1 -->

# GitNexus — Code Intelligence

This project is indexed by GitNexus as **GitNexus** (23081 symbols, 30497 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Graph stale/missing: the Codex gate queues an index-only refresh and denies the current call; retry when ready, or run `gitnexus refresh ensure --path <absolute-worktree>` to wait synchronously. Freshness-gated graph tools require that absolute worktree path in `repo`; aliases are not accepted by the gate. `detect_changes` is not freshness-gated.

## Always Do

- **MUST run impact analysis before editing any symbol.** Run `gitnexus_impact({target: "symbolName", direction: "upstream", repo: "<absolute-worktree>"})`, then report its blast radius.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- For unfamiliar code, use `gitnexus_query({query: "concept", repo: "<absolute-worktree>"})` to find execution flows.
- For a symbol's callers, callees, and flows, use `gitnexus_context({name: "symbolName", repo: "<absolute-worktree>"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource                                  | Use for                                  |
| ----------------------------------------- | ---------------------------------------- |
| `gitnexus://repo/GitNexus/context`        | Codebase overview, check index freshness |
| `gitnexus://repo/GitNexus/clusters`       | All functional areas                     |
| `gitnexus://repo/GitNexus/processes`      | All execution flows                      |
| `gitnexus://repo/GitNexus/process/{name}` | Step-by-step execution trace             |

## CLI

| Task                                           | Read this skill file                                          |
| ---------------------------------------------- | ------------------------------------------------------------- |
| Understand architecture / "How does X work?"   | `.agents/skills/gitnexus-exploring/SKILL.md`                  |
| Blast radius / "What breaks if I change X?"    | `.agents/skills/gitnexus-impact-analysis/SKILL.md`            |
| Trace bugs / "Why is X failing?"               | `.agents/skills/gitnexus-debugging/SKILL.md`                  |
| Rename / extract / split / refactor            | `.agents/skills/gitnexus-refactoring/SKILL.md`                |
| Review a pull request or code changes          | `.agents/skills/gitnexus-pr-review/SKILL.md`                  |
| Tools, resources, schema reference             | `.agents/skills/gitnexus-guide/SKILL.md`                      |
| Index, status, clean, wiki CLI commands        | `.agents/skills/gitnexus-cli/SKILL.md`                        |
| Work in the Ingestion area (221 symbols)       | `.agents/skills/gitnexus-generated-ingestion/SKILL.md`        |
| Work in the Cli area (146 symbols)             | `.agents/skills/gitnexus-generated-cli/SKILL.md`              |
| Work in the Components area (108 symbols)      | `.agents/skills/gitnexus-generated-components/SKILL.md`       |
| Work in the Group area (96 symbols)            | `.agents/skills/gitnexus-generated-group/SKILL.md`            |
| Work in the Hooks area (91 symbols)            | `.agents/skills/gitnexus-generated-hooks/SKILL.md`            |
| Work in the Type-extractors area (90 symbols)  | `.agents/skills/gitnexus-generated-type-extractors/SKILL.md`  |
| Work in the Configs area (85 symbols)          | `.agents/skills/gitnexus-generated-configs/SKILL.md`          |
| Work in the Unit area (76 symbols)             | `.agents/skills/gitnexus-generated-unit/SKILL.md`             |
| Work in the Lbug area (74 symbols)             | `.agents/skills/gitnexus-generated-lbug/SKILL.md`             |
| Work in the Scope-resolution area (72 symbols) | `.agents/skills/gitnexus-generated-scope-resolution/SKILL.md` |
| Work in the Server area (65 symbols)           | `.agents/skills/gitnexus-generated-server/SKILL.md`           |
| Work in the Local area (61 symbols)            | `.agents/skills/gitnexus-generated-local/SKILL.md`            |
| Work in the Extractors area (55 symbols)       | `.agents/skills/gitnexus-generated-extractors/SKILL.md`       |
| Work in the Workers area (53 symbols)          | `.agents/skills/gitnexus-generated-workers/SKILL.md`          |
| Work in the Wiki area (51 symbols)             | `.agents/skills/gitnexus-generated-wiki/SKILL.md`             |
| Work in the Typescript area (50 symbols)       | `.agents/skills/gitnexus-generated-typescript/SKILL.md`       |
| Work in the Embeddings area (50 symbols)       | `.agents/skills/gitnexus-generated-embeddings/SKILL.md`       |
| Work in the Storage area (48 symbols)          | `.agents/skills/gitnexus-generated-storage/SKILL.md`          |
| Work in the Llm area (44 symbols)              | `.agents/skills/gitnexus-generated-llm/SKILL.md`              |
| Work in the Services area (43 symbols)         | `.agents/skills/gitnexus-generated-services/SKILL.md`         |

<!-- gitnexus:end -->

## Repo reference

### Packages

| Package            | Path                           | Purpose                                                            |
| ------------------ | ------------------------------ | ------------------------------------------------------------------ |
| **CLI/Core**       | `gitnexus/`                    | TypeScript CLI, indexing pipeline, MCP server. Published to npm.   |
| **Web UI**         | `gitnexus-web/`                | React/Vite thin client. All queries via `gitnexus serve` HTTP API. |
| **Shared**         | `gitnexus-shared/`             | Shared TypeScript types and constants.                             |
| Claude Plugin      | `gitnexus-claude-plugin/`      | Static config for Claude marketplace.                              |
| Cursor Integration | `gitnexus-cursor-integration/` | Static config for Cursor editor.                                   |
| Eval               | `eval/`                        | Python evaluation harness (Docker + LLM API keys).                 |

### Running services

```bash
cd gitnexus && npm run dev                 # CLI: tsx watch mode
cd gitnexus-web && npm run dev             # Web UI: Vite on port 5173
npx gitnexus serve                         # HTTP API on port 4747 (from any indexed repo)
```

### Testing

**CLI / Core (`gitnexus/`)**

- `npm test` — full vitest suite (~2000 tests)
- `npm run test:unit` — unit tests only
- `npm run test:integration` — integration (~1850 tests). LadybugDB file-locking tests may fail in containers (known env issue).
- `npx tsc --noEmit` — typecheck

**Web UI (`gitnexus-web/`)**

- `npm test` — vitest (~200 tests)
- `npm run test:e2e` — Playwright (7 spec files; requires `gitnexus serve` + `npm run dev`)
- `npx tsc -b --noEmit` — typecheck

**Pre-commit hook** (`.husky/pre-commit`): formatting (prettier via lint-staged) + typecheck for staged packages. Tests do **not** run in pre-commit — CI only.

### Gotchas

- `npm install` in `gitnexus/` triggers `prepare` (builds via `tsc`) and `postinstall` (patches tree-sitter-swift, builds tree-sitter-proto). Native bindings need `python3`, `make`, `g++`.
- `tree-sitter-kotlin` and `tree-sitter-swift` are optional — install warnings expected.
- ESLint configured via `eslint.config.mjs` (TS, React Hooks, unused-imports). No `npm run lint` script; use `npx eslint .`. Prettier runs via lint-staged. CI checks both in `ci-quality.yml`.
