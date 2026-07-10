# gmOS Migration Guide

This guide is for host applications moving from an existing memory store or
early gmOS alpha integration to the public SDK boundary.

## Migration Principles

- Keep the existing host memory store readable until migration is verified.
- Import through public host helpers or CLI commands, not private SQLite schema
  writes.
- Prefer synthetic QA data for rehearsals; do not publish real user memory.
- Keep gmOS local-first and plaintext unless the host adds its own filesystem
  controls.
- Do not run two independent primary memory systems after cutover.

## Snapshot Import

Hosts with an existing memory store should project records into host memory
snapshots and import them through `@ghast/memory/host`:

```ts
import { loadHostMemorySnapshotsIntoStore } from "@ghast/memory/host";

await loadHostMemorySnapshotsIntoStore({
  store,
  profileId: "local-user",
  memories: snapshots,
});
```

The importer skips person and secret-like snapshots by default before they enter
the gmOS store. Sensitivity is inferred from both `scope` and `content`; an
explicit sensitivity may raise that result but cannot downgrade it. Read paths
repeat the scope check so rows written by older alpha builds fail closed.
Imported rows are explicitly marked as external-trust runtime lineage and
host-snapshot imports. Repeated imports and stale-import archival use only that
marker-owned identity; an unrelated memory with matching `hostImportKey` or
`hostSnapshotImport` fields cannot block or be archived by a sync. Existing
current-schema evidence is reusable only when its owner, deterministic event key,
source, content, sensitivity, eligibility, and schema-owned payload identity all
match the snapshot. Caller metadata is preserved after public sanitization,
except for reserved gmOS control fields.

## Profile Bundles, Backup, And Restore

Use safe profile bundles for portable QA and rollback:

```bash
gmos export --db ./gmos.db --profile local --mode safe --output-file ./profile-bundle.json
gmos import --db ./new-gmos.db --profile local-restored --input-file ./profile-bundle.json
```

`gmos backup` and `gmos restore` are aliases over the same profile bundle
machinery. New bundles use `schema: "gmos.profile_bundle.v2"`. Restores keep
accepting the older `gmos.profile_backup.v1` schema forever.

Safe bundles exclude archived, sensitive, and person memories by default. They
include dormant memories because dormant records are still user memory, just
excluded from ordinary context. A FULL bundle is required for a lossless device
move because safe mode intentionally omits archived, sensitive, and person
records. Use `--mode full` only for explicit trusted migrations with appropriate
handling of local files.

When `includeSensitive` is false, bundle export and parsing use a stricter
identity-key check than public evidence inspection. Canonical session identities
such as `sessionId`, `sessionKey`, and `sessionDistillationKey` cannot enter a
SAFE document merely because their surrounding evidence or metadata has a
recognized gmOS marker. Public evidence APIs keep their separate contract: they
may return otherwise-safe evidence after redacting canonical identity fields.

New gmOS-owned evidence payloads receive a versioned `_gmosSchema` marker when
they are created. Only a recognized marker grants gmOS ownership of payload
references. Unmarked payloads, payloads that merely reuse a gmOS source-type or
old producer-shaped envelope, and unknown future marker versions are preserved as
opaque host data. This marker-only boundary avoids an impossible and destructive
guess between old internal rows and host events that happen to share the same
shape. Restore batch-resolves evidence identities, topologically orders only
owned session dependencies, rejects owned cycles, and rejects any incoming ID
already owned by another profile before writing.

Evidence payloads created by builds before this marker contract remain readable
and byte-structurally portable, but their internal IDs are not rewritten during a
cross-profile restore. Keep the original source database or restore to the same
profile when forensic rollback/provenance references from those alpha builds must
remain operational. There is intentionally no general implicit legacy heuristic:
an automatic guess would risk silently corrupting host-owned payloads. The only
narrow upgrade adapters are the package's own historical mem0 import, host
snapshot import, and CLI profile-snapshot envelopes. Those adapters require the
complete old envelope, exact profile/source/event identity, exact linked evidence,
and the absence of any marker before atomically backfilling the current markers.
Missing, extra, mismatched, or cross-profile fields remain opaque.

