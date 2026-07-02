# Claude Code Adapter Recipe

This directory is a wiring recipe, not a certified Claude Code integration.

## MCP Context

Copy `.mcp.json` into a Claude Code project and adjust `--db` and `--profile`.
It registers gmOS as a stdio MCP server:

```bash
gmos mcp serve --db ./.gmos/claude-code-memory.db --profile claude-code
```

At session start, call `memory.prepare_context` through MCP with the current
task text and inject the returned context block into the host's turn setup.
gmOS does not do that injection by itself.

## Hook Bridge

`observe-bridge.mjs` reads one hook event JSON object from stdin and forwards it
to a local gmOS HTTP adapter:

```bash
GMOS_HTTP_URL=http://127.0.0.1:4787 \
GMOS_HTTP_AUTH_TOKEN=local-token \
GMOS_PROFILE_ID=claude-code \
node examples/claude-code-adapter/observe-bridge.mjs < hook-event.json
```

Expected minimal fields:

- `hook_event_name` or `hookEventName`: `SessionStart`, `SessionStop`, or
  `PostToolUse`.
- `session_id` or `sessionId`: stable session id when available.
- `timestamp`: optional ISO timestamp.
- `PostToolUse` also accepts `tool_name` or `toolName`.
- `SessionStop` may include `summary` and `status`.

The bridge only uses these fields plus optional plain metadata such as `cwd`.
It does not parse transcripts or rely on Claude Code private internals.

`SessionStart` and `PostToolUse` become `/observe` calls. `SessionStop` becomes
`/commit-outcome` so recall counters can advance when the host passes used
memory ids from its turn loop.

Run the offline smoke:

```bash
npm run examples:claude-code
```
