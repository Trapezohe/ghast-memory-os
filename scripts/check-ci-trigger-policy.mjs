#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  assertGithubActionsTriggerPolicySelfCheck,
  inspectGithubActionsTriggerPolicy,
  workflowRequiresRunCiLabel,
} from "./lib/github-actions-trigger-policy.mjs";

assertGithubActionsTriggerPolicySelfCheck();

const root = path.resolve(import.meta.dirname, "..");
const workflowDir = path.join(root, ".github", "workflows");

for (const file of readdirSync(workflowDir).filter((entry) => /\.ya?ml$/u.test(entry)).sort()) {
  const relativePath = path.posix.join(".github/workflows", file);
  const content = readFileSync(path.join(workflowDir, file), "utf8");
  const policy = inspectGithubActionsTriggerPolicy(content);
  if (policy.pushTriggerPresent) {
    throw new Error(`${relativePath} must not define push triggers; use workflow_dispatch or label-gated PR CI`);
  }
  if (policy.pullRequestTriggerPresent && !policy.pullRequestLabeledOnly) {
    throw new Error(`${relativePath} pull_request trigger must use types: [labeled]`);
  }
  if (policy.pullRequestTriggerPresent && !workflowRequiresRunCiLabel(content)) {
    throw new Error(`${relativePath} label-gated PR CI must require the run-ci label`);
  }
}

console.log("[gmos] CI trigger policy scan passed");
