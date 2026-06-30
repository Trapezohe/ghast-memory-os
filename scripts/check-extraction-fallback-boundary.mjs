import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(path.join(root, relativePath), "utf8");
}

const runtime = read("src/runtime/create-memory-os.ts");
const extraction = read("src/kernel/extraction.ts");
const associations = read("src/kernel/associations.ts");
const entities = read("src/kernel/entities.ts");
const personIdentity = read("src/kernel/person-identity.ts");
const reconstruction = read("src/kernel/reconstruction.ts");
const safety = read("src/kernel/safety.ts");
const store = read("src/store/sqlite/index.ts");
const types = read("src/kernel/types.ts");
const publicObserveBoundaryFiles = [
  "README.md",
  "docs/API_REFERENCE.md",
  "docs/ARCHITECTURE.md",
  "docs/BENCHMARKING.md",
  "docs/INTEGRATION_GUIDE.md",
  "docs/MIGRATION.md",
  "docs/README.md",
  "src/cli/gmos.ts",
  "examples/agent-adapter.mjs",
  "examples/http-adapter.mjs",
  "examples/mcp-router.mjs",
  "examples/quickstart.mjs",
];

const broadSemanticExtractionPatterns = [
  /extractLegacyRuleMemoryCandidates/u,
  /firstPerson(?:Preference|Attribute|Event|NamedRelation)/u,
  /namedPerson(?:Tool|Preference|CurrentAttribute|StableAttribute|DirectAttribute|Event|Relation)Candidate/u,
  /personCurrentAttributePredicate/u,
  /project(?:CurrentState|StateChange|HistoricalState)Candidate/u,
  /I\\s\+use/u,
  /my\\s\+current/u,
  /我(?:最|更)?(?:喜欢|偏好)/u,
  /我的\\s\*/u,
  /predicate:\s*"person\.(?:tool|preference|location|hometown|role|relation)"/u,
];

const productionSemanticFallbackPatterns = [
  /function\s+sourceContentEntityCues/u,
  /hasFirstPersonAnchor/u,
  /inferSpeakerPrefix/u,
  /inferredProjectSubjectFromActionText/u,
  /metadataSpeakerIsNonPerson/u,
  /contentHasExplicitNonPersonSpeaker/u,
  /nonPersonSpeakerCandidate/u,
  /candidateSpeakerIsNonPerson/u,
  /NON_PERSON/u,
  /OBVIOUS_TECH/u,
  /CHINESE_NON_PERSON/u,
  /NON_SPEAKER_PREFIX/u,
];

