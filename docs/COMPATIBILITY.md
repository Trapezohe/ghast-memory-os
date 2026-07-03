# gmOS Compatibility Matrix

This matrix lists integration surfaces with automated checks in this repo. Rows
without a real check are intentionally omitted.

| Surface | Minimum / mode | Verified by |
| --- | --- | --- |
| SDK | Node >=20.19, in-process SQLite | `npm run build`; `npm test` (`test/run-tests.ts` package/runtime and store checks); `npm run test:consumer` (`test/consumer-install-smoke.mjs`) |
| MCP stdio | `gmos mcp serve` | `npm test` (`test/run-tests.ts` MCP client checks); `npm run test:consumer` installed stdio smoke |
| HTTP + JS client | Loopback HTTP service with bearer auth or scoped keys | `npm test` (`test/run-tests.ts` HTTP route and `GmosClient` route-shape checks); `npm run examples:http-adapter` |
| Python client | Python >=3.10, stdlib-only transport | `npm run check:python-client` (`python/tests/test_client.py`) |
| Docker | Local container with `/data/gmos.db` | `scripts/docker-smoke.sh` |
| Claude Code adapter | Hook bridge over local HTTP | `npm run examples:claude-code` |
| OpenAI-compatible runtimes | Function-tool and extractor examples | `npm run examples:openai-compatible-extractor`; `npm run examples:openai-agent-memory` |
| Agent wrapper duck types | JS `GmosLangChainMemory`, Python `GmosAgentMemory` | `npm test` (`test/run-tests.ts` wrapper stub checks); `npm run check:python-client` |
| Profile bundle import/export | `gmos export/import`, `gmos backup/restore`, optional encrypted bundle | `npm test` (`test/run-tests.ts` profile bundle, legacy restore, encryption, CLI checks) |
| mem0 import | Bare array and `{ results: [...] }` JSON exports | `npm test` (`test/run-tests.ts` mem0 fixture and CLI checks) |
| Conversation log import | JSONL, Claude Code, OpenAI thread transcript ingestion | `npm test` (`test/run-tests.ts` transcript ingestion and `import --from conversation` CLI checks) |

The compatibility claim is exactly the checked surface above. A framework or
runtime not listed here may still work through MCP, HTTP, or the client wrappers,
but it is not claimed as verified until a check lands in this repo.
