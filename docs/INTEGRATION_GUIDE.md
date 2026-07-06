# gmOS MCP and HTTP Integration Guide

This guide is for host applications that want gmOS memory without copying
runtime internals. Use it after reading the API reference when deciding how an
agent runtime should connect to gmOS.

gmOS stays local-first: the default store is plaintext SQLite, cloud sync is not
required, and encryption is not enabled unless the host supplies a cipher driver
and key.

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

Use the local HTTP service when the host cannot import the Node SDK directly,
for example another runtime process, a desktop shell, or a language bridge.
Bind it to loopback. Existing local adapters can keep the legacy token mode:

```bash
GMOS_HTTP_AUTH_TOKEN=local-dev-token \
  gmos http serve --db ./gmos.db --profile local --port 4787 --host ghast
```

For self-hosted agents, prefer scoped keys:

```bash
gmos keys create --db ./gmos.db --label planner-read --scope read --profiles local
gmos keys create --db ./gmos.db --label worker-write --scope readwrite --profiles local
gmos serve --db ./gmos.db --profile local --keys --port 4787
```

Wire read-only agents to `GET /status`, `POST /search`, `POST /prepare`, and
explain/reconstruct routes with their read key. Wire agents that ingest events
or outcomes with a readwrite key. Keep admin keys out of agent runtime prompts;
they can list/create profiles and list key metadata but cannot create or revoke
keys over HTTP.

Use `--default-disposition` when different agents should recall with different
budgets by default:

```bash
gmos keys create \
  --db ./gmos.db \
  --label focused-planner \
  --scope read \
  --profiles local \
  --default-disposition focused
```

The HTTP layer applies the key default only when the request does not include
`dispositionPreset`.

## Autopilot Setup

Autopilot is host-scheduled. It is not remotely triggerable over HTTP.

Cron-friendly one-shot:

```bash
*/15 * * * * /usr/local/bin/gmos autopilot run --db /path/gmos.db --profile local --phases decay,consolidate --embed-backfill-batch 32 --ingest-dir /path/transcripts --format json >> /path/gmos-autopilot.log 2>&1
```

launchd one-shot example:

```xml
<dict>
  <key>Label</key><string>com.example.gmos.autopilot</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/gmos</string>
    <string>autopilot</string>
    <string>run</string>
    <string>--db</string><string>/path/gmos.db</string>
    <string>--profile</string><string>local</string>
    <string>--ingest-dir</string><string>/path/transcripts</string>
  </array>
  <key>StartInterval</key><integer>900</integer>
</dict>
```

Serve-mode local timer:

```bash
gmos serve \
  --db ./gmos.db \
  --profile local \
  --keys \
  --autopilot-interval-minutes 15 \
  --phases decay,consolidate \
  --embed-backfill-batch 32 \
  --ingest-dir ./transcripts
```

The timer adds small deterministic jitter, skips a tick if the previous run is
still active, writes normal run history, and exposes `autopilot` status through
`GET /status`.

## Transcript Ingestion

One file:

```bash
gmos ingest \
  --db ./gmos.db \
  --profile local \
  --input-file ./thread.jsonl \
  --input-format jsonl \
  --dry-run \
  --format markdown
```

Claude Code transcript directories can be wired by pointing `--ingest-dir` at
the host-owned export/session directory. gmOS reads supported `.jsonl` and
`.json` files, records only the source content hash, and never moves or deletes
files. Re-running the same file is idempotent by event key.

Transcript import records one evidence event per message, then uses
`ingestConversation()` to extract over windows instead of calling the extractor
once per message. The default window is 12 eligible messages; session metadata
can split windows without changing evidence granularity. Memories created from
a window keep `windowEvidenceIds` in metadata so `explain()` and reconstruction
can trace back to the contributing messages.

Hosts that need raw-turn recall can opt in to hybrid storage:

```ts
await memory.ingestConversation({
  profileId,
  messages,
  turnRetention: { enabled: true },
});
```

