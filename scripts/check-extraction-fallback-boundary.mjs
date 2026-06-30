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
    name: "reconstruction-has-no-tool-use-template-filter",
    pass:
      !/SPECIFIC_TOOL|tool_scope_mismatch|memorySpecificToolCueRejectReason|associationSpecificToolCueRejectReason|I\\s\+use|uses\\s\+.*for/u.test(
        reconstruction,
      ),
    detail: "Reconstruction must rely on generic source, cue, and intent coverage, not tool-use templates.",
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
