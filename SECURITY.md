# Security And Privacy

gmOS is local-first and uses plaintext SQLite by default. Hosts can opt in to
encryption at rest by supplying a BetterSqlite3-compatible cipher driver and key.
gmOS does not provide key custody, vault integration, hosted sync, or cloud
custody.

## Supported Scope

Security fixes target the current `main` branch and the latest published alpha.
Older alpha versions should be upgraded before reporting a reproduction as
current behavior.

| Version line | Security support |
| --- | --- |
| `main` | Supported for current development fixes. |
| Latest published alpha | Supported for reproducible security fixes. |
| Older alpha releases | Not supported; upgrade first and retest. |

See [release policy](./docs/RELEASE_POLICY.md) for release cadence, pre-1.0
compatibility, deprecation, and upgrade guarantees.

## Trust Model

- Host applications own filesystem permissions and database placement.
- Host applications own encryption driver selection, key generation, key
  storage, rotation, unlock UX, and memory zeroization policy.
- gmOS memory policy rejects secret-like long-term memory by default.
- Incognito/private events are not promoted to long-term memory.
- Ordinary context excludes sensitive memory unless a trusted host caller
  explicitly requests it.
- Public MCP/HTTP surfaces do not expose sensitive override switches.
- Scoped HTTP API keys are bearer secrets. gmOS stores only sha256 hashes, shows
  the secret once at creation, and never returns hashes from list routes.
- Forget operations archive matching memory and remove it from future context.
- Read paths are expected to be side-effect free and are covered by gate checks.

## Mnemonic Sovereignty Compliance

gmOS maps the nine memory-governance primitives from arXiv:2604.16548 to
executable gates. No row below is documentation-only; each named gate runs in
`gmos gym run`.

| Primitive | Implementation summary | Executable gate(s) |
| --- | --- | --- |
| Typed-write schemas with chain-of-custody provenance | `observe()` writes structured evidence with source role, source trust, event metadata, candidate schema decisions, and source event ids before memory/world-belief writes. | `experience_horizon_trust_tiered_write_provenance`, `evidence_idempotency` |
| Principal-scoped retrieval | Scoped HTTP keys carry profile allowlists, scope, default disposition, and `historyAccess`; history-purpose recall and archived/dormant visibility require that bit. | `experience_horizon_principal_history_access_scope`, `mcp_public_sensitive_rejection` |
| Compression-lineage preservation | Consolidation, distillation, dossiers, and imported summaries preserve source ids and lifecycle histories instead of replacing source evidence. | `consolidator_hook_writes_summary_and_dormant_sources`, `distillation_writes_procedure_with_trajectory_evidence`, `experience_horizon_poisoning_lifecycle` |
| Audit/deletable separation | `forget()` archives memories but keeps audit rows; evidence content for fully forgotten source events becomes a content-free sha256/length redaction stub, while shared-source evidence remains readable until all derived memories are forgotten. | `experience_horizon_forgetting_compliance_full_surface`, `explain_turn_forget_residue_redacts_content` |
| Cross-substrate deletion verification | Forget removes readable residue from memory rows, context, history recall, explanations, lifecycle payload snapshots, associations, FTS, vector indexes, and evidence read surfaces. | `experience_horizon_forgetting_compliance_full_surface`, `reconstruction_forget_repair_no_belief_residue` |
| Metadata-bearing storage | Stored memories, world beliefs, evidence, vectors, and associations carry source ids, sensitivity, provider/index state, source trust, annealing state, and lifecycle metadata. | `experience_horizon_trust_tiered_write_provenance`, `embedding_privacy_defaults`, `semantic_fusion_respects_visibility_gates` |
| Harness-level governance | The deterministic gym exercises poisoning, lifecycle, reconstruction, privacy, consolidation, distillation, and host-boundary gates as release criteria. | `experience_horizon_poisoning_lifecycle`, `secret_like_persistence`, `do_not_push_policy` |
| Snapshot/versioning with forensic rollback | Memory-mutating writes record `previousValues`; `memoryRollback()`/`gmos rollback` replay evidence chains and write rollback evidence. CLI snapshots are named full-bundle exports with content-free evidence pointers. | `experience_horizon_forensic_rollback_and_versioning`, `evolution_review_apply_revert_approval_gated` |
| Confidence annealing | Rapid non-independent boosts and lower-trust writes set annealing metadata; ranking and retention use effective capped confidence until independent confirmation. | `experience_horizon_confidence_annealing`, `experience_horizon_poisoning_lifecycle` |

## Service Boundary

`gmos serve` binds to `127.0.0.1` by default. Non-loopback interfaces require
`--allow-non-loopback` and should be placed behind host-owned TLS, firewalling,
and secret distribution. CORS is off by default; configure explicit origins
only.

The Docker image is the one intentional non-loopback exception: it starts
`gmos serve --host-iface 0.0.0.0 --allow-non-loopback` because container
networking requires an internal wildcard bind. Treat the published Docker port
as the real exposure boundary. Publish only the host interface you intend, for
example `127.0.0.1:4787:4787`, and keep key creation/revocation on the trusted
CLI.

