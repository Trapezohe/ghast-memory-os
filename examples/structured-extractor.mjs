import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-structured-extractor-"));
const dbPath = path.join(tmp, "structured-extractor.db");

function exampleStructuredExtractor(input) {
  const text = input.event.content;
  const candidates = [];

  if (/release planning thread/iu.test(text)) {
    candidates.push({
      kind: "preference",
      content: "Release planning response style: constraints first, then options.",
      confidence: 0.9,
      predicate: "user.preference",
      subject: "user",
      object: "constraints first, then options",
      actionPolicyKind: "prefer",
    });
  }

  if (/Vega release state/iu.test(text)) {
    candidates.push({
      kind: "project",
      content: "project:vega current release state is code freeze pending owner approval.",
      confidence: 0.92,
      predicate: "project.state",
      subject: "project:vega",
      object: "code freeze pending owner approval",
      cardinality: "single",
    });
  }

  if (/Vega release execution/iu.test(text)) {
    candidates.push({
      kind: "boundary",
      content: "project:vega release execution must wait for owner approval.",
      confidence: 0.95,
      predicate: "boundary.do_not_push",
      subject: "project:vega",
      object: "release execution before owner approval",
      actionPolicyKind: "do_not_push",
    });
  }

  return candidates;
}

function exampleCueExtractor({ text }) {
  const cues = [];
  if (/\bvega\b/iu.test(text)) cues.push({ cue: "project:vega", cueKind: "entity" });
  if (/release/iu.test(text)) cues.push({ cue: "release", cueKind: "lexical" });
  if (/approval/iu.test(text)) cues.push({ cue: "owner approval", cueKind: "lexical" });
  return cues;
}

try {
  const store = createSqliteMemoryStore({ path: dbPath });
  const memory = createMemoryOS({
    profileId: "structured-user",
    store,
    extractor: {
      name: "example-structured-extractor",
      extract: exampleStructuredExtractor,
    },
    reconstruction: {
      cueExtractor: exampleCueExtractor,
    },
  });

  await memory.observe({
    type: "conversation.message",
    profileId: "structured-user",
    role: "user",
    content: "User opened the release planning thread and requested a constraints-first outline.",
    createdAt: "2026-06-25T00:00:00.000Z",
  });
  await memory.observe({
    type: "conversation.message",
    profileId: "structured-user",
    role: "user",
    content: "Vega release state: code freeze pending owner approval.",
    createdAt: "2026-06-25T00:01:00.000Z",
  });
  await memory.observe({
    type: "conversation.message",
    profileId: "structured-user",
    role: "user",
    content: "Vega release execution must wait for owner approval.",
    createdAt: "2026-06-25T00:02:00.000Z",
  });

  const prepared = await memory.prepareTurn({
    profileId: "structured-user",
    messages: [{ role: "user", content: "Plan the Vega release." }],
    includeEvidence: true,
  });

  assert.match(prepared.contextBlock, /constraints first|code freeze|owner approval/iu);
  assert.equal(prepared.actionPolicies.length >= 1, true);
  assert.equal(prepared.evidence.length >= 1, true);

  const reconstructed = await memory.reconstructContext({
    profileId: "structured-user",
    query: "What should I remember for project Vega release approval?",
    reconstructionIntent: {
      queryCues: ["project:vega", "owner approval"],
      requiredTagGroups: [
        {
          name: "project_state_or_policy",
          tags: ["project.state", "boundary.do_not_push", "preference"],
        },
      ],
    },
    maxSteps: 2,
    maxBranch: 4,
    includeEvidence: true,
  });

  assert.match(reconstructed.contextBlock, /code freeze|owner approval|constraints first/iu);
  assert.equal(reconstructed.paths.length > 0, true);

  await memory.close();

  console.log(JSON.stringify({
    ok: true,
    dbPath: "[temporary plaintext sqlite]",
    memoryCount: prepared.memories.length,
    actionPolicyCount: prepared.actionPolicies.length,
    evidenceCount: prepared.evidence.length,
    reconstructedPathCount: reconstructed.paths.length,
    promptTokenEstimate: reconstructed.stats.promptTokenEstimate,
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
