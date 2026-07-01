import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS, createOpenAICompatibleExtractor } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-openai-compatible-extractor-"));
const dbPath = path.join(tmp, "openai-compatible-extractor.db");

function fakeOpenAICompatibleFetch(_url, init) {
  const request = JSON.parse(init?.body ?? "{}");
  const event = JSON.parse(request.messages?.find((message) => message.role === "user")?.content ?? "{}");
  const content = event.event?.content ?? "";
  const memories = [];

  if (/release planning/iu.test(content)) {
    memories.push({
      kind: "preference",
      content: "Release planning response style: risk first, then options.",
      confidence: 0.91,
      predicate: "user.preference",
      subject: "user",
      object: "risk first, then options",
      actionPolicyKind: "prefer",
    });
  }

  if (/Project Vega owner/iu.test(content)) {
    memories.push({
      kind: "project",
      content: "project:vega current owner is Avery Stone.",
      confidence: 0.9,
      predicate: "project.owner",
      subject: "project:vega",
      subjectAliases: ["Vega"],
      object: "Avery Stone",
      cardinality: "single",
    });
  }

  if (/do not auto-send/iu.test(content)) {
    memories.push({
      kind: "boundary",
      content: "project:vega status updates must not be auto-sent without approval.",
      confidence: 0.94,
      predicate: "boundary.do_not_push",
      subject: "project:vega",
      object: "auto-send status updates without approval",
      actionPolicyKind: "do_not_push",
    });
  }

  return Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({ memories }),
          },
        },
      ],
    }),
  });
}

try {
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({
    profileId: "openai-compatible-user",
    store,
    extractor: createOpenAICompatibleExtractor({
      name: "fake-openai-compatible-extractor",
      model: "fake-memory-model",
      fetch: fakeOpenAICompatibleFetch,
      includeEventMetadata: true,
    }),
    reconstruction: {
      cueExtractor({ text }) {
        const cues = [];
        if (/\bvega\b/iu.test(text)) cues.push({ cue: "project:vega", cueKind: "entity" });
        if (/owner/iu.test(text)) cues.push({ cue: "project.owner", cueKind: "predicate" });
        if (/approval/iu.test(text)) cues.push({ cue: "approval", cueKind: "lexical" });
        return cues;
      },
    },
  });

  const preferenceReport = await memory.observeWithReport({
    type: "conversation.message",
    profileId: "openai-compatible-user",
    role: "user",
    content: "For release planning, use risk first, then options.",
    metadata: { speaker: "Mira", speakerKind: "person" },
    createdAt: "2026-06-25T00:00:00.000Z",
  });
  assert.equal(preferenceReport.extraction?.acceptedCandidateCount, 1);

  await memory.observe({
    type: "conversation.message",
    profileId: "openai-compatible-user",
    role: "user",
    content: "Project Vega owner is Avery Stone.",
    createdAt: "2026-06-25T00:01:00.000Z",
  });

  await memory.observe({
    type: "conversation.message",
    profileId: "openai-compatible-user",
    role: "user",
    content: "For Project Vega status updates, do not auto-send without approval.",
    createdAt: "2026-06-25T00:02:00.000Z",
  });

  const prepared = await memory.prepareTurn({
    profileId: "openai-compatible-user",
    messages: [{ role: "user", content: "How should we handle Vega status updates?" }],
    includeEvidence: true,
  });

  assert.match(prepared.contextBlock, /Avery Stone|risk first|auto-sent|approval/iu);
  assert.equal(prepared.actionPolicies.length >= 1, true);
  assert.equal(prepared.evidence.length >= 1, true);

  const reconstructed = await memory.reconstructContext({
    profileId: "openai-compatible-user",
    query: "Who owns project Vega and what approval boundary applies?",
    reconstructionIntent: {
      queryCues: ["project:vega", "project.owner", "approval"],
      requiredTagGroups: [
        { name: "owner", tags: ["project.owner", "world_belief", "project"] },
        { name: "boundary", tags: ["boundary.do_not_push", "boundary"] },
      ],
    },
    maxSteps: 2,
    maxBranch: 4,
    includeEvidence: true,
  });

  assert.match(reconstructed.contextBlock, /Avery Stone|auto-sent|approval/iu);
  assert.equal(reconstructed.paths.length > 0, true);

  await memory.close();

  console.log(JSON.stringify({
    ok: true,
    dbPath: "[temporary plaintext sqlite]",
    acceptedCandidateCount: preferenceReport.extraction.acceptedCandidateCount,
    memoryCount: prepared.memories.length,
    actionPolicyCount: prepared.actionPolicies.length,
    evidenceCount: prepared.evidence.length,
    reconstructedPathCount: reconstructed.paths.length,
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
