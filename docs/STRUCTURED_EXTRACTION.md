# Structured Extraction Contract

This guide describes how a host should turn observations into gmOS memory
candidates without moving product-specific language rules into gmOS core.

## Boundary

gmOS records evidence, validates candidates, writes memories and world beliefs,
projects associations, applies safety gates, and supports reconstruction. The
host owns durable meaning extraction because the host has product context such as
entity aliases, calendars, workspaces, teams, accounts, repositories, tasks, and
routing labels.

A host extractor may be a local parser, a local model, a remote model, or a
small deterministic adapter around an existing application state model. The
extractor returns structured candidates. gmOS then applies the same write-path
checks used by every input path: sensitivity classification, PERSON isolation,
incognito exclusion, confidence bounds, structured-field normalization, metadata
sanitization, and forget/read-path invariants.

For opt-in first-run hooks, `@ghast/memory/intelligence` provides
OpenAI-compatible factories for extraction, consolidation, procedure
distillation, dossier synthesis, embeddings, reranking, and
`createDefaultIntelligence()`. They remain host-side hook implementations: the
kernel boundary and write-path safety gates described here do not change.

`consolidator` is the second host meaning hook. It runs only from explicit
`maintain({ phases: ["consolidate"] })` after gmOS selects bounded clusters of
eligible active/dormant memories. Like the extractor, the hook may be local,
model-backed, or deterministic, but gmOS keeps write-path authority: it rejects
secret-like or PERSON-routed summaries, bounds confidence, deduplicates
candidates, records consolidation evidence, and never writes summary prose that
the hook did not return.

## Candidate Shape

A candidate should be concise and evidence-backed:

```ts
{
  kind: "project",
  content: "project:vega current release state is code freeze pending owner approval.",
  confidence: 0.92,
  predicate: "project.state",
  subject: "project:vega",
  object: "code freeze pending owner approval",
  cardinality: "single"
}
```

Use these fields when the source observation supports them:

- `kind`: one of the public memory kinds accepted by gmOS.
- `content`: the user-world statement that should be retrievable later.
- `confidence`: host confidence from `0` to `1`.
- `subject`: stable entity id such as `user`, `project:vega`, or `person:alex`.
- `subjectAliases`: public aliases for the subject.
- `predicate`: stable relation or state key such as `project.state`.
- `object`: concise current value for the predicate.
- `cardinality`: use `single` only when newer facts should supersede older facts
  for the same subject and predicate.
- `eventTime`, `validFrom`, `validTo`: ISO date or instant values supplied by a
  trusted parser or model.
- `actionPolicyKind`: `prefer`, `procedure`, or `do_not_push` when the memory
  should influence agent behavior.
- `metadata`: public, non-secret host metadata needed for audit.

Keep `content` in the source event language when wording matters. Do not convert
all memories into a fixed English profile sentence. Prefer explicit entity ids
and structured fields over phrasing conventions.

## Host Responsibilities

The host should provide these pieces when it has them:

- structured extractor candidates for durable user-world information;
- optional consolidator summary candidates for repeated episodic memories;
- `speakerKind: "person"` or `"human"` when a speaker should be used as a person
  cue;
- `participants` for audit-only mentions in multi-speaker transcripts;
- an `entityResolver` for application-owned ids and aliases;
- a `temporal.parser` for calendar-aware dates and ranges;
- a `reconstruction.cueExtractor` for domain-specific route, entity, and time
  cues.

The host should not rely on gmOS core to infer product meaning from expanding
phrase lists. If the host accepts natural-language control commands, parse them
before calling gmOS and pass structured operations or `targetTerms`.

## Minimal Wiring

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  extractor: {
    name: "host-structured-extractor",
    extract(input) {
      return hostExtractCandidates(input.event.content, input.event.metadata);
    },
  },
  reconstruction: {
    cueExtractor({ text, phase, maxCues }) {
      return hostExtractCues({ text, phase, maxCues });
    },
  },
});
```

For ordinary `observe()` calls, `MemoryExtractionInput` contains one
`event`/`evidence` pair. `ingestConversation()` may pass a windowed input:

```ts
{
  profileId: "local-user",
  event,      // the window's last eligible message
  evidence,   // that message's evidence event
  window: {
    messages: [
      { role: "user", content: "...", createdAt: "...", metadata: { speaker: "Alex" } },
      { role: "assistant", content: "...", createdAt: "..." }
    ],
    evidenceIds: ["evidence_...", "evidence_..."]
  }
}
```

Return the same candidate JSON shape for single-message and windowed input. A
windowed candidate may include `sourceIndex` to identify the grounding message
within `window.messages`. gmOS validates that index, writes
`metadata.sourceEvidenceId` when it maps to an eligible message, and always
stores `metadata.windowEvidenceIds` so explanation and reconstruction can reach
the full contributing window.

For consolidation, the hook receives sanitized source snapshots:

```ts
const memory = createMemoryOS({
  profileId: "local-user",
  store,
  consolidator: {
    name: "host-consolidator",
    consolidate({ kind, sharedTags, memories }) {
      return hostSummarizeCluster({ kind, sharedTags, memories });
    },
  },
});
```

Run the packaged smoke examples:

```bash
npm run examples:structured-extractor
npm run examples:openai-compatible-extractor
```

`examples/structured-extractor.mjs` demonstrates host-owned candidate generation,
host-owned cue extraction, gmOS evidence recording, action-policy projection,
context preparation, and active reconstruction.

`examples/openai-compatible-extractor.mjs` exercises
`createOpenAICompatibleExtractor()` with a fake `/chat/completions` response, so
hosts can verify provider-shaped JSON parsing and write-path validation without
network access or API keys.

See [MCP and HTTP Integration Guide](./INTEGRATION_GUIDE.md#batteries-included-intelligence)
for Ollama and OpenAI-compatible cloud setup snippets.

## Validation Checklist

Before using an extractor in a release candidate, verify that:

1. every candidate has source evidence;
2. secret-like values are not returned as content or structured fields;
3. person-specific facts use explicit `person:` subjects or typed speaker
   metadata;
4. current-state facts use `cardinality: "single"` only when supersession is
   desired;
5. temporal values are normalized ISO strings;
6. candidate metadata contains only public audit fields;
7. failed extraction does not enable a different broad extraction path;
8. external scores are reported as diagnostics unless produced by an official
   protocol run.

These checks keep gmOS aligned with its role as a local-first memory runtime
kernel rather than a phrase-template extraction engine.