This writes one retrievable low-confidence `fact` memory per eligible message
with `metadata.turnMemory = true` and the same evidence id as the message.
Leave it off when storage is tighter than answerability. Enable it for
long-memory readers, support investigations, or products where the extractor is
allowed to miss wording but recall still needs the raw turn. Expect memory rows
to roughly double in message-mode ingest. The recommended long-running pattern
is: retain raw turns, consolidate repeated clusters into semantic summaries,
then let `maintain()` demote the lower-confidence turn memories.

Hosts that need reliable aggregation across sessions can add write-side session
distillation:

```ts
await memory.ingestConversation({
  profileId,
  messages,
  sessionDistillation: true,
});
```

This does nothing unless `createMemoryOS()` was given a `sessionDistiller` hook.
The hook owns the prose and returns compact dated facts; gmOS stores accepted
candidates as ordinary memories at default confidence `0.6`, linked to the
session evidence row and subject to the same secret-like, incognito,
person-routing, source-trust, and lower-trust gates. Use it for totals, counts,
durations, purchases, and other questions where retrieving every per-session
instance matters. It costs one hook call per ingested session, so keep it off
for cheap transcript import or when raw turns plus extractor atoms are enough.

## Turn Lifecycle

For full agent memory, hosts should wire these phases instead of only calling
search:

1. Observe single live events with `observe()` or `memory.observe`; ingest long
   transcripts with `ingestConversation()` or `gmos ingest` so extraction is
   windowed.
2. Prepare context before model calls with `prepareTurn()`,
   `memory.prepare_context`, or `POST /prepare`.
3. Call `explainTurn()`, `memory.explain_turn`, or `POST /explain-turn` only
   when the host needs to debug a turn decision, for example a user-visible
   "why did you say that?" moment, a support bundle, or a regression check.
   It returns decision traces and budget stops, not a prompt block.
4. Use `reconstructContext()` or `memory.reconstruct_context` for long-running
   tasks that need cue/tag/content reconstruction.
5. Commit task outcomes with `commitOutcome()` or `memory.commit_outcome`.
6. Record user corrections with `recordFeedback()` or `memory.record_feedback`.
7. Use `forget()` or `memory.forget` for user-requested deletion and residue
   cleanup. When the host already knows the deletion subject, pass structured
   `targetTerms`; keep the natural-language `query` for audit and literal
   compatibility. If the host accepts natural-language delete commands, parse
   them with host logic or `forgetTargetParser` instead of relying on gmOS core
   language templates. Parser `undefined` or `null` falls back to literal
   `query`; parser empty terms archive nothing. Empty literal queries also
   archive nothing.

Low-level `add` and `search` are compatibility APIs. They are useful for import,
admin tools, and simple hosts, but they are not a substitute for the full turn
lifecycle.

When observing multi-speaker conversations, pass speaker context as structured
event metadata:

```ts
await memory.observe({
  type: "conversation.message",
  role: "user",
  content: "Mira opened the rollout planning thread.",
  metadata: {
    speaker: "Mira",
    speakerKind: "person",
    speakerAliases: ["mira-local"],
    participants: ["Mira", "Blair"],
  },
});
```

gmOS treats `speaker` as a person cue only when `speakerKind` is `"person"` or
`"human"`. Bare speaker strings are preserved as source metadata but are not
trusted for person grounding. `participants` are kept as non-retrieval entity
mentions for explanation and audit; they do not become association cues.

If the host already has a trusted local or host-controlled calendar/task-time
parser, pass it through `createMemoryOS({ temporal: { parser } })` and return
structured `eventTime`, `eventDate`, `validFrom`, or `validTo` values. Built-in
date-text inference is off by default; set `temporal.inferFromText: true` only
when the integration explicitly wants gmOS to parse explicit date text during
memory writes. Reconstruction query date text is also off by default; set
`reconstruction.inferTemporalCuesFromText: true` only when the integration
explicitly wants the conservative built-in date parser for query cues. Relative
calendar phrases should be resolved by the host parser with trusted calendar
context, not by gmOS core language templates.

If the host already owns entity aliases, calendar cues, or route parsing for
active reconstruction, pass them through
`createMemoryOS({ reconstruction: { cueExtractor } })`. The extractor returns
bounded `{ cue, cueKind }` values for query/evidence text. gmOS still filters
secret-like cues and merges host cues with built-in lexical/date cues, so
product-specific semantics stay in the host instead of becoming language-specific
word lists in gmOS core.

