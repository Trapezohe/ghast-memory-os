import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createMemoryOS } from "@ghast/memory";
import { createAgentMemoryAdapter } from "@ghast/memory/host";
import { createSqliteMemoryStore } from "@ghast/memory/store/sqlite";

const tmp = mkdtempSync(path.join(os.tmpdir(), "gmos-agent-adapter-"));
const dbPath = path.join(tmp, "agent-memory.db");

try {
  const store = createSqliteMemoryStore({ path: dbPath });
  const structuredCandidateQueue = [];
  const memory = createMemoryOS({
    profileId: "agent-user",
    store,
    extractor: {
      name: "example-host-structured-extractor",
      extract() {
        return structuredCandidateQueue.shift() ?? [];
      },
    },
    host: {
      hostId: "generic-agent",
      capabilities: {
        canObserveConversation: true,
        canInjectSystemContext: true,
        canEnforceHardDirectives: true,
        canCommitTaskOutcomes: true,
        canRecordUserFeedback: true,
        canForget: true,
        supportsActionPolicies: true,
        supportsEvidenceInContext: true,
      },
    },
  });
  const adapter = createAgentMemoryAdapter({
    memory,
    profileId: "agent-user",
    includeEvidence: true,
    reconstruction: { mode: "shadow", maxSteps: 2, maxBranch: 3 },
  });

  structuredCandidateQueue.push([
    {
      kind: "preference",
      content: "发布计划回答风格：先列约束，再给最小可行步骤。",
      confidence: 0.9,
      predicate: "user.preference",
      subject: "user",
      object: "constraint-first release planning",
      actionPolicyKind: "prefer",
    },
  ]);
  await adapter.observeMessage({
    role: "user",
    content: "发布计划请求：请使用约束优先的最小步骤格式。",
  });
  structuredCandidateQueue.push([
    {
      kind: "boundary",
      content: "project:release-demo 不要主动进入发布执行，必须先等 owner approval。",
      confidence: 0.95,
      predicate: "boundary.do_not_push",
      subject: "project:release-demo",
      object: "auto-start release execution",
      actionPolicyKind: "do_not_push",
    },
  ]);
  await adapter.observeMessage({
    role: "user",
    content: "project:release-demo 不要主动进入发布执行，必须先等 owner approval。",
  });

  const turn = await adapter.prepareTurn({
    messages: [
      {
        role: "user",
        content: "release-demo 发布计划下一步怎么做？",
      },
    ],
    task: { intent: "release planning", topic: "project:release-demo" },
  });

  assert.equal(turn.modelMessages[0]?.role, "system");
  assert.match(turn.modelMessages[0]?.content ?? "", /约束|owner approval|不要主动进入发布执行/);
  assert.equal(turn.prepared.evidence.length > 0, true);
  assert.equal(turn.actionPolicies.length > 0, true);

  await adapter.commitOutcome({
    taskId: "agent-example-release-plan",
    objective: "Draft a safe project:release-demo release plan",
    status: "completed",
    summary: "The agent proposed a constraint-first plan and waited for owner approval.",
  });
  await adapter.recordFeedback({
    content: "这个节奏对，之后 release-demo 相关计划继续先列约束。",
  });

  const forgetResult = await adapter.forget({
    query: "先列约束",
    reason: "example cleanup",
  });
  assert.equal(forgetResult.archivedMemoryIds.length > 0, true);

  await memory.close();

  console.log(JSON.stringify({
    ok: true,
    dbPath: "[temporary plaintext sqlite]",
    contextInjected: Boolean(turn.contextMessage),
    modelMessageCount: turn.modelMessages.length,
    actionPolicyCount: turn.actionPolicies.length,
    evidenceCount: turn.prepared.evidence.length,
    promptTokenEstimate: turn.stats.promptTokenEstimate,
    archivedMemoryCount: forgetResult.archivedMemoryIds.length,
  }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
