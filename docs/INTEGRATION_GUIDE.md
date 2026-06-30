# gmOS MCP and HTTP Integration Guide

This guide is for host applications that want gmOS memory without copying
runtime internals. Use it after reading the API reference when deciding how an
agent runtime should connect to gmOS.

gmOS stays local-first: the default store is plaintext SQLite, cloud sync is not
required, and encryption is intentionally not enabled by the SDK.

## Choose A Boundary

Use the in-process SDK when the host is a Node.js application and can own the
SQLite file directly:

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({ path: "./gmos.db" });
const memory = createMemoryOS({ profileId: "local-user", store });
```

Use MCP when the host already speaks tool calls or can launch local stdio
servers. MCP exposes the public tool contract and rejects sensitive override
switches.

```bash
gmos mcp serve --db ./gmos.db --profile local
```

Use the local HTTP adapter when the host cannot import the Node SDK directly,
for example another runtime process, a desktop shell, or a language bridge.
Bind it to loopback and pass an auth token when the service crosses a process
boundary.

```bash
GMOS_HTTP_AUTH_TOKEN=local-dev-token \
  gmos http serve --db ./gmos.db --profile local --port 4787 --host ghast
```

## Turn Lifecycle

For full agent memory, hosts should wire these phases instead of only calling
search:

1. Observe user, assistant, tool, note, or summary events with `observe()` or
   `memory.observe`.
2. Prepare context before model calls with `prepareTurn()`,
   `memory.prepare_context`, or `POST /prepare`.
3. Use `reconstructContext()` or `memory.reconstruct_context` for long-running
   tasks that need cue/tag/content reconstruction.
4. Commit task outcomes with `commitOutcome()` or `memory.commit_outcome`.
5. Record user corrections with `recordFeedback()` or `memory.record_feedback`.
6. Use `forget()` or `memory.forget` for user-requested deletion and residue
   cleanup. When the host already knows the deletion subject, pass structured
   `targetTerms`; keep the natural-language `query` for audit and compatibility.

Low-level `add` and `search` are compatibility APIs. They are useful for import,
admin tools, and simple hosts, but they are not a substitute for the full turn
lifecycle.

If the host already has a trusted local or host-controlled calendar/task-time
parser, pass it through `createMemoryOS({ temporal: { parser } })` and return
structured `eventTime`, `validFrom`, or `validTo` values. Set
`temporal.inferFromText: false` when the integration should rely only on host
metadata and extractor output instead of gmOS' conservative built-in date text
inference.

For in-process Node agent runtimes, `@ghast/memory/host` includes a small
framework-agnostic adapter that wires this lifecycle without depending on a
specific agent framework:

```ts
import { createAgentMemoryAdapter } from "@ghast/memory/host";

const adapter = createAgentMemoryAdapter({
  memory,
  profileId: "local-user",
  includeEvidence: true,
  reconstruction: { mode: "shadow", maxSteps: 2 },
});

await adapter.observeMessage({
  role: "user",
  content: "Let's plan the rollout.",
});

await memory.add({
  profileId: "local-user",
  kind: "preference",
  content: "For rollout plans, list risks first.",
});

const turn = await adapter.prepareTurn({
  messages: [{ role: "user", content: "How should we proceed?" }],
});

// Send turn.modelMessages to the host's model call.
```

Run the smoke example:

```bash
npm run examples:agent-adapter
```

## MCP Contract

Public MCP tools are:

- `memory.add`
- `memory.search`
- `memory.observe`
- `memory.prepare_context`
- `memory.reconstruct_context`
- `memory.explain_evidence_path`
- `memory.commit_outcome`
- `memory.record_feedback`
- `memory.forget`
- `memory.explain_belief`
- `memory.runtime_info`

MCP does not expose `includeSensitive`, `includePerson`, raw metadata writes,
backup, or restore. Hosts that need admin access should use the in-process SDK
inside an explicit trusted boundary.

Run the in-process MCP smoke example:

```bash
npm run examples:mcp-router
```

The example validates runtime info, observation, context preparation, public
sensitive override rejection, and evidence-path explanation without printing
memory content or the real SQLite path.

## HTTP Contract

The HTTP adapter exposes the same public memory operations over loopback HTTP.
It should normally be started with an auth token:

```bash
curl -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4787/runtime-info
```

Useful endpoints:

- `GET /health`
- `GET /runtime-info`
- `GET /tools`
- `GET /status`
- `POST /add`
- `POST /search`
- `POST /observe`
- `POST /prepare`
- `POST /reconstruct`
- `POST /explain-path`
- `POST /commit-outcome`
- `POST /feedback`
- `POST /forget`
- `POST /explain`
- `POST /mcp/call`

Example structured forget request:

```bash
curl -X POST -H "Authorization: Bearer local-dev-token" \
  -H "Content-Type: application/json" \
  --data '{"query":"delete old project memory","targetTerms":["old project"]}' \
  http://127.0.0.1:4787/forget
```

`GET /health` is intentionally open and only reports service health plus whether
auth is required. All other endpoints return `401` when `authToken` is set and
the request is missing `Authorization: Bearer <token>`.

Run the HTTP smoke example:

```bash
npm run examples:http-adapter
```

The example starts an ephemeral localhost server, verifies auth, records an
ordinary observation, imports an explicit preference memory, prepares
evidence-backed context, reads status, and deletes its temporary plaintext
SQLite database.

## Host Contract Tests

Hosts should test their integration against the published public surface instead
of relying on private file paths:

```ts
import { PUBLIC_MEMORY_HTTP_ROUTES } from "@ghast/memory/http";
import { PUBLIC_MEMORY_MCP_TOOL_NAMES } from "@ghast/memory/mcp";
```

For local SDK confidence, run:

```bash
npm run gate:pr
```

For a small external-adapter smoke that ships with the package, run:

```bash
npm run examples:external-mini
```

This uses the native deterministic mini fixture under `examples/` and reports
score semantics explicitly. It is useful for checking reproducibility wiring,
not for claiming official external benchmark performance.

For a host-specific compatibility check, export the host status report and run:

```bash
gmos gym host --hosts ghast --actual-report ./host-memory-status.json --format markdown
```

## Security And Privacy Boundary

- The SQLite database is plaintext by default.
- gmOS does not add cloud sync.
- MCP and HTTP reject public sensitive override switches.
- Secret-like content should not be persisted as ordinary long-term memory.
- Incognito/private events should not be promoted into long-term memory.
- Person-routed memory should not enter ordinary user context.
- Backup and restore are trusted SDK/CLI workflows, not MCP or HTTP tools.

These boundaries are product contracts, not benchmark toggles. Do not loosen
them for evaluation scores.
