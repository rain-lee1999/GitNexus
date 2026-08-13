# Runbook — GitNexus

Short, copy-paste operations for **local development**, **MCP**, and **CI**. Commands assume a Unix shell; on Windows use Git Bash or equivalent paths.

## Prerequisites

- **Node.js** ≥ 20 (`gitnexus-web/package.json` `engines`).
- **Git** (analyze requires a git repository).
- From repo root, install and build the CLI package:

```bash
cd gitnexus
npm install
npm run build
```

Use `npx gitnexus …` from any path after global/published install, or `node dist/cli/index.js …` when developing from `gitnexus/` with a local build.

---

## Index out of date / “stale” tools

**Symptom:** MCP or resources warn the index is behind `HEAD`, or results don’t reflect recent commits.

**Fix (for the target worktree):**

```bash
# Read-only preflight: do not create coordinator state or modify the repository.
gitnexus refresh status --path /absolute/path/to/worktree
gitnexus refresh plan --path /absolute/path/to/worktree

# If this refresh also prewarms Serena, pass the same Serena flags to plan.
gitnexus refresh plan --path /absolute/path/to/worktree \
  --with-serena --serena-bin /absolute/path/to/serena --serena-language typescript

# Only after every planned write target is writable or has scoped approval:
# run once for every worktree.
gitnexus refresh init --path /absolute/path/to/worktree

# Optional: primary checkout only. Linked worktrees share hooks and are skipped safely.
gitnexus refresh init --path /absolute/path/to/primary-checkout --install-git-hooks

# Normal stale-index recovery. Safe when multiple Codex sessions ask at once,
# after its planned write targets are authorized.
gitnexus refresh ensure --path /absolute/path/to/worktree
```

`plan` is read-only and lists GitNexus-owned write targets. Add `--install-git-hooks` to plan when needed so it declares each managed `post-*` wrapper or a skipped path. When Serena is requested, pass the same Serena flags so the plan includes GitNexus-known global config/lock and resolved project data, but treats its external process as non-exhaustive (`writeTargetsComplete: false`): language servers and toolchains may write environment-specific caches or install paths. Obtain separate authority for that external scope before `--with-serena`. `init` and `ensure` write the target worktree's `.gitnexus/`, applicable Git exclude metadata, and `GITNEXUS_HOME` (registry and locks). `ensure` takes the worktree analysis lock and runs `analyze --index-only`; it can bootstrap the first graph index and does not rewrite `AGENTS.md` or `.agents/skills/`, but is still a write operation. Use full `analyze` only when you need those managed assets, embeddings, or an explicit repair. If the task cannot write every planned GitNexus target (and the disclosed Serena external scope when enabled), do not retry refresh: use the stale graph only with a warning, `detect_changes`, and source inspection. In multi-worktree Codex sessions, pass the same absolute worktree path as `repo` to the freshness-gated graph tools; the gate rejects aliases. `detect_changes` is not freshness-gated.

**Force full rebuild** (same commit but suspect corruption or changed ignore rules):

```bash
npx gitnexus analyze --force
```

**Check status:**

```bash
gitnexus refresh status --path /absolute/path/to/worktree
gitnexus refresh plan --path /absolute/path/to/worktree
gitnexus status  # broader index health and embedding diagnostics
```

**List what MCP knows about:**

```bash
npx gitnexus list
```

---

## Embeddings

**First time with vectors** (slower, more disk/RAM):

```bash
npx gitnexus analyze --embeddings
```

**Important:** If you already had embeddings, **always** pass `--embeddings` on later analyzes, or they can be dropped. See `stats.embeddings` in `.gitnexus/meta.json` (0 means none).

**Large repos:** Analyze may skip or limit embedding work when node counts are very high; watch CLI output.

---

## MCP: no repos / empty tools

**Symptom:** `GitNexus: No indexed repos yet` on stderr when starting MCP.

**Fix:** In each project you want indexed:

```bash
cd /path/to/repo
npx gitnexus analyze
```

Restart the editor MCP session if needed. The server **refreshes the registry lazily**; new analyzes are picked up without necessarily reinstalling MCP.

**Symptom:** Wrong repo when multiple are indexed — pass `repo` on tools or use `list_repos` first.

---

## Clean slate (corrupt or huge `.gitnexus`)

**Current repo only** (prompts for confirmation):

```bash
npx gitnexus clean
```

**Skip confirmation:**

```bash
npx gitnexus clean --force
```

**All registered repos:**

```bash
npx gitnexus clean --all --force
```

Then re-run `npx gitnexus analyze` (and `--embeddings` if you need vectors).

---

## Local bridge for the web UI

```bash
cd gitnexus
npx gitnexus serve
# default http://127.0.0.1:4747 — see serve --help for port/host
```

Use when the browser UI should talk to **local** indexed repos instead of WASM-only mode.

---

## CLI equivalents of MCP tools

Useful for debugging without an editor:

```bash
cd gitnexus
npx gitnexus query "authentication flow" --repo /absolute/path/to/worktree
npx gitnexus context SomeSymbol --repo /absolute/path/to/worktree
npx gitnexus impact SomeSymbol --direction upstream --repo /absolute/path/to/worktree
npx gitnexus cypher "MATCH (n) RETURN count(n) LIMIT 1" --repo /absolute/path/to/worktree
```

---

## CI failures (contributors)

Orchestrator: `.github/workflows/ci.yml`.

| Job             | Typical local repro                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **quality**     | `cd gitnexus && npx tsc --noEmit`                                                                                                  |
| **unit-tests**  | `cd gitnexus && npx vitest run test/unit`                                                                                          |
| **integration** | `cd gitnexus && npx vitest run test/integration` (see workflow matrix for groups)                                                  |
| **e2e**         | Triggered when `gitnexus-web/` changes; `cd gitnexus-web && E2E=1 npx playwright test` (requires `gitnexus serve` + `npm run dev`) |

**Note:** Pushes that touch only certain markdown paths may be skipped by `paths-ignore` in CI — see workflow file for exact patterns.

---

## Memory / analyze crashes

Analyze re-execs Node with a **large old-space heap** when needed (`analyze.ts`). If you still OOM on huge repos, close other processes, avoid `--embeddings` for a first pass, or analyze a smaller path if supported by your workflow.

---

## LadybugDB / lock errors

The refresh coordinator serializes index writers per worktree. Use `gitnexus refresh ensure --path /absolute/path/to/worktree` instead of starting concurrent `analyze` processes. If an old external writer still holds the store, wait for it to finish; the coordinator’s stale-lock recovery handles an abandoned refresh lock, but it does not bypass a live database lock.

---

## Where to dig deeper

- Architecture overview: [ARCHITECTURE.md](ARCHITECTURE.md)
- Agent safety rules: [GUARDRAILS.md](GUARDRAILS.md)
- Tests: [TESTING.md](TESTING.md)