Within a known marker version, remapping is field-specific. gmOS rewrites only
the reference fields declared by that schema and preserves unrelated extension
fields, even when an extension happens to be named `memoryId` or `actions` under
a schema that does not own those fields.

Reference-bearing memory, world-belief, snapshot, and failure metadata now uses
the composable `_gmosMetadataSchemas` marker. Each recognized capability owns
only the fields in its registry shape. Unmarked metadata, unknown capabilities,
and unrelated fields on a marked record remain opaque host data: backup/restore
preserves them but does not remap, validate, or use them as lifecycle, retention,
provenance, deduplication, or failure-control signals. Runtime `add()`/`update()`
strips this reserved marker from caller metadata; hosts using the lower-level
`MemoryStore` API may opt into a known capability explicitly.

Runtime and host-import boundaries also remove known gmOS control fields from
caller metadata before adding their own capabilities. A caller cannot inherit an
existing marker and replace annealing, source trust, provenance links, lifecycle
state, distillation identity, or import ownership during `add()`, `update()`, or
extractor writes. Structured temporal fields such as `eventTime` remain ordinary
validated memory metadata.

The same authority check applies outside backup. Forget redaction, rollback,
evolution revert, provenance credit, maintenance statistics, distillation
deduplication, and lifecycle explanation interpret only recognized evidence and
metadata schemas. Pre-marker alpha fields stay readable and portable, but are
not executable history or control-plane state.

Portable bundle encryption is file-level, not SQLite encryption:

```bash
export GMOS_BUNDLE_PASSPHRASE="use a local secret manager in real migrations"
gmos export --db ./gmos.db --profile local --mode full \
  --passphrase-env GMOS_BUNDLE_PASSPHRASE \
  --output-file ./profile-bundle.encrypted.json
gmos import --db ./new-gmos.db --profile local \
  --passphrase-env GMOS_BUNDLE_PASSPHRASE \
  --input-file ./profile-bundle.encrypted.json
```

`--passphrase-env` takes an environment variable name, never the passphrase
itself. Encrypted bundle envelopes use AES-256-GCM with a random 16-byte salt,
12-byte nonce, and a 32-byte key derived by scrypt (`N=16384`, `r=8`, `p=1`).
Wrong passphrases and tampering fail closed before restore.

## Evidence Identity V2

New conversation-message and session-distillation evidence keys use a
profile-bound SHA-256 structured identity. This removes delimiter ambiguity and
prevents identical message identifiers in different profiles from colliding.
Existing legacy keys remain readable and are reused when a profile actually
contains them; version-aware negative caching avoids repeated legacy table probes
while invalidating on same-store restores, legacy inserts, and commits from other
SQLite connections, including changes between messages in one ingest call.
For recognized marker-bearing conversation and session rows, cross-profile
restores canonicalize both legacy and v2 keys and merge semantically identical
incoming evidence before memory references are written. Unmarked pre-contract
rows remain opaque and receive stable restore identities instead.

Restore obtains an immediate SQLite write lock before reading target identities
or owner rows. Identity resolution, five-table owner/conflict checks, core rows,
derived vectors, and association rebuild commit atomically. Calling restore from
inside an existing SQLite transaction fails closed because a nested savepoint
cannot upgrade an outer deferred transaction to this guarantee.
If vector or association reconstruction fails, the complete profile restore is
rolled back. Restoring an archived memory also removes stale lifecycle and
supersession capabilities instead of leaving active memory marked as archived or
superseded.

For conversation messages, a blank or missing `messageId` now receives a fresh
identifier and a blank or missing `createdAt` uses observation time. A non-empty
invalid timestamp fails immediately. Hosts do not need to rewrite old databases
or bundles before upgrading.

Public session-summary memory metadata now reports `sessionEvidenceCount`
instead of exposing `sessionEvidenceIds`, `sessionDistillationEvidenceId`, or the
internal deduplication key. Full provenance remains available to trusted profile
backup/restore through the session evidence event.

