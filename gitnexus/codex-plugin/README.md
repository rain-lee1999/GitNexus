# GitNexus Codex plugin

This directory is a self-contained local Codex marketplace and plugin bundle. It packages the pinned GitNexus stdio MCP server, a graph-aware workflow skill, and advisory `PreToolUse`/`PostToolUse` hooks using the current Codex hook schema.

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

Restart Codex after installation. Open `/hooks` to review and trust the plugin hooks; Codex intentionally skips new or changed non-managed hooks until they are trusted.

The `PreToolUse` hook enriches `rg` and `grep` shell searches when the repository has a `.gitnexus` index. The `PostToolUse` hook detects index drift after successful Git history mutations and advises a refresh. Neither hook edits files or runs `analyze` automatically.

The bundled MCP server is stdio-based and needs Node.js 20 or newer. Its package version is pinned to the plugin version for reproducible installation.
