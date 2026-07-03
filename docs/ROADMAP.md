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

## Where alpha.70 Development Line Stands

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

Status: shipped in the alpha.70 development line. Shipped behavior is tracked in
the API reference, not this planning section.

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

Status: shipped in the alpha.70 development line. Shipped behavior is tracked in
the API reference, not this planning section.

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

Status: shipped in the alpha.70 development line. Shipped behavior is tracked in
the API reference, not this planning section.

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

Status: shipped in the alpha.70 development line. Shipped behavior is tracked in
the API reference, not this planning section.

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

Status: shipped in the alpha.70 development line. Shipped behavior is tracked in
the API reference, not this planning section.

Goal: raise recall quality without breaking local-first or determinism.

- `EmbeddingProvider` interface (host-provided: local ONNX, Ollama, or remote
  at the host's choice); kernel stores vectors, never calls networks itself.
  The hashed lexical vector remains the zero-dependency fallback.
- Hybrid retrieval fusion: FTS, vector similarity, and association graph
  scores fused deterministically; reranker hook optional.
- Recall-quality report in the Gym comparing fallback vs provider-backed
  recall on the same fixtures.

## M6 — Evaluation And Ecosystem

Status: shipped in the alpha.70 development line. Shipped behavior is tracked in
the API reference, not this planning section.

Goal: measure experience learning honestly and make integration one command.

M6a status: implemented as the `experience_horizon` gym group plus explicit
external benchmark protocol separation.

- Experience-learning Gym suites: preference adherence across simulated
  weeks, forgetting compliance (decayed and forgotten content stays out),
  contradiction resolution, procedure reuse rate.
- Official-protocol external benchmark support (model judge, upstream
  scoring) clearly separated from deterministic adapter baselines. gmOS accepts
  host-provided SDK judge callbacks for `official_protocol` runs and refuses
  official CLI runs without a judge instead of downgrading.

M6b status: implemented in the alpha.70 development line as:

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

---

# Horizon 2: From Runtime Kernel To An Open-Source Memory OS Platform

Status: M7-M12 shipped in the alpha.72 development line. Shipped behavior is
tracked in the API reference, not this planning section.

Horizon 1 (M1-M6) built the experience-learning kernel. Horizon 2 turns gmOS
into a production-form open-source Agent Memory OS that individuals and teams
can adopt the way they adopt mem0 or Hindsight today, while keeping the
positioning that neither of them owns: local-first personal memory with an
evidence ledger, enforceable safety and forgetting, deterministic replay, and
explainable context decisions.

## Competitive Frame (2026)

- mem0 ships as a pip/npm library, a self-hosted Docker server with a
  dashboard, per-user API keys and request audit logs, and a hosted platform;
  it covers 20+ framework integrations and built-in LLM extraction.
- Hindsight (MIT, Vectorize) ships four memory networks (world facts, agent
  experience, entity summaries, beliefs), hybrid retrieval (vector, BM25,
  graph, temporal), disposition-configurable reflection, and markets a 91.4%
  LongMemEval claim.

gmOS parity gaps: batteries-included intelligence (both ship LLM-powered
extraction/reflection out of the box), a hardened self-hosted service with
keys/audit/dashboard, a Python SDK, breadth of integrations, entity-level
summaries, and a public benchmark story. gmOS advantages to defend: evidence
ledger, read-path purity, safety/forgetting gates, deterministic kernel,
explainTurn, experience-horizon evaluation, release-evidence discipline.

Kernel invariants from Horizon 1 remain contract. "Batteries included" always
means official implementations of the existing host hooks, never new kernel
synthesis paths.

## M7 — Batteries-Included Intelligence (Opt-In)

Goal: first-run value without writing an extractor, while the kernel boundary
stays intact.

- New subpath export (e.g. `@ghast/memory/intelligence`) with official,
  swappable hook implementations: structured extractor, consolidator,
  procedure distiller, embedding provider, and reranker, each backed by any
  OpenAI-compatible endpoint (hosted or local Ollama/vLLM) through plain
  fetch. Zero new hard dependencies; nothing loads unless the host opts in.
- `createDefaultIntelligence({ baseUrl, apiKey, model, embedModel })` preset
  that wires all hooks with conservative defaults and full config override.
- Entity dossiers: a consolidator-family hook that maintains per-entity
  summary memories (person/project dossiers) from world beliefs and memory
  clusters — parity with entity-summary networks elsewhere, but
  evidence-linked and forget-compliant like everything else.
- Prompt-injection resistance tests for all shipped prompts; extraction
  boundary scan stays green (hooks are host-side by definition).
- Gym: recall/extraction quality report comparing no-intelligence vs preset
  against deterministic fixtures with a stub endpoint.

## M8 — Memory Service Form

Goal: `docker run ghast/gmos` is a complete self-hosted memory service.

- Harden the HTTP adapter into `gmos serve`: multi-profile management API,
  scoped API keys (per agent, read-only vs read-write vs admin), request
  audit log (who read/wrote which profile, no content in logs), rate limits,
  CORS policy, OpenAPI 3 spec generated from the tool contract.
- Docker image and compose file; launchd/systemd recipes for always-on local
  service; backup/restore endpoints honoring existing safe-backup rules.
- Python client SDK (thin typed REST client mirroring the JS facade) and a
  slim JS/TS client for browser/edge callers; both generated or verified
  against the OpenAPI spec.
- Admin operations (evolution apply, encryption keys, full backups) remain
  CLI/SDK-only; the network surface keeps refusing sensitive overrides.

## M9 — Memory Console

Goal: make explainability and control visible; this is the dashboard-parity
move and the trust differentiator.

- Local web console served by `gmos serve --console`: memory browser with
  status/kind/sensitivity filters, memory timeline (lifecycle provenance),
  explainTurn viewer (why in / why out), forget-with-preview (dry-run diff
  before archive), maintenance dry-run diff view, evolution proposal review
  and approval, health and vector-index panels.
- Static bundled SPA, no external services, no telemetry; talks only to the
  local service with an admin-scoped key.
- Every console action maps to an existing audited API; the console adds no
  new write paths.

## M10 — Continuous Learning Autopilot (Safe)

Goal: "set it and forget it" learning loops without violating explicit-write
principles.

- `gmos autopilot` (and service-mode scheduler): host-configured intervals
  for maintain phases (decay, consolidate, distill), embedding backfill, and
  ingestion-queue processing; every run is an ordinary explicit write with
  evidence, dry-run preview, and per-run report retention.
- Session ingestion pipeline: batch import of conversation logs (JSONL,
  Claude Code transcripts, OpenAI-format threads) through observe() with the
  usual gates; resumable and idempotent by event key.
- Recall disposition config: named presets controlling how assertive recall
  is (context budget, score thresholds, history inclusion), selectable
  per-agent via scoped keys.
- Gym: autopilot determinism (same queue, same clocks, same outcome), gate
  that autopilot never runs evolution apply.

## M11 — Interop And Migration

Goal: adopting gmOS costs an afternoon; leaving it costs nothing (data
freedom as a feature).

- Canonical profile export format (versioned JSONL bundle: memories, beliefs,
  evidence, trajectories) with import; encrypted portable bundles for device
  moves.
- Importers: mem0 export format, generic conversation JSONL; documented
  mapping semantics and what cannot carry over (their extraction provenance
  is not gmOS evidence and is imported as low-level records, honestly
  labeled).
- Integration packages for LangChain/LlamaIndex-style ecosystems in JS and
  Python (thin wrappers over the client SDKs), MCP registry listing,
  framework quickstarts.
- Compatibility matrix in docs, tested in CI against pinned versions.

## M12 — Credibility And Community

Goal: the numbers, docs, and governance that make "mature, trustworthy,
commercially adoptable" checkable rather than claimed.

- Official-protocol benchmark publication: LongMemEval and LoCoMo runs with a
  host model judge through the M6a machinery, published with full
  reproduction bundles (git SHA, dataset hash, judge model/settings, per-case
  outputs) in BENCHMARK_RUNS.md; an honest comparison page describing
  methodology differences vs mem0/Hindsight claims rather than bare numbers.
- Docs site (static, versioned) with task-oriented guides; API reference
  generated from source; architecture and threat-model pages.
- Community infrastructure: issue/PR templates, CODE_OF_CONDUCT, release
  cadence policy, public CI matrix (Node LTS x macOS/Linux), security
  disclosure process, upgrade/migration guarantees.
- 0.2 line criteria: public API freeze proposal, documented deprecation
  policy, 100k-memory scale targets in the gate, at least two external
  integrations in production use.

## Commercial-Form Boundary

Everything that touches user memory stays open source. A future hosted
control plane (team sync, managed judges, fleet dashboards) must build on the
same public service API and export formats, so self-hosting is never a
second-class citizen. No OSS feature may require a hosted service.

## Horizon 2 Sequencing

M7 -> M8 -> M9 is the adoption spine (value, service, visibility). M10 builds
on M7+M8. M11 and M12 run as parallel tracks once M8 stabilizes the service
API; the benchmark publication in M12 should start as soon as current public
benchmark runs conclude. Every milestone still ships behind `npm run gate:pr`
plus new gym suites, with release evidence per release.

---

# Horizon 3: Next-Generation Bets (Research-Grounded)

Status: M13-M15 shipped in the alpha.72 development line. Shipped behavior is
tracked in the API reference, not this planning section.

Grounded in the 2026 H1 literature review in
[research frontier](./RESEARCH_FRONTIER.md). Horizon 2 makes gmOS adoptable;
Horizon 3 makes it the reference next-generation architecture instead of a
competent follower. Three bets, chosen because the field's direction and
gmOS's existing invariants intersect there.

## M13 — Mnemonic Sovereignty: All Nine Primitives, Verifiably

Goal: be the first memory architecture that can check all nine governance
primitives from the 2026 security literature (arXiv:2604.16548), with gym
gates as proof rather than claims.

- Close the partials: per-write versioning with forensic rollback (snapshot
  points beyond profile backups), separation of audit-mandatory evidence
  from user-deletable memory tiers (forget keeps a content-free audit stub),
  confidence annealing for suspiciously promoted memories (rapid
  reinforcement gains decay faster until re-confirmed by independent
  evidence), trust-tiered write provenance for cross-agent and
  environmental sources (host-declared source trust levels gate promotion).
- Publish a primitive-by-primitive compliance matrix in SECURITY.md, each
  row backed by a named gym gate; add poisoning-lifecycle suites (write
  injection, compression amplification, retrieval reactivation, control
  hijack, propagation, recovery) to the experience-horizon group.
- Principal-scoped retrieval lands with M8 scoped keys; M13 extends scopes
  to memory tiers and audit access.

## M14 — Provenance-Weighted Experience Credit

Goal: close the learning loop the way MemQ-style work (arXiv:2605.08374)
points, but deterministic and explainable instead of black-box RL.

- Outcome credit propagates through the evidence DAG: a used consolidation
  summary credits its source memories, a used procedure credits its source
  trajectories, a used dossier credits its beliefs — bounded depth,
  deterministic decay per hop, visible in lifecycle history and explainTurn
  score components.
- Evolution proposals gain parameter-tuning candidates derived from outcome
  and failure statistics (retention thresholds, fusion weights, novelty
  gates), still propose-with-approval only. Hosts may run their own RL over
  the same surfaces; gmOS guarantees auditability of whatever is applied.
- Gym: credit-propagation determinism, no credit through forgotten or
  sensitivity-gated links, anneal interaction (M13) covered.

## M15 — Proactive User-Model Exploration

Goal: the digital-twin move — the memory system knows what it does not know
about the user and asks, entering the Experience stage
(arXiv:2605.06716) on gmOS terms.

- Deterministic gap detection over the user model: stale validity intervals
  on load-bearing beliefs, contradiction hotspots, low-coverage entities
  with high recall demand, procedures with decaying success rates.
- Gaps surface as a new action-policy class ("curiosity prompts") in
  prepareTurn, budgeted and boundary-aware (never probe forgotten,
  incognito, or boundary-protected topics — a do-not-ask list derived from
  the same gates), so the host agent can ask the user naturally.
- Answers flow back through observe() as ordinary evidence; a gym suite
  measures gap-closure rate across simulated weeks without violating any
  privacy gate.

## Horizon 3 Sequencing

M13 starts after M8 (needs scoped keys). M14 needs M7 (dossiers) but not the
console. M15 builds on M14's credit signals to rank gaps. All three publish
through the M12 credibility machinery. Watch-list (build only when the
research shows an auditability story): latent/KV-cache memory substrates,
parametric distillation into weights — until then, opaque host artifacts may
attach to evidence events by reference only.
