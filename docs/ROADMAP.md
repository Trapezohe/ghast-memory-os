# gmOS Roadmap: From Runtime Kernel To Experience-Learning Memory OS

This roadmap describes how gmOS evolves from the current late-alpha runtime
kernel into a local-first, evidence-driven, reconstructive, forgettable,
explainable, benchmarkable, and agent-pluggable open-source Agent Memory OS.
The product direction is unchanged: help personal agents learn user experience
over long horizons and become second-brain and digital-twin infrastructure,
instead of remaining a top-k memory lookup layer.

The roadmap is planning material. Shipped behavior is documented in the
[API reference](./API_REFERENCE.md) and [architecture](./ARCHITECTURE.md)
pages, not here.

## Where alpha.69 Stands

Already shipped and gated:

- evidence ledger, world beliefs, task trajectories, and failure events as
  sources of truth, with derived association/FTS/vector indexes;
- bounded active reconstruction (`prepareTurn`, `reconstructContext`) with
  read-path purity audits;
- safety gates: secret-like rejection, incognito exclusion, PERSON isolation,
  explicit `forget()` with residue cleanup, do-not-push action policies;
- host extraction boundary: durable memory candidates come from host
  extractors or explicit imports, never from built-in linguistic synthesis;
- SDK, CLI, MCP stdio, local HTTP, host snapshot import/sync adapters;
- Memory Gym contract suites, scale smoke, host compatibility reports,
  deterministic external adapters, release evidence bundles.

Main gaps against the vision:

1. **Forgetting is explicit-only.** `forget()` archives on request, but there
   is no salience tracking, no passive decay, no dormancy lifecycle. A second
   brain that never forgets passively cannot prioritize what matters.
2. **Experience does not accumulate.** `commitOutcome()` and
   `recordFeedback()` persist events, but usage and outcomes do not feed back
   into memory strength, and repeated task trajectories are not distilled
   into reusable procedures. The evolution module is propose-with-approval.
3. **Recall is lexical.** FTS plus hashed 384-dim feature vectors is a
   deterministic baseline, not semantic recall. There is no pluggable
   embedding provider and no hybrid rank fusion.
4. **Explainability stops at evidence paths.** `explain()` and
   `explainEvidencePath()` answer "where did this come from", but not "why was
   this in context", "why was that excluded", or "what did maintenance do".
5. **Benchmarks measure recall contracts, not experience learning.** No suite
   measures preference adherence over time, forgetting compliance, or
   procedure reuse across sessions.
6. **Integration is SDK-shaped.** MCP/HTTP exist, but there are no turnkey
   adapters for common agent runtimes, and no encryption-at-rest option.

## Invariants (Every Milestone)

These are contract, not preference. No milestone may trade them away:

- **Local-first.** SQLite on the user's disk stays the default. No cloud
  custody, no required network calls in the kernel.
- **Evidence-first writes.** Every durable mutation, including lifecycle
  transitions performed by maintenance, records evidence and is reversible
  (archive, never silent delete).
- **Read-path purity.** `prepareTurn`, `reconstructContext`,
  `explainEvidencePath`, and all new explain/report reads stay write-free and
  read-audited. Usage signals ride existing write paths.
- **Extraction boundary.** The kernel never synthesizes user facts or
  summaries linguistically. Anything generative (consolidation summaries,
  embeddings, procedure descriptions) is a host-provided hook with kernel-side
  gates, like `extractor` today.
- **Safety gates cannot be weakened** for benchmark scores or convenience.
  Boundaries and person memory are excluded from passive decay by default.
- **Deterministic core.** Same inputs, same store, same outputs. Model-backed
  hooks are optional and replaceable by deterministic fallbacks.
- **Benchmarks are diagnostics.** No dataset-specific runtime branches; the
  no-benchmark-special-casing scan stays in the gate.

## M1 — Memory Lifecycle: Salience, Decay, Dormancy

Goal: make forgetting a first-class, evidence-backed lifecycle instead of an
explicit-delete-only feature.

- Track usage signals on memories: `recall_count`, `last_recalled_at`,
  reinforcement from feedback. Signals are written only through write paths:
  `commitOutcome({ usedMemoryIds })` and a new explicit `maintain()` API.
  Read paths stay pure.