Custom extractor and session-distiller hooks no longer receive raw conversation
route identifiers. Extractor events omit `conversationId` and `messageId`,
route metadata including `sourceId` is removed, and the evidence
`eventKey`/`sourceUri` are replaced
with a call-local marker and `null`. Session-distiller context similarly omits
`conversationId`, `sessionId`, and `sourceUri` and uses call-local evidence
aliases. If a hook previously used these fields to branch, move that grouping
logic to the host before ingest or derive the distinction from message content;
gmOS still performs profile/session grouping internally before invoking the
hook.

## mem0 Import

mem0 exports can be imported from either a bare array or `{ "results": [...] }`:

```bash
gmos import --from mem0 --db ./gmos.db --profile local --input-file ./mem0.json
```

Mapping is structural only:

| mem0 field | gmOS field |
| --- | --- |
| `memory` or `text` | memory content |
| `metadata.kind`, `metadata.memoryKind`, `metadata.memory_kind`, `metadata.gmosKind`, `metadata.gmos_kind` when already a gmOS kind | memory kind |
| no explicit supported kind | `fact` |
| `metadata.scope` | scope |
| `id` | `metadata.importSourceOriginalId` |
| source file bytes | `sourceFileHash` used in evidence payload and the import revision |

mem0 extraction provenance is not gmOS evidence. Imported records are labeled
`metadata.importSource = "mem0"` and `provenance = "low_level_import"`. The
evidence event records that the import happened and links the source file hash;
it does not claim the original mem0 extraction was observed by gmOS. Re-imports
use the normalized source record `id` as the stable identity; source-file hash
and record index belong to the revision. Records without a non-empty explicit
`id` are skipped as `invalid_record`: synthesizing an id from array position
would either merge unrelated exports or let reordered files bypass an archived
identity. A v14 database whose legacy original id equals its record index is
rejected during upgrade because the old alpha format cannot prove whether that
id was explicit or synthesized; re-export those records with stable ids before
retrying. Import
metadata cannot supply `_gmosMetadataSchemas`, provenance links, annealing, or
other gmOS control fields; the importer assigns external source trust itself.
An incompatible host event occupying a deterministic import key fails closed,
while a compatible current-marker evidence-only partial import resumes by
writing the missing memory. A legacy evidence-only partial cannot be upgraded
atomically through the generic store contract, so it fails before any memory
write instead of creating a mixed current-memory/legacy-evidence state. Matching
the schema marker alone is insufficient: the importer also
checks the evidence owner, event key, source, content, sensitivity, eligibility,
and schema-owned import identity before reuse. Secret-like records are rejected,
and person-routed records require the same explicit person opt-in as low-level
`add()`.

SQLite imports are batch-atomic and require a store implementation of the narrow
atomic import capability. Evidence, memory, vector/association projections, and
the local identity claim either commit together or all roll back. A custom store
without that capability receives a capability error; gmOS does not fall back to
separate `recordEvidence()` and `addMemory()` calls.

Databases produced by pre-v15 alpha importers are upgraded on the first writable
open. gmOS accepts only a complete, owner-bound historical memory/evidence pair,
rewrites its event and metadata identity to the canonical v2 form, and builds the
local HMAC claim in the same immediate transaction. Compatible duplicate or old
host revisions are deterministically archived through the full lifecycle path;
conflicting or ambiguous bindings fail the migration before its v15 marker or
identity secret is committed. A look-alike host row never becomes executable
import state.

## Conversation Log Import

Conversation log import is an alias for the transcript ingestion pipeline from
M10:

```bash
gmos import --from conversation --db ./gmos.db --profile local \
  --input-file ./thread.jsonl --input-format jsonl
```

Supported formats are `jsonl`, `claude-code`, `openai-thread`, and auto-detect
when `--input-format` is omitted. The import path records per-message evidence
through `ingestConversation()` windows; it does not run linguistic synthesis
inside gmOS.

## Encryption At Rest

Encryption is an open-time store option, not a SQLite schema migration; it does
not change the schema version. A host that wants encryption should open the source or target
store with `createSqliteMemoryStore({ encryption: { driver, key, pragmas } })`
and run normal import, backup, restore, or cutover checks through that opened
store. gmOS does not rewrite an existing plaintext database into an encrypted
file by itself and does not manage key custody.

