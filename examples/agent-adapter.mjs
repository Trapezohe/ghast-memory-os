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
  const memory = createMemoryOS({
    profileId: "agent-user",
    store,
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

  await adapter.observeMessage({
    role: "user",
    content: "我喜欢发布计划先列风险，再给最小可行步骤。",
  });
  await adapter.observeMessage({
    role: "user",
    content: "Project Atlas 不要主动推上线，必须先等 rollback review。",
  });

  const turn = await adapter.prepareTurn({
    messages: [
      {
        role: "user",
        content: "Atlas 发布计划下一步怎么做？",
      },
    ],
    task: { intent: "release planning", topic: "Project Atlas" },
  });

  assert.equal(turn.modelMessages[0]?.role, "system");
  assert.match(turn.modelMessages[0]?.content ?? "", /风险|rollback review|不要主动推上线/);
  assert.equal(turn.prepared.evidence.length > 0, true);
  assert.equal(turn.actionPolicies.length > 0, true);

  await adapter.commitOutcome({
    taskId: "agent-example-release-plan",
    objective: "Draft a safe Project Atlas release plan",
    status: "completed",
    summary: "The agent proposed a risk-first plan and waited for rollback review.",
  });
  await adapter.recordFeedback({
    content: "这个节奏对，之后 Atlas 相关计划继续先列风险。",
  });

  const forgetResult = await adapter.forget({
    query: "先列风险",
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