- Deterministic retention scoring per memory from recency, usage, confidence,
  kind, and feedback, with per-kind half-life configuration. `boundary` and
  `person` kinds never auto-decay by default.
- New lifecycle state `dormant` between `active` and `archived`: excluded
  from ordinary context like `archived`, still reachable through `history`
  recall and status-filtered search, always reversible.
- `memory.maintain({ dryRun })` SDK API, `gmos maintain` CLI, and MCP tool:
  computes retention, applies transitions, writes lifecycle evidence events,
  returns a per-memory explainable report. Dry-run writes nothing (verified
  by read-audit snapshots).
- Memory Gym suites for decay behavior, boundary non-decay, dormant context
  exclusion, history-mode reachability, dry-run purity, idempotence, and
  forget-on-dormant.

Non-goals: no summarization, no clustering, no model calls.

## M2 — Consolidation: Episodic To Semantic

Goal: keep the store healthy at scale by merging duplicates and letting hosts
distill episodes into durable semantic memory.

- Deterministic kernel-side consolidation: near-duplicate detection via
  normalized content and association overlap, supersede chains with evidence
  links, world-belief-aware merge for structured subjects.
- Host-provided `consolidator` hook (mirror of `extractor`): the kernel
  selects candidate clusters and enforces gates (sensitivity, PERSON,
  incognito, evidence linkage); the host may return summary candidates; the
  kernel persists them as new memories that cite the source memories as
  evidence and archives or demotes the sources.
- Consolidation phase inside `maintain()` with the same dry-run, evidence,
  and reporting contracts as M1.

## M3 — Experience Learning: Procedures, Preference Reinforcement, Evolution

Goal: move from "remembering what the user said" to "learning what works for
this user".

- Procedure distillation: repeated `task_trajectory` records with matching
  objectives become `procedure` memory candidates (deterministic trigger,
  host hook for wording), surfaced in `prepareTurn` action policies.
- Preference reinforcement: `recordFeedback` outcomes adjust confidence and
  retention of the memories that produced the behavior, both directions.
- Evolution loop upgrade from read-only review to propose-with-approval: failure
  clusters produce patch candidates a host or user explicitly applies;
  applications are evidence-backed and reversible. No auto-apply.

## M4 — Deep Explainability

Goal: every context decision is answerable.

- `explainTurn()`: for a prepared turn, report why each included memory was
  included (cues, associations, scores) and why notable candidates were
  excluded (dormant, superseded, out-of-window, sensitivity-gated,
  budget-cut).
- Lifecycle provenance in `explain()`: full event history of a memory —
  created, reinforced, decayed, consolidated, restored, forgotten — from
  evidence events.
- `gmos-inspect` timeline views over the same read-pure reports.

## M5 — Semantic Recall Upgrade

Goal: raise recall quality without breaking local-first or determinism.

- `EmbeddingProvider` interface (host-provided: local ONNX, Ollama, or remote
  at the host's choice); kernel stores vectors, never calls networks itself.
  The hashed lexical vector remains the zero-dependency fallback.
- Hybrid retrieval fusion: FTS, vector similarity, and association graph
  scores fused deterministically; reranker hook optional.
- Recall-quality report in the Gym comparing fallback vs provider-backed
  recall on the same fixtures.

## M6 — Evaluation And Ecosystem

Goal: measure experience learning honestly and make integration one command.

- Experience-learning Gym suites: preference adherence across simulated
  weeks, forgetting compliance (decayed and forgotten content stays out),
  contradiction resolution, procedure reuse rate.
- Official-protocol external benchmark support (model judge, upstream
  scoring) clearly separated from deterministic adapter baselines.
- Turnkey adapters: Claude Code memory hooks, OpenAI-compatible agent
  runtimes, LangGraph-style graph runtimes, all thin wrappers over the MCP or
  HTTP surface.
- Optional encryption at rest (SQLCipher-compatible driver) as an explicit
  opt-in store, keeping plaintext SQLite the transparent default.

## Sequencing

M1 → M2 → M3 form the experience-learning spine and land in order. M4 can
start after M1 (it explains lifecycle output). M5 and M6 are parallel tracks
once M2 is stable. Every milestone ships behind `npm run gate:pr` plus new
Gym suites, and each release keeps the release-evidence discipline already in
place.