## SQLite Schema v8

Schema v8 adds first-class lifecycle signals to `gmos_memories`:

- `recall_count INTEGER NOT NULL DEFAULT 0`
- `last_recalled_at TEXT NULL`
- `reinforcement REAL NOT NULL DEFAULT 0`

Existing rows migrate in place with `recall_count = 0`,
`last_recalled_at = NULL`, and `reinforcement = 0`. No row is demoted during
schema migration. Lifecycle transitions happen only when the host explicitly
invokes `maintain()`.

The first maintenance run on an old profile may demote stale active memories to
`dormant` if their retention score is below the configured threshold. Preview it
first:

```bash
gmos maintain --db ./gmos.db --profile local --dry-run --format markdown
```

If the preview is acceptable, run the same command without `--dry-run`.
`boundary` and `person` memories are exempt from automatic transitions by
default. Dormant memories remain available to history recall and can be restored
to active by `commitOutcome({ usedMemoryIds })` when a host reports actual use.

## SQLite Schema v9

Schema v9 makes the memory vector index provider-aware. `gmos_memory_vectors`
adds:

- `provider_name TEXT NOT NULL DEFAULT 'local-hash-v1'`
- `embedding_status TEXT NOT NULL DEFAULT 'embedded'`

Existing local hash vectors migrate in place as `local-hash-v1` with 384
dimensions. When a host configures an embedding provider, health reports normal
eligible memories with old provider names or dimensions as stale provider rows.
Provider failures during writes store fallback local vectors with pending status;
`repairSearchIndex({ vectorBatchSize })` backfills pending/stale rows in bounded
batches.

Sensitive and person memories remain on local fallback vectors unless the host
explicitly opts in through provider config. Secret-like content is never sent to
the provider.

## SQLite Schema v10

Schema v10 rebuilds the derived full-text indexes as external-content FTS5
tables. `gmos_memories_fts` and `gmos_associations_fts` become
`content='gmos_memories'` / `content='gmos_associations'` tables maintained by
`AFTER INSERT/UPDATE/DELETE` triggers on their base tables, and the store
enables `PRAGMA recursive_triggers` so `INSERT OR REPLACE` cannot bypass the
delete trigger.

This fixes an O(N^2) ingest blowup: the previous standalone FTS tables were
deleted through `WHERE id = ?` on an UNINDEXED column, which SQLite executes
as a full virtual-table scan, so every memory insert scanned the whole
association index. Ingest throughput is now flat with profile size.

The migration drops and recreates both FTS structures and repopulates them
from source rows; it is idempotent and runs automatically on first open.
Search-index health changes semantics under external content: when the FTS
integrity check fails, `missingEntryCount` reports the total indexed-memory
count (repair rebuilds the whole index) instead of a per-row gap count.

## SQLite Schema v11

Schema v11 adds service-mode tables:

- `gmos_profiles` for explicit profile creation through `POST /profiles`;
- `gmos_api_keys` for scoped API keys, storing only sha256 secret hashes;
- `gmos_http_audit_log` for content-free HTTP request audit rows.

The migration is automatic on first writable open. `gmos doctor` and
`/status` row counts include the new tables. Profile JSON backups created by
`gmos backup --mode safe` and `--mode full` do not include service API keys,
key hashes, or HTTP audit rows; they remain profile memory backups. Whole
SQLite database file backups include those service tables and should be treated
as sensitive operational data.

Legacy `GMOS_HTTP_AUTH_TOKEN` mode keeps working. Scoped-key mode starts only
when `gmos serve --keys` or the programmatic HTTP server `scopedKeys` option is
used.

## SQLite Schema v12

Schema v12 adds safe autopilot service state:

- `gmos_autopilot_runs` stores content-free one-shot run history;
- `gmos_api_keys.default_disposition` stores an optional default recall
  disposition for scoped HTTP keys.

