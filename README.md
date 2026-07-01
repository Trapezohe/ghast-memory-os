# Ghast Memory OS

Ghast Memory OS, or gmOS, is an open-source, local-first Memory OS for
personal agents. It is built to help agents learn user experience over time,
maintain a user-world model, reconstruct relevant context from evidence, respect
privacy and forgetting, and gradually become a user's second brain and digital
twin infrastructure.

The current package is the late-alpha runtime kernel for that vision. It
provides the SDK, CLI, MCP, HTTP, plaintext SQLite storage, evidence ledger,
world beliefs, reconstructive recall, action policies, safety gates, release
evidence, and benchmark harness needed for stable integration. It is not a
finished digital twin product and it is not a vector-memory CRUD wrapper.

Project docs: [API reference](./docs/API_REFERENCE.md),
[integration guide](./docs/INTEGRATION_GUIDE.md),
[structured extraction](./docs/STRUCTURED_EXTRACTION.md),
[architecture](./docs/ARCHITECTURE.md), [benchmarking](./docs/BENCHMARKING.md),
[migration](./docs/MIGRATION.md), [contributing](./CONTRIBUTING.md),
[security and privacy](./SECURITY.md), [release checklist](./RELEASE_CHECKLIST.md).

```ts
import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const memory = createMemoryOS({
  profileId: "local-user",
  store: createSqliteMemoryStore({ path: "./gmos.db" }),
});

await memory.add({
  profileId: "local-user",
  kind: "boundary",
  content: "以后不要再提醒我这个项目延期了。",
});

const prepared = await memory.prepareTurn({
  profileId: "local-user",
  messages: [{ role: "user", content: "这个项目现在怎么办？" }],
});
```
