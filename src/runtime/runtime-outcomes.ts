import { redactForReport } from "../kernel/safety.js";
import {
  GMOS_METADATA_REFERENCE_SCHEMAS,
  markedGmosMetadata,
} from "../kernel/metadata-schema.js";
import type {
  CommitOutcomeStoreInput,
  FailureKind,
  FeedbackSignalStoreInput,
  MemoryOSOptions,
  MemorySensitivityClassifierInput,
  RecordFailureInput,
  Sensitivity,
  TaskTrajectoryInput,
} from "../kernel/types.js";
import {
  redactRuntimePayloadRecord,
  type RuntimeSensitivityClassifier,
} from "./runtime-safety.js";

function sensitivityForParts(
  parts: Array<string | undefined>,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surfaces: MemorySensitivityClassifierInput["surface"][],
): Sensitivity {
  let result: Sensitivity = "normal";
  for (const part of parts) {
    if (!part) continue;
    for (const surface of surfaces) {
      const sensitivity = classifyRuntimeSensitivity(part, surface);
      if (sensitivity === "secret_like") return "secret_like";
      if (sensitivity === "sensitive") result = "sensitive";
    }
  }
  return result;
}

function runtimeTextForStorage(
  content: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  surfaces: MemorySensitivityClassifierInput["surface"][],
): string {
  const sensitivity = sensitivityForParts([content], classifyRuntimeSensitivity, surfaces);
  if (sensitivity === "normal") return content;
  const redacted = redactForReport(content);
  if (redacted !== content) return redacted;
  return sensitivity === "secret_like" ? "[redacted_secret]" : "[redacted_sensitive]";
}

function failureContentForStorage(
  content: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  additionalSurfaces: MemorySensitivityClassifierInput["surface"][] = [],
): string {
  return runtimeTextForStorage(
    content,
    classifyRuntimeSensitivity,
    ["failure", ...additionalSurfaces],
  );
}

function taskTrajectoryTextForStorage(
  content: string,
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
  additionalSurfaces: MemorySensitivityClassifierInput["surface"][] = [],
): string {
  return runtimeTextForStorage(
    content,
    classifyRuntimeSensitivity,
    ["task_trajectory", ...additionalSurfaces],
  );
}

