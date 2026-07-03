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
  snapshots,
});
```

The importer skips person and secret-like snapshots by default before they enter
the gmOS store. Repeated imports are idempotent when the host provides stable
metadata keys.

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
| source file bytes | `sourceFileHash` used in evidence payload and stable event keys |

mem0 extraction provenance is not gmOS evidence. Imported records are labeled
`metadata.importSource = "mem0"` and `provenance = "low_level_import"`. The
evidence event records that the import happened and links the source file hash;
it does not claim the original mem0 extraction was observed by gmOS. Re-imports
are idempotent by `sourceFileHash + recordIndex`. Secret-like records are
rejected, and person-routed records require the same explicit person opt-in as
low-level `add()`.

## Conversation Log Import

Conversation log import is an alias for the transcript ingestion pipeline from
M10:

```bash
gmos import --from conversation --db ./gmos.db --profile local \
  --input-file ./thread.jsonl --input-format jsonl
```

Supported formats are `jsonl`, `claude-code`, `openai-thread`, and auto-detect
when `--input-format` is omitted. The import path calls `observe()`; it does not
run linguistic synthesis inside gmOS.

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
