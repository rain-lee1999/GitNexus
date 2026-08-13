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

Call `list_repos` when the target is ambiguous and pass `repo` on later calls. Treat an index-staleness warning as authoritative: run `npx gitnexus analyze` in that repository and retry. A normal analyze preserves existing embeddings.

Use `cypher` only when the standard tools cannot express the structural question; read `gitnexus://repo/{name}/schema` first.