The migration is automatic on first writable open. `gmos autopilot run` writes a
history row only for non-dry-run executions, then prunes to the configured
`--history-retention` count. The stored report contains ids, reasons, counts,
timing, and phase summaries; it must not contain memory content.

Profile JSON backups still do not include service tables. Whole SQLite database
file backups include autopilot run history and service key metadata.

## SQLite Schema v13

Schema v13 adds `gmos_api_keys.history_access`, defaulting to `1` for existing
and new scoped HTTP keys. Keys created with `gmos keys create
--no-history-access` store `0` and cannot use HTTP history-purpose recall or
archived/dormant visibility. The migration is automatic on first writable open.

Profile JSON bundles still do not include service API keys, key hashes,
`history_access`, HTTP audit rows, or autopilot run rows. Whole SQLite database
file backups include those service tables and should be treated as sensitive
operational data.

## SQLite Schema v14

Schema v14 adds `gmos_gap_candidates`, a derived proactive-exploration index
rebuilt by `maintain({ phases: ["explore"] })`. The table stores stable gap ids,
gap kind, subject/cue, score, supporting record ids, structured payload, and
`computedAt`. It is not a source of truth and can be cleared/recomputed from
memories, world beliefs, associations, task trajectories, evidence, and failure
signals.

The migration is automatic on first writable open. Profile JSON backups may
include the table only as rebuildable derived data; hosts should treat it like
associations or FTS/vector indexes and prefer an `explore` run after restore.
Read-audit snapshots include the table so `prepareTurn()` curiosity emission
stays read-pure.

## SQLite Schema v15

Schema v15 adds the local-only `gmos_import_identities` ledger and
`gmos_store_secrets` identity key. The ledger binds one stable host or mem0
source identity to its current revision, evidence, memory, binding digest, and
lifecycle disposition. It contains only domain-separated HMAC digests, never raw
source URIs, source ids, or memory content. Composite foreign keys prevent a
claim from crossing profile ownership.

The migration and import writers use `BEGIN IMMEDIATE`, so separate processes
cannot create two memories for the same identity. Active and dormant bindings
are reused. Host snapshot disappearance records `host_import_stale` and can
restore the same id when the exact revision returns. Manual, safety, retention,
consolidation, and forget transitions set a blocking disposition; changing the
source file or revision does not create a replacement for a blocked stable
identity.

Profile backups do not serialize either operational table. FULL trusted restore
revalidates complete import pairs and derives new target-local HMAC values inside
the restore transaction. SAFE restore strips host/mem0 authority markers from
both memory metadata and evidence payloads and creates no import claim.

## M3 Experience Learning

M3 does not add a SQLite schema version. Procedure distillation, outcome
reinforcement, feedback confidence penalties, and evolution apply/revert reuse
existing memory, task trajectory, failure, and evidence tables. Already-distilled
clusters and evolution revert state are derived from `gmos_evidence_events`
payloads instead of new columns.

## Index Repair

Derived indexes can be rebuilt after import or SQLite drift:

```bash
gmos repair --db ./gmos.db --search-index --dry-run --vector-batch-size 32
gmos repair --db ./gmos.db --associations
```

Repair rebuilds derived FTS, vector, and association projections from stored
source rows. It must not create new user memory facts.

## Cutover Checklist

1. Run import or restore into a fresh gmOS database.
2. Run `gmos doctor --db ./gmos.db --host ghast --format markdown`.
3. Run `gmos status --db ./gmos.db --profile local --host ghast --format markdown`.
4. Run `npm run gate:pr` in the SDK repo for runtime confidence.
5. Run host-specific E2E for observe, prepare, reconstruct, forget, incognito,
   secret-like content, PERSON isolation, and do-not-push behavior.
6. Switch the host to public SDK, CLI, MCP, HTTP, or host adapter APIs.
7. Remove or explicitly deprecate old primary memory paths.
8. Keep rollback backup artifacts until dogfood has covered ordinary usage.

## Rollback

Rollback should restore the previous host memory path and keep the gmOS database
for diagnosis. Do not merge partially migrated SQLite rows back into a legacy
store without an explicit host-owned migration script.
