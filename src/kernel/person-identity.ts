const NON_PERSON_SINGLE_NAMES = new Set([
  "assistant",
  "bot",
  "chatbot",
  "project",
  "repo",
  "repository",
  "the",
  "service",
  "system",
  "app",
  "tool",
  "product",
  "model",
  "agent",
  "platform",
  "robot",
  "项目",
  "工具",
  "应用",
  "产品",
  "模型",
  "系统",
  "服务",
  "团队",
  "公司",
  "组织",
  "群",
  "群聊",
  "仓库",
  "平台",
  "机器人",
  "助手",
]);

const NON_PERSON_SUBJECT_PATTERN =
  /\b(?:project|team|company|org|organization|group|support|repo|repository|service|system|app|tool|product|model|agent|inc|corp|llc|ltd|labs|research|foundation|university|school|department|committee|platform|cloud)\b/iu;

const OBVIOUS_TECH_NON_PERSON_NAME_PATTERN =
  /^(?:chatgpt|gpt(?:[-_ ]?\d[\w.-]*)?|llm(?:[-_ ]?\d[\w.-]*)?|(?:llama|qwen|mistral|gemini|deepseek|grok|glm)(?:[-_ ]?\d[\w.-]*)?|claude[-_ ]?\d[\w.-]*|(?:sonnet|opus|haiku)[-_ ]?\d[\w.-]*|(?:slack|discord|telegram|github|gitlab|linear|jira|notion)?bot)$/iu;

const CHINESE_NON_PERSON_SUBJECT_PATTERN =
  /(?:项目|工具|应用|产品|模型|系统|服务|团队|公司|组织|群聊|仓库|平台|插件|机器人|助手|客户端|浏览器|编辑器|数据库|文档|笔记|小程序)$/u;

export function isReservedSpeakerIdentity(name: string): boolean {
  const normalized = name.trim().replace(/\s+/gu, " ");
  return /^(?:current[-_ ]?user|user|self|me)$/iu.test(normalized);
}

function explicitChineseNonPersonSubject(name: string): boolean {
  const compact = name.trim().replace(/\s+/gu, "");
  if (!compact) return false;
  if (NON_PERSON_SINGLE_NAMES.has(compact)) return true;
  return CHINESE_NON_PERSON_SUBJECT_PATTERN.test(compact);
}

function explicitNonPersonSubject(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (!normalized) return false;
  if (NON_PERSON_SINGLE_NAMES.has(normalized)) return true;
  if (explicitChineseNonPersonSubject(name)) return true;
  if (OBVIOUS_TECH_NON_PERSON_NAME_PATTERN.test(normalized)) return true;
  if (
    /^(?:project|team|company|org|organization|group|support|note|reminder|fact|example|preference|task|ticket|repo|repository|service|system|app|tool|product|model|agent|inc|corp|llc|ltd|labs|research|foundation|university|school|department|committee|platform|cloud)$/iu.test(
      normalized,
    )
  ) {
    return true;
  }
  return NON_PERSON_SUBJECT_PATTERN.test(normalized);
}

export function stableNamedPersonSubject(name: string): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return false;
  if (isReservedSpeakerIdentity(trimmed)) return false;
  if (NON_PERSON_SINGLE_NAMES.has(normalized)) return false;
  if (!/\s/u.test(trimmed) && /\p{Ll}\p{Lu}/u.test(trimmed)) return false;
  return !explicitNonPersonSubject(trimmed);
}