For a minimal end-to-end structured extractor smoke, run:

```bash
npm run examples:structured-extractor
```

The example supplies host-owned memory candidates and reconstruction cues, then
lets gmOS handle evidence recording, validation, action-policy projection,
reconstruction, and read-path safety. Use it as the starting point for integrating
an LLM extractor, local model extractor, or domain parser without moving semantic
rules into gmOS core.

For the packaged OpenAI-compatible extractor factory, run the offline smoke:

```bash
npm run examples:openai-compatible-extractor
```

That example uses a fake `/chat/completions` response, so it does not call the
network or require an API key. It validates the provider-shaped JSON parser,
structured candidate normalization, action-policy projection, and reconstruction
path while keeping the same gmOS write-path safety gates that a real provider
would use.

## Batteries-Included Intelligence

Hosts that want first-run value without writing hook implementations can opt in
to `@ghast/memory/intelligence`. The subpath ships OpenAI-compatible
implementations for the existing host hooks: extractor, consolidator, procedure
distiller, session distiller, dossier synthesizer, embedding provider, reranker, and the
`createDefaultIntelligence()` preset.

Five-minute local Ollama setup:

```ts
import { createMemoryOS } from "@ghast/memory";
import { createDefaultIntelligence } from "@ghast/memory/intelligence";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const intelligence = createDefaultIntelligence({
  baseUrl: "http://127.0.0.1:11434/v1",
  model: "llama3.1",
  embedModel: "nomic-embed-text",
  dimensions: 768,
  sessionDistillation: true,
});

const store = createSqliteMemoryStore({ path: "./gmos.db" });
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  ...intelligence,
});
```

`sessionDistillation: true` is optional. It adds the OpenAI-compatible
session-distiller hook to the returned bundle; `ingestConversation()` still
requires `sessionDistillation: true` per call before the hook is used. Pass
`sessionDistillation: { model, baseUrl }` to use a cheaper or faster model for
the session-summary call while keeping the base extractor model unchanged.

Five-minute OpenAI-compatible cloud setup:

```ts
const intelligence = createDefaultIntelligence({
  baseUrl: "https://provider.example/v1",
  apiKey: process.env.MEMORY_MODEL_API_KEY,
  model: "provider-chat-model",
  embedModel: "provider-embedding-model",
  dimensions: 1536,
});
```

Every factory also accepts `fetchImpl`, so tests and gyms can use in-process
stub responses without real network or localhost servers.

Privacy note: when these hooks target a remote endpoint, gmOS sends the selected
event, memory, belief, trajectory, or query candidate text to that endpoint.
M5 sensitivity gates still prevent secret-like content and secret-like queries
from durable writes or provider embeddings, and sensitive/person embeddings
remain opt-in, but the host is responsible for choosing whether the endpoint is
local, trusted, or remote.

## Embedding Providers

Hosts can upgrade recall by wiring a local Ollama, ONNX, or other embedding
provider. The provider is host-owned; gmOS only calls its `embed(texts)` method
on write paths, explicit repair/backfill, or explicit query embedding.

```ts
const embeddingProvider = {
  name: "ollama-nomic-embed-text",
  dimensions: 768,
  async embed(texts: string[]) {
    return Promise.all(texts.map((text) => ollamaEmbed(text)));
  },
};

const store = createSqliteMemoryStore({
  path: "./gmos.db",
  embeddingProvider,
});

const memory = createMemoryOS({
  profileId: "local-user",
  store,
  embeddingProvider,
});
```

Remote providers are allowed only by host choice. Defaults protect privacy:
normal non-person memories may be embedded; sensitive and person memories stay
on `local-hash-v1` unless the host opts in with `embedSensitive` or
`embedPerson`; secret-like content and secret-like queries are never sent.

Use explicit query embedding only where the host accepts a read-time provider
call:

```ts
await memory.search({
  query: "semantic paraphrase",
  retrieval: { embedQuery: true, queryEmbeddingTimeoutMs: 1000 },
});
```

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

