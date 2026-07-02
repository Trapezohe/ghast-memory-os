export { createMemoryOS } from "./runtime/create-memory-os.js";
export {
  defaultWorldEntityResolver,
  resolveWorldEntitySubject,
} from "./kernel/entities.js";
export { createOpenAICompatibleExtractor } from "./kernel/openai-compatible-extractor.js";
export {
  DEFAULT_AUTO_TRANSITION_KINDS,
  DEFAULT_MEMORY_HALF_LIVES_DAYS,
  memoryKindCanAutoTransition,
  resolveMemoryLifecycleConfig,
  retentionScore,
} from "./kernel/retention.js";
export {
  classifySensitivity,
  eligibleForLongTermMemory,
  isSecretLikeMemoryContent,
  redactForReport,
} from "./kernel/safety.js";
export { getGmosRuntimeInfo } from "./runtime-info.js";
export type {
  EntityResolutionInput,
  EntityResolutionResult,
  EntityResolver,
} from "./kernel/entities.js";
export type { OpenAICompatibleExtractorOptions } from "./kernel/openai-compatible-extractor.js";
export type { GmosRuntimeInfo } from "./runtime-info.js";
export type * from "./kernel/types.js";
