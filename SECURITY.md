# Security And Privacy

gmOS is local-first and uses plaintext SQLite by default. Hosts can opt in to
encryption at rest by supplying a BetterSqlite3-compatible cipher driver and key.
gmOS does not provide key custody, vault integration, hosted sync, or cloud
custody.

## Supported Scope

Security fixes target the current `main` branch and the latest published alpha.
Older alpha versions should be upgraded before reporting a reproduction as
current behavior.

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

## Service Boundary

`gmos serve` binds to `127.0.0.1` by default. Non-loopback interfaces require
`--allow-non-loopback` and should be placed behind host-owned TLS, firewalling,
and secret distribution. CORS is off by default; configure explicit origins
only.

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

## Reporting

Do not include real user memory, API keys, private transcripts, or production
SQLite files in a public issue.

Use GitHub private vulnerability reporting when available. If private reporting
is not available, open a public issue with a minimal synthetic reproduction and
omit sensitive data.

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