const publicObserveSemanticPatterns = [
  /\b(?:gmos|node\s+dist\/cli\/gmos\.js)\s+observe\b[^\n]*(?:I\s+prefer|preference|prefer|我喜欢|偏好)/iu,
  /\bobserveMessage\s*\(\s*\{[\s\S]{0,240}?content:\s*["'`][^"'`\n]*(?:I\s+prefer|preference|prefer|我喜欢|偏好)/iu,
  /\bmemory\.observe\s*\(\s*\{[\s\S]{0,240}?content:\s*["'`][^"'`\n]*(?:I\s+prefer|preference|prefer|我喜欢|偏好)/iu,
  /(?:records?|observes?)\s+(?:a\s+)?preference\s+(?:through|via)\s+[`'"]?\/?observe/iu,
  /(?:records?|observes?)\s+(?:a\s+)?preference\s+(?:through|via)\s+[`'"]?memory\.observe/iu,
];

const publicBuiltInExtractorClaimPatterns = [
  /built-in\s+default\s+extractor/iu,
  /built-in\s+extractor/iu,
  /built-in\s+safe\s+boundary\s+rules?/iu,
  /safe\s+rule\s+candidates?/iu,
  /narrow\s+safe\s+rule/iu,
  /rule\s+fallback\s+is\s+limited/iu,
  /observe\(\)\s+.*built-in/iu,
];

function publicObserveSemanticExampleMatches() {
  const matches = [];
  for (const relativePath of publicObserveBoundaryFiles) {
    const content = read(relativePath);
    const hasStructuredExtractor = /extractor\s*:\s*\{/u.test(content);
    for (const pattern of publicObserveSemanticPatterns) {
      if (pattern.test(content)) {
        if (relativePath.startsWith("examples/") && hasStructuredExtractor) {
          continue;
        }
        matches.push(relativePath);
        break;
      }
    }
  }
  return matches;
}

const publicObserveSemanticExamples = publicObserveSemanticExampleMatches();

function publicBuiltInExtractorClaimMatches() {
  const matches = [];
  for (const relativePath of publicObserveBoundaryFiles) {
    const content = read(relativePath);
    for (const pattern of publicBuiltInExtractorClaimPatterns) {
      if (!pattern.test(content)) continue;
      matches.push(relativePath);
      break;
    }
  }
  return matches;
}

const publicBuiltInExtractorClaims = publicBuiltInExtractorClaimMatches();

function ruleExtractorIsEmpty() {
  return /export\s+function\s+extractSafeRuleMemoryCandidates\([^)]*\)\s*:\s*MemoryExtractionCandidate\[\]\s*\{\s*return\s*\[\];\s*\}/u.test(
    extraction,
  );
}

function runtimePassesTemporalInferOptionOnly() {
  return /inferTemporalFromText:\s*(?:\(\s*)?options\.temporal\?\.inferFromText(?:\s*\))?\s*,/u.test(
    runtime,
  );
}

const forgetCoreSources = [
  ["src/runtime/create-memory-os.ts", runtime],
  ["src/store/sqlite/index.ts", store],
];

const forgetCommandStripperPatterns = [
  /\b(?:strip|remove|trim|clean|sanitize)\w*(?:Forget|Delete|Remove)\w*(?:Command|Query|Prefix|Instruction)|\b(?:Forget|Delete|Remove)\w*(?:Command|Prefix)\w*(?:Terms?|Pattern|Regex)/u,
  /(?:forget|delete|remove)[\w\s_-]*(?:command|prefix|verb)|(?:command|prefix|verb)[\w\s_-]*(?:forget|delete|remove)/iu,
  /FORGET_COMMAND_TERMS|HAN_FORGET_COMMAND_PATTERN|forgetMatchTerms/u,
  /\.replace\([^;\n]*(?:forget|delete|remove|忘记|删除|移除)[^;\n]*\)/iu,
  /忘记|删除|移除|删掉|清除/u,
  /please\s+(?:forget|delete|remove)|forget\s+what\s+i\s+said|delete\s+what\s+i\s+said|what\s+i\s+said\s+about/iu,
  /(?:^|[^A-Za-z])(?:forget|delete|remove)\s+(?:my|the|old|stale|memory|contact|project|about)\b/iu,
];

function forgetCoreHasCommandStripper() {
  const matches = [];
  for (const [relativePath, content] of forgetCoreSources) {
    for (const pattern of forgetCommandStripperPatterns) {
      if (pattern.test(content)) {
        matches.push(relativePath);
        break;
      }
    }
  }
  return matches;
}

const forgetCommandStripperMatches = forgetCoreHasCommandStripper();

const checks = [
  {
    name: "runtime-default-rule-mode-none",
    pass: /options\.extraction\?\.ruleMode\s*\?\?\s*"none"/u.test(runtime),
    detail: "createMemoryOS must default rule extraction to none.",
  },
  {
    name: "runtime-passes-rule-mode-to-extractor",
    pass: /extractRuleMemoryCandidates\([^)]*\{\s*mode:\s*ruleMode\s*\}/su.test(runtime),
    detail: "createMemoryOS must pass the configured rule mode into rule candidate generation.",
  },
  {
    name: "kernel-plan-no-implicit-rule-fallback",
    pass: /input\.fallbackToRules\s*\?\?\s*false/u.test(extraction),
    detail: "extractMemoryCandidatePlan must not default to rule fallback.",
  },
  {
    name: "runtime-no-implicit-rule-fallback",
    pass: /fallbackToRules:\s*options\.extraction\?\.fallbackToRules\s*\?\?\s*false/u.test(runtime),
    detail: "createMemoryOS must not implicitly enable rule fallback.",
  },
  {
    name: "temporal-text-inference-default-off",
    pass: /const\s+inferTemporalFromText\s*=\s*input\.inferTemporalFromText\s*\?\?\s*false/u.test(
      extraction,
    ),
    detail: "Built-in language/date text inference must stay explicit opt-in.",
  },
  {
    name: "runtime-passes-temporal-infer-option",
    pass: runtimePassesTemporalInferOptionOnly(),
    detail: "Runtime must pass only the host-provided temporal text inference option.",
  },
  {
    name: "safe-rule-extractor-is-empty",
    pass: ruleExtractorIsEmpty(),
    detail:
      "extractSafeRuleMemoryCandidates must stay empty; durable semantic extraction belongs to configured extractors, not built-in language templates.",
  },
  {
    name: "no-runtime-legacy-rule-mode",
    pass:
      !/RuleExtractionMode\s*=\s*[^;\n]*"legacy"/u.test(types) &&
      !/mode === "legacy"/u.test(extraction) &&
      !/ruleMode:\s*"legacy"/u.test(runtime),
    detail: "Broad linguistic rule extraction must not be available as a runtime fallback mode.",
  },
  {
    name: "production-has-no-do-not-push-rule-template",
    pass:
      !/DO_NOT_PUSH_RULE_PATTERN/u.test(extraction) &&
      !/do not remind|don't remind|do not push|don't push|不要再提醒|别再提醒|不要主动提|不要再推/iu.test(
        extraction,
      ),
    detail: "Production extraction must not synthesize do_not_push memory from hard-coded language templates.",
  },
  {
    name: "production-extraction-has-no-broad-semantic-rules",
    pass: broadSemanticExtractionPatterns.every((pattern) => !pattern.test(extraction)),
    detail: "Production extraction must not contain open-ended linguistic memory templates.",
  },
  {
    name: "production-has-no-semantic-speaker-fallback",
    pass: productionSemanticFallbackPatterns.every(
      (pattern) =>
        !pattern.test(runtime) &&
        !pattern.test(associations) &&
        !pattern.test(entities) &&
        !pattern.test(personIdentity) &&
        !pattern.test(reconstruction) &&
        !pattern.test(safety),
    ),
    detail:
      "Production runtime must not infer speaker/person/project identity from content templates or expanding non-person word lists.",
  },
  {
    name: "source-speaker-cues-require-typed-speaker-kind",
    pass:
      /sourceMetadataSpeakerIsPerson\(metadata\)/u.test(associations) &&
      /sourceMetadataSpeakerIsPerson\(sourceMetadata\)/u.test(entities) &&
      /sourceMetadataSpeakerIsPerson\(input\.eventMetadata\)/u.test(runtime),
    detail:
      "Speaker source cues must require structured speakerKind metadata instead of trusting a bare speaker string.",
  },
  {
    name: "association-cues-are-not-tool-use-templates",
    pass: !/I\\s\+use|uses\\s\+.*for|preferred\\s\+.*tool|tool\\s\+\(\?:is\|=\)/u.test(associations),
    detail: "Association cue extraction may parse entity prefixes, not tool-use benchmark templates.",
  },
  {
    name: "association-cues-have-no-language-term-lists",
    pass:
      !/\b(?:STOP_TERMS|PRIORITY_TERMS)\b/u.test(associations) &&
      !/现在|什么|怎么|那个|这个|之前|上次|项目|计划|边界|偏好|下一步|answer/u.test(
        associations,
      ),
    detail:
      "Production association cue extraction must use structural information signals, not expanding language-specific stopword or priority lists.",
  },
  {
    name: "reconstruction-has-no-tool-use-template-filter",
    pass:
      !/SPECIFIC_TOOL|tool_scope_mismatch|memorySpecificToolCueRejectReason|associationSpecificToolCueRejectReason|I\\s\+use|uses\\s\+.*for/u.test(
        reconstruction,
      ),
    detail: "Reconstruction must rely on generic source, cue, and intent coverage, not tool-use templates.",
  },
  {
    name: "reconstruction-has-no-language-intent-fallback",
    pass:
      !/\bincludesAny\s*\(/u.test(reconstruction) &&
      !/temporal_recent_hint|GENERATED_CUE_STOP_TERMS|["'`][^"'`\n]*(?:最近|刚才|上次|latest|recent|last)[^"'`\n]*["'`]/iu.test(
        reconstruction,
      ),
    detail:
      "Reconstruction must not infer intent, recency, or history from language keyword lists; hosts should pass structured intent or temporal mode.",
  },
  {
    name: "forget-has-no-language-command-stripper",
    pass: forgetCommandStripperMatches.length === 0,
    detail:
      "Core forget paths must not strip hard-coded natural-language delete commands; hosts should pass targetTerms or forgetTargetParser." +
      (forgetCommandStripperMatches.length > 0
        ? ` Matched: ${forgetCommandStripperMatches.join(", ")}.`
        : ""),
  },
  {
    name: "forget-empty-terms-do-not-match-all",
    pass: /function\s+memoryMatchesForgetQuery[\s\S]*if\s*\(\s*terms\.length\s*===\s*0\s*\)\s*return\s+false/u.test(
      store,
    ),
    detail: "Empty forget terms must not match every candidate.",
  },
  {
    name: "forget-empty-literal-query-archives-nothing",
    pass: /const\s+terms\s*=\s*parsedTerms\s*\?\?\s*queryTerms\(input\.query\);[\s\S]{0,160}if\s*\(\s*terms\.length\s*===\s*0\s*\)\s*\{\s*return\s*\{\s*archivedMemoryIds:\s*\[\]\s*\}/u.test(
      store,
    ),
    detail: "Blank or punctuation-only literal forget queries must archive nothing.",
  },
  {
    name: "public-observe-examples-do-not-imply-semantic-preference-extraction",
    pass: publicObserveSemanticExamples.length === 0,
    detail:
      "Public docs, examples, and CLI help must use observe for ordinary events only; durable semantic memory must use add() or a configured structured extractor." +
      (publicObserveSemanticExamples.length > 0
        ? ` Matched: ${publicObserveSemanticExamples.join(", ")}.`
        : ""),
  },
  {
    name: "public-docs-do-not-claim-built-in-semantic-extractor",
    pass: publicBuiltInExtractorClaims.length === 0,
    detail:
      "Public docs, examples, and CLI help must not imply a built-in/default/safe semantic extractor exists." +
      (publicBuiltInExtractorClaims.length > 0
        ? ` Matched: ${publicBuiltInExtractorClaims.join(", ")}.`
        : ""),
  },
];

const failures = checks.filter((check) => !check.pass);
if (failures.length > 0) {
  process.stderr.write(
    `Extraction fallback boundary check failed:\n${failures
      .map((failure) => `- ${failure.name}: ${failure.detail}`)
      .join("\n")}\n`,
  );
  process.exit(1);
}

process.stdout.write("[gmos] extraction fallback boundary scan passed\n");