## Adapter Recipes

These recipes are thin wiring examples over gmOS public surfaces. They are not
certified integrations with Claude Code, OpenAI, LangGraph, or any other host.

### Claude Code MCP And Hook Bridge

`examples/claude-code-adapter/.mcp.json` registers gmOS as a stdio MCP server:

```json
{
  "mcpServers": {
    "gmos-memory": {
      "command": "gmos",
      "args": [
        "mcp",
        "serve",
        "--db",
        "./.gmos/claude-code-memory.db",
        "--profile",
        "claude-code"
      ]
    }
  }
}
```

At `SessionStart`, the host should call `memory.prepare_context` through MCP
with the current task text and inject the returned context block into the turn
setup. gmOS exposes the tool; the host owns where that context is placed.

`examples/claude-code-adapter/observe-bridge.mjs` reads one hook event JSON
object from stdin. It accepts the minimal fields documented in that directory's
README: `hook_event_name`/`hookEventName`, optional `session_id`/`sessionId`,
optional `timestamp`, and `tool_name`/`toolName` for `PostToolUse`. It forwards
`SessionStart` and `PostToolUse` to `/observe`, and `SessionStop` to
`/commit-outcome`, using `GMOS_HTTP_URL`, `GMOS_HTTP_AUTH_TOKEN`, and
`GMOS_PROFILE_ID`.

Run the offline smoke:

```bash
npm run examples:claude-code
```

### OpenAI-Compatible Function Tool Hosts

`examples/openai-agent-memory.mjs` derives function-tool JSON schemas from the
MCP tool contract for:

- `memory.prepare_context`
- `memory.observe`
- `memory.commit_outcome`
- `memory.record_feedback`
- `memory.explain_turn`

The example drives those tools through the in-process MCP router with a scripted
agent loop. A real host keeps the same tool contract and replaces the scripted
loop with its model client and function-call dispatcher. gmOS still receives
ordinary MCP tool calls and does not call a model itself.

Run it with:

```bash
npm run examples:openai-agent-memory
```

### Graph-Style Runtime

`examples/graph-runtime-memory.mjs` hand-rolls a small graph:

- pre-model node: calls `POST /prepare`;
- model node: returns a deterministic assistant message;
- post-model node: calls `POST /observe` and `POST /commit-outcome` with
  `usedMemoryIds`.

The second graph run verifies that recall count and reinforcement advanced
through the normal write path. A LangGraph or similar host can map these nodes
to framework nodes without changing gmOS.

Run it with:

```bash
npm run examples:graph-runtime-memory
```

## Directory Listings

`server.json` is the MCP registry manifest for the stdio server. It describes
the npm package and stdio transport only. Publishing the listing is a maintainer
action: release the npm package, verify `server.json` matches that version, then
submit it to the MCP registry. Do not put local database paths, API keys, or
profile ids in the registry manifest.

## MCP Contract

Public MCP tools are:

- `memory.add`
- `memory.search`
- `memory.observe`
- `memory.prepare_context`
- `memory.explain_turn`
- `memory.reconstruct_context`
- `memory.explain_evidence_path`
- `memory.commit_outcome`
- `memory.record_feedback`
- `memory.maintain`
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
sensitive override rejection, turn explanation, and evidence-path explanation
without printing memory content or the real SQLite path.

## HTTP Contract

The HTTP adapter exposes the same public memory operations over loopback HTTP.
It should normally be started with an auth token:

```bash
curl -H "Authorization: Bearer local-dev-token" \
  http://127.0.0.1:4787/runtime-info
```

Useful endpoints:

- `GET /health`
- `GET /healthz`
- `GET /runtime-info`
- `GET /tools`
- `GET /status`
- `GET /openapi.json`
- `GET /profiles`
- `POST /profiles`
- `GET /keys`
- `GET /evolution/review`
- `POST /add`
- `POST /search`
- `POST /observe`
- `POST /prepare`
- `POST /explain-turn`
- `POST /reconstruct`
- `POST /explain-path`
- `POST /commit-outcome`
- `POST /feedback`
- `POST /maintain`
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

