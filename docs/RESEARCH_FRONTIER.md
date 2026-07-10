# Research Frontier: Memory System Design Paradigms (2026 H1)

This page distills the 2026 first-half arXiv literature on agent memory into
the paradigm signals that inform the gmOS roadmap. It exists so roadmap bets
are traceable to evidence about where the field is going, not to fashion.
Each signal lists the primary sources and what gmOS does about it.

## Signal 1 — Memory is graduating from storage to experience

"From Storage to Experience" (arXiv:2605.06716) formalizes three stages:
Storage (trajectory preservation), Reflection (trajectory refinement), and
Experience (trajectory abstraction). The frontier stage is defined by
cross-trajectory abstraction (patterns synthesized across many interactions)
and proactive exploration (the memory system actively seeks what it is
missing instead of passively recording).

gmOS position: M3 procedure distillation and M2/M7 consolidation/dossiers are
stage-three mechanisms with a governance twist (host hooks, evidence links).
Gap: distillation only abstracts within same-objective clusters, and nothing
is proactive. Response: Horizon 3 adds gap-driven proactive exploration
(deterministic detection of user-model blind spots surfaced as ask-the-user
action policies) and cross-trajectory abstraction beyond objective equality.

Shipped in M15: deterministic proactive gap detection and curiosity action
policies are maintained as a rebuildable derived index with privacy gates.

## Signal 2 — Agent-native systems thinking: white-box, workload-aligned

"Are We Ready For An Agent-Native Memory System?" (arXiv:2606.24775) studies
12 memory systems across five benchmarks: no architecture dominates, and
end-to-end scores hide operational cost, update correctness, and long-horizon
stability. It calls for modular designs evaluated per component (retrieval
precision, representation fidelity, update correctness, stability) and for
localized maintenance over global reorganization.

gmOS position: strongly aligned — Memory Gym gates are white-box contract
tests, maintain() is localized and bounded, and the release gate tracks p95
cost. Gap: we do not yet publish per-component metrics. Response: M12
benchmark publication gains a component-level report (retrieval precision on
fixtures, update correctness, long-horizon stability from the
experience-horizon suites, maintenance cost) alongside end-to-end scores.

## Signal 3 — Learned memory policies over heuristics, with provenance credit

MemQ (arXiv:2605.08374) assigns credit to memories through a provenance DAG —
which memories were retrieved when each new memory was created — propagating
TD(lambda) credit backward with depth decay, and wins across six benchmarks.
Memory-R1 and AgeMem train RL policies over store/retrieve/update/summarize/
discard operations. The 2026 surveys (arXiv:2602.06052, arXiv:2603.07670)
name learned memory-operation policies a defining capability of
next-generation systems.

gmOS position: the evidence ledger IS a provenance DAG, and
commitOutcome({ usedMemoryIds }) already carries the outcome signal — we have
the substrate these methods require, which most systems lack. Gap: credit
stops at directly-used memories; policy parameters are static config.
Response (two deliberate bets):
- Provenance-weighted credit, deterministic: outcome reinforcement propagates
  through evidence links (a used consolidation summary credits its source
  memories, a used procedure credits its trajectories) with bounded depth
  decay — explainable in lifecycle history, no black-box policy.
- Policy learning stays approval-gated: evolution proposals may recommend
  parameter changes (retention thresholds, fusion weights, novelty gates)
  derived from failure/outcome statistics; hosts may layer RL on top, but
  nothing self-modifies without approval. This is the auditable answer to
  black-box RL memory managers.

Shipped in M14: deterministic provenance credit and recommendation-only
parameter proposals are gym-gated without schema changes.

## Signal 4 — Memory security becomes architecture: mnemonic sovereignty

The security survey (arXiv:2604.16548, v2) maps a six-phase attack lifecycle
(write injection, store/compress toxin amplification, retrieval reactivation,
execute-time control hijack, cross-agent propagation, unrecoverable
forgetting) and defines mnemonic sovereignty: verifiable, recoverable
governance over what may be written, who may read, when updates are
authorized, what must remain auditable, and what may be forgotten. Its
Verifiable Memory Governance framework has five criteria: Write
Authorization, Provenance Visibility, Principal-Scoped Retrieval,
Rollbackability, and Verified Forgetting. SSGM (arXiv:2603.11768) and MemGuard
(arXiv:2605.28009) reinforce the same direction.

gmOS position against those five criteria: provenance visibility and verified
forgetting have strong local substrate support; write authorization is partial
because source trust and safety gates are not principal authentication;
principal-scoped retrieval remains partly host-owned; rollbackability covers
per-memory forensic rollback and profile bundles but not arbitrary complete
store snapshots at every instant. Response: Horizon 3 publishes a five-criterion
VMG compliance matrix backed by gym gates, marking each criterion full,
partial, or host-owned instead of claiming blanket compliance.

## Signal 5 — Temporal semantics beyond dialogue time

"Beyond Dialogue Time" (arXiv:2601.07468) separates event time from dialogue
time and attaches validity intervals so preferences and facts can expire and
supersede; Zep-lineage temporal knowledge graphs push the same direction.

gmOS position: already shipped — eventTime/validFrom/validTo, temporal
validity windows, current-vs-history recall, superseded/out_of_window
exclusion reasons in explainTurn. This signal validates an existing bet;
the remaining work is keeping it visible in benchmarks and docs.

## Signal 6 — Substrate diversification: context vs latent vs parametric

KEEP (arXiv:2602.23592) and the KV-cache line (IndexMem, arXiv:2605.25475)
frame three memory substrates: parametric (weights), context (text/records),
latent (compressed states / KV artifacts). Latent memory is gaining ground
for cost reasons.

gmOS position: deliberately context-substrate — auditability, evidence
links, explainability, and forgetting compliance all depend on inspectable
records; latent substrates currently cannot honor them. Response: watch, do
not build. Keep the door open by allowing hosts to attach opaque artifacts
(hashes/references, never authoritative state) to evidence events, so a
future latent cache can be provenance-tracked without becoming a second
source of truth. Revisit when latent-memory work shows an auditability
story.

## Net Assessment

The field is converging on exactly the properties gmOS chose as invariants —
provenance, governed writes, verifiable forgetting, white-box evaluation,
temporal validity. The differentiated next-generation position is not a new
retrieval trick; it is: (1) verifiable memory governance measured against the
five VMG criteria, (2) experience learning with provenance-weighted,
approval-gated credit instead of black-box RL, and (3) proactive user-model gap
exploration for the digital-twin goal. Horizon 3 in the roadmap encodes these
three bets.