Use one scoped key per agent or integration. `read` keys can search, prepare,
reconstruct, explain, and read status/OpenAPI. `readwrite` keys can also
observe, add, commit outcomes, record feedback, maintain, and forget. `admin`
keys can additionally list/create profiles and list key metadata. Key creation
and revocation stay CLI-only; an admin bearer token over HTTP cannot mint new
keys.

The HTTP audit table records key id, route, method, profile id, status code,
timestamp, and duration. It does not record request bodies, memory content,
query text, secrets, or prompt context. Audit rows are service state, not kernel
memory evidence, and are written only in the HTTP layer.

## Memory Console Threat Model

`gmos serve --console` serves a static shell from `/console/` without
authentication. That route intentionally contains no memory data, no embedded
API key, and no write endpoint. All data requests from the browser call the
existing HTTP API with `Authorization: Bearer <key>`, so scoped-key checks,
profile allowlists, rate limits, and the content-free audit log still apply.

Console responses set a restrictive CSP (`default-src 'self'; connect-src
'self'`), `X-Content-Type-Options: nosniff`, and
`Referrer-Policy: no-referrer`. Scripts and styles are local files under
`console/`; there are no CDN, font, analytics, telemetry, or other external
asset URLs.

The pasted API key is kept in JavaScript memory and `sessionStorage`. gmOS does
not use cookies or `localStorage` for the console: cookies would be sent
implicitly to every request on the origin, and `localStorage` would persist
longer than a tab session. `sessionStorage` still belongs to the browser profile,
so close the tab or use "Forget key" when sharing a machine.

The console deliberately does not render sensitive override switches, HTTP key
creation, evolution apply, or evolution revert. Forget and maintenance controls
must preview or dry-run first, then require typed confirmation before using the
existing audited write routes.

## Encryption At Rest

Encryption at rest protects the SQLite database file from ordinary offline reads
when the host uses a compatible cipher driver and keeps the key out of the
database directory. It does not protect memory after the host unlocks the store,
does not protect HTTP/MCP traffic, does not replace filesystem permissions, and
does not make exported profile backup JSON safe to share.

gmOS core has no cipher dependency. The host passes the driver and key:

```ts
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({
  path: "./encrypted.gmos.db",
  encryption: {
    driver: CipherDatabase,
    key: process.env.GMOS_DB_KEY ?? "",
    pragmas: ["PRAGMA cipher = 'sqlcipher'"],
  },
});
```

`createSqliteMemoryStore()` rejects empty keys, quotes, and control characters
before opening. It applies `PRAGMA key`, then host cipher pragmas, then verifies
database readability before schema setup. Wrong keys or incompatible drivers
fail closed with `SqliteMemoryStoreEncryptionError`.

Manual verification with `better-sqlite3-multiple-ciphers`:

```bash
mkdir -p /tmp/gmos-cipher-check
cd /tmp/gmos-cipher-check
npm init -y >/dev/null
npm install @ghast/memory better-sqlite3-multiple-ciphers >/dev/null
GMOS_DB_KEY='local-dev-test-key' node --input-type=module <<'EOF'
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({
  path: "./encrypted.gmos.db",
  encryption: {
    driver: CipherDatabase,
    key: process.env.GMOS_DB_KEY,
    pragmas: ["PRAGMA cipher = 'sqlcipher'"],
  },
});
const memory = createMemoryOS({ profileId: "cipher-check", store });
await memory.add({
  profileId: "cipher-check",
  kind: "preference",
  content: "Cipher check memory should require the host key.",
});
await memory.close();
EOF
GMOS_DB_KEY='local-dev-test-key' node --input-type=module <<'EOF'
import CipherDatabase from "better-sqlite3-multiple-ciphers";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const store = createSqliteMemoryStore({
  path: "./encrypted.gmos.db",
  encryption: {
    driver: CipherDatabase,
    key: process.env.GMOS_DB_KEY,
    pragmas: ["PRAGMA cipher = 'sqlcipher'"],
  },
});
await store.initialize();
console.log(store.encryptionStatus());
await store.close();
EOF
```

Repeat the second command with a different `GMOS_DB_KEY`; it should fail before
schema setup. Do not add `better-sqlite3-multiple-ciphers` to gmOS core or dev
dependencies for this check.

## Disclosure Process

Do not include real user memory, API keys, private transcripts, or production
SQLite files in a public issue.

Report suspected vulnerabilities through GitHub private vulnerability reporting
when available, or through `[INSERT PRIVATE SECURITY CONTACT]` after the
maintainer fills that placeholder. If no private channel is available, open a
public issue with only a minimal synthetic reproduction and omit sensitive data.

Expected response:

- Acknowledgement within 3 business days.
- Initial triage or request for reproduction details within 10 business days.
- Public advisory or release note after a fix is available when the issue is
  confirmed and externally relevant.

Useful reports include:

- gmOS version and commit SHA;
- Node.js version and OS;
- exact command or SDK call;
- expected result and actual result;
- a synthetic database or fixture when needed.

## Non-Security Issues

Benchmark score changes, missing product features, and expected plaintext local
storage behavior are not security vulnerabilities. File those as normal issues
or PRs.