`GET /health` and `GET /healthz` are intentionally open. `GET /healthz` is for
container/service health checks and returns only `{ ok, version }`. All other
endpoints return `401` when legacy `authToken` is set or `--keys` is enabled
and the request is missing
`Authorization: Bearer <token>`. In scoped-key mode, profile allowlist failures
return `403 profile_forbidden`. CORS is off by default; pass explicit
`--cors-origin` values when a browser host needs access.

There is no HTTP profile deletion route. Use `forget()` for user-requested
memory deletion and trusted CLI/SDK workflows for database administration.

## Memory Console

Start the local web console with the hardened service command:

```bash
gmos serve --db ./gmos.db --profile local --keys --port 4787 --console
```

Then open `/console/` on the same service origin. The shell is static and
unauthenticated, but it contains no memory data. Paste a scoped API key in the
browser; the key is kept only in memory plus `sessionStorage`, never cookies or
`localStorage`.

Scope behavior:

- `read` keys can open overview/status, search context-safe memories, inspect
  allowed memory evidence/timelines, and run explain-turn.
- `readwrite` keys also see Forget and Maintain controls. The UI previews
  forget matches through `POST /search` before enabling `POST /forget`, and
  dry-runs `POST /maintain` before enabling a real maintenance run.
- `admin` keys additionally see profile lists, key metadata, and
  `GET /evolution/review` proposals. The console renders copyable CLI commands
  for evolution apply; it does not render an apply button.

The console does not add write capability. It calls only existing audited HTTP
routes plus the read-only `GET /evolution/review` route, and it never renders
sensitive override switches, key creation, evolution apply, or evolution revert.

Run the HTTP smoke example:

```bash
npm run examples:http-adapter
```

The example starts an ephemeral localhost server, verifies auth, records an
ordinary observation, imports an explicit preference memory, prepares
evidence-backed context, reads status, and deletes its temporary plaintext
SQLite database.

## Self-Hosting

Docker:

```bash
docker compose up --build
docker compose exec gmos gmos keys create --db /data/gmos.db --label agent --scope readwrite --profiles default
```

The container binds `0.0.0.0` internally so Docker can publish the port. The
compose file publishes `127.0.0.1:4787:4787`; widen that only deliberately.
`GET /healthz` is unauthenticated and returns only `{ ok, version }`.

Bare Node:

```bash
gmos keys create --db ./gmos.db --label agent --scope readwrite --profiles default
gmos serve --db ./gmos.db --profile default --keys --host-iface 127.0.0.1 --port 4787
```

Always-on templates live in `examples/service/`.

## Clients

JS/TS:

```ts
import { GmosClient } from "@ghast/memory/client";

const memory = new GmosClient({
  baseUrl: "http://127.0.0.1:4787",
  apiKey: process.env.GMOS_API_KEY!,
});
await memory.prepareTurn({ profileId: "default", text: "release plan" });
```

Python:

```python
from gmos_client import GmosClient

memory = GmosClient("http://127.0.0.1:4787", api_key)
memory.observe({"profileId": "default", "role": "user", "content": "User opened the release planning thread."})
```

The Python client has no runtime dependencies and is kept under `python/`; it is
not included in the `@ghast/memory` npm tarball.

LangChain-style JS agent:

```ts
import { GmosClient, GmosLangChainMemory } from "@ghast/memory/client";
const client = new GmosClient({ baseUrl, apiKey });
const memory = new GmosLangChainMemory(client, { profileId: "default" });
const vars = await memory.loadMemoryVariables({ input: "release plan" });
await memory.saveContext({ input: "release plan" }, { output: "ship it" });
```

Python agent:

```python
from gmos_client import GmosAgentMemory, GmosClient
client = GmosClient(base_url, api_key)
memory = GmosAgentMemory(client, profile_id="default")
ctx = memory.load_memory_variables({"input": "release plan"})
memory.save_context({"input": "release plan"}, {"output": "ship it"})
```

Plain MCP host:

```bash
gmos mcp serve --db ./gmos.db --profile default
```

```json
{"tool":"memory.prepare_context","args":{"messages":[{"role":"user","content":"release plan"}]}}
```

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