export async function recordRuntimeFailure(
  store: MemoryOSOptions["store"],
  input: {
    profileId: string;
    failureKind: FailureKind;
    content: string;
    createdAt?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    additionalSurfaces?: MemorySensitivityClassifierInput["surface"][] | undefined;
  },
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Promise<void> {
  await store.recordFailure(runtimeFailureForStorage(input, classifyRuntimeSensitivity));
}

export function runtimeFailureForStorage(
  input: {
    profileId: string;
    failureKind: FailureKind;
    content: string;
    createdAt?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    additionalSurfaces?: MemorySensitivityClassifierInput["surface"][] | undefined;
  },
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): RecordFailureInput {
  return {
    profileId: input.profileId,
    failureKind: input.failureKind,
    content: failureContentForStorage(
      input.content,
      classifyRuntimeSensitivity,
      input.additionalSurfaces,
    ),
    createdAt: input.createdAt,
    metadata: markedGmosMetadata(
      redactRuntimePayloadRecord(input.metadata, classifyRuntimeSensitivity),
      GMOS_METADATA_REFERENCE_SCHEMAS.failureMemoryLinks,
    ),
  };
}

export function runtimeTaskOutcomeForStorage(
  input: {
    profileId: string;
    taskId?: string | undefined;
    objective: string;
    status: "completed" | "failed";
    summary?: string | undefined;
    failureKind?: FailureKind | undefined;
    createdAt?: string | undefined;
  },
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): TaskTrajectoryInput | null {
  const additionalSurfaces: MemorySensitivityClassifierInput["surface"][] =
    input.status === "failed" ? ["failure"] : [];
  const sensitivity = sensitivityForParts(
    [input.taskId, input.objective, input.summary],
    classifyRuntimeSensitivity,
    ["task_trajectory", ...additionalSurfaces],
  );
  if (sensitivity !== "secret_like") {
    return {
      profileId: input.profileId,
      taskId: input.taskId
        ? taskTrajectoryTextForStorage(
            input.taskId,
            classifyRuntimeSensitivity,
            additionalSurfaces,
          )
        : undefined,
      objective: taskTrajectoryTextForStorage(
        input.objective,
        classifyRuntimeSensitivity,
        additionalSurfaces,
      ),
      summary: input.summary
        ? taskTrajectoryTextForStorage(
            input.summary,
            classifyRuntimeSensitivity,
            additionalSurfaces,
          )
        : undefined,
      status: input.status,
      createdAt: input.createdAt,
    };
  }
  return null;
}

export function runtimeCommitOutcomeForStorage(
  input: {
    profileId: string;
    taskId?: string | undefined;
    objective: string;
    status: "completed" | "failed";
    summary?: string | undefined;
    failureKind?: FailureKind | undefined;
    createdAt: string;
    usedMemoryIds?: string[] | undefined;
  },
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): CommitOutcomeStoreInput | null {
  const outcome = runtimeTaskOutcomeForStorage(input, classifyRuntimeSensitivity);
  if (!outcome) return null;
  return {
    ...outcome,
    usedMemoryIds: input.usedMemoryIds,
    ...(input.status === "failed"
      ? {
          failure: runtimeFailureForStorage(
            {
              profileId: input.profileId,
              failureKind: input.failureKind ?? "task_failure",
              content: input.summary ?? input.objective,
              createdAt: input.createdAt,
              ...(input.usedMemoryIds ? { metadata: { usedMemoryIds: input.usedMemoryIds } } : {}),
              additionalSurfaces: ["task_trajectory"],
            },
            classifyRuntimeSensitivity,
          ),
        }
      : {}),
  };
}

export function runtimeFeedbackForStorage(
  input: {
    profileId: string;
    content: string;
    failureKind?: FailureKind | undefined;
    createdAt: string;
    relatedMemoryIds?: string[] | undefined;
    signal?: "positive" | "negative" | undefined;
  },
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): FeedbackSignalStoreInput {
  return {
    ...runtimeFailureForStorage(
      {
        profileId: input.profileId,
        failureKind: input.failureKind ?? "wrong_recall",
        content: input.content,
        createdAt: input.createdAt,
        ...(input.relatedMemoryIds ? { metadata: { relatedMemoryIds: input.relatedMemoryIds } } : {}),
      },
      classifyRuntimeSensitivity,
    ),
    relatedMemoryIds: input.relatedMemoryIds,
    signal: input.signal,
  };
}

export async function recordRuntimeTaskOutcome(
  store: MemoryOSOptions["store"],
  input: {
    profileId: string;
    taskId?: string | undefined;
    objective: string;
    status: "completed" | "failed";
    summary?: string | undefined;
    failureKind?: FailureKind | undefined;
    createdAt?: string | undefined;
  },
  classifyRuntimeSensitivity: RuntimeSensitivityClassifier,
): Promise<"recorded" | "skipped_secret_like"> {
  const outcome = runtimeTaskOutcomeForStorage(input, classifyRuntimeSensitivity);
  if (outcome) {
    await store.recordTaskTrajectory(outcome);
    return "recorded";
  }
  if (input.status === "failed") {
    await recordRuntimeFailure(
      store,
      {
        profileId: input.profileId,
        failureKind: input.failureKind ?? "task_failure",
        content: input.summary ?? input.objective,
        createdAt: input.createdAt,
        metadata: { taskTrajectorySkippedReason: "secret_like" },
        additionalSurfaces: ["task_trajectory"],
      },
      classifyRuntimeSensitivity,
    );
  }
  return "skipped_secret_like";
}
