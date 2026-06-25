import { strict as assert } from "node:assert";

import { createMemoryOS } from "../runtime/create-memory-os.js";
import { createSqliteMemoryStore } from "../store/sqlite/index.js";

export interface MemoryGymResult {
  pass: boolean;
  score: number;
  hardGates: Record<string, boolean>;
  details: string[];
}

function gate(result: MemoryGymResult, name: string, passed: boolean, detail: string): void {
  result.hardGates[name] = passed;
  result.details.push(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
}

export async function runMemoryGym(
  options: { dbPath?: string | undefined } = {},
): Promise<MemoryGymResult> {
  const store = createSqliteMemoryStore({ path: options.dbPath ?? ":memory:" });
  const memory = createMemoryOS({ profileId: "gym", store });
  const result: MemoryGymResult = {
    pass: false,
    score: 0,
    hardGates: {},
    details: [],
  };

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我喜欢简洁的中文回答。",
    createdAt: "2026-06-25T00:00:00.000Z",
  });
  const preference = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "你之后怎么回答我？" }],
  });
  gate(
    result,
    "preference_recall",
    preference.contextBlock.includes("简洁的中文回答"),
    "preference memory should enter ordinary context",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "以后不要再提醒我 Alpha 项目延期了。",
    createdAt: "2026-06-25T00:01:00.000Z",
  });
  const boundary = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "Alpha 项目怎么样？" }],
  });
  gate(
    result,
    "do_not_push_policy",
    boundary.directives.some((directive) => directive.includes("Alpha 项目延期")),
    "boundary should become an action directive",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我的 API key 是 sk-test1234567890abcdefg，请记住。",
    createdAt: "2026-06-25T00:02:00.000Z",
  });
  const secret = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "API key 是什么？" }],
    includeSensitive: true,
    includeEvidence: true,
  });
  gate(
    result,
    "secret_like_persistence",
    !secret.contextBlock.includes("sk-test"),
    "secret-like content must not be persisted or injected",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我的 SSN 是 123-45-6789，不要再提醒我。",
    createdAt: "2026-06-25T00:02:30.000Z",
  });
  const sensitivePolicy = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "SSN 提醒策略是什么？" }],
  });
  gate(
    result,
    "sensitive_action_policy_exposure",
    !sensitivePolicy.contextBlock.includes("123-45-6789"),
    "sensitive boundary/action policy should not enter ordinary context",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我住在一个临时地址，不要长期记。",
    privacyMode: "incognito",
    createdAt: "2026-06-25T00:03:00.000Z",
  });
  const incognito = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "临时地址是什么？" }],
  });
  gate(
    result,
    "incognito_leakage",
    !incognito.contextBlock.includes("临时地址"),
    "incognito events should not become long-term memory",
  );

  await memory.observe({
    type: "conversation.message",
    profileId: "gym",
    role: "user",
    content: "我在 Moonbase 项目做发布管理。",
    createdAt: "2026-06-25T00:04:00.000Z",
  });
  const forgot = await memory.forget({ profileId: "gym", query: "Moonbase" });
  const afterForget = await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "Moonbase 项目我做什么？" }],
  });
  gate(
    result,
    "forget_compliance",
    forgot.archivedMemoryIds.length > 0 && !afterForget.contextBlock.includes("Moonbase"),
    "forget should archive matching memory and remove it from context",
  );

  const before = await store.rowCounts();
  await memory.prepareTurn({
    profileId: "gym",
    messages: [{ role: "user", content: "只读检查" }],
  });
  const after = await store.rowCounts();
  gate(
    result,
    "read_path_side_effects",
    JSON.stringify(before) === JSON.stringify(after),
    "prepareTurn must not write",
  );

  await memory.recordFeedback({
    profileId: "gym",
    content: "刚才召回了错误记忆。",
    failureKind: "wrong_recall",
  });
  const counts = await store.rowCounts();
  gate(
    result,
    "feedback_failure_log",
    counts.gmos_failure_events === 1,
    "feedback should enter failure log",
  );

  await memory.close();
  const passed = Object.values(result.hardGates).filter(Boolean).length;
  const total = Object.keys(result.hardGates).length;
  result.score = total === 0 ? 0 : passed / total;
  result.pass = result.score === 1;
  assert.equal(result.pass, true, result.details.join("\n"));
  return result;
}
