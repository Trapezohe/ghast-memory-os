function cleanLine(line) {
  return line.replace(/\r$/u, "").replace(/^\s*#.*$/u, "").replace(/\s+#.*$/u, "");
}

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/gu, "");
}

function parseList(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [unquote(trimmed)];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map(unquote)
    .filter(Boolean);
}

function parseBlockList(lines) {
  const itemIndent = firstChildIndent(lines);
  if (itemIndent === null) return null;
  const values = [];
  for (const line of lines) {
    if (indentOf(line) !== itemIndent) continue;
    const item = /^-\s*(.*?)\s*$/u.exec(line.trim());
    if (!item) return null;
    values.push(unquote(item[1]));
  }
  return values;
}

function splitTopLevelInlineEntries(value) {
  const entries = [];
  let start = 0;
  let curlyDepth = 0;
  let bracketDepth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    const previous = value[index - 1];
    if (quote) {
      if (char === quote && previous !== "\\") quote = "";
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }
    if (char === "{") curlyDepth += 1;
    if (char === "}") curlyDepth -= 1;
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth -= 1;
    if (char !== "," || curlyDepth !== 0 || bracketDepth !== 0) continue;
    const entry = value.slice(start, index).trim();
    if (entry) entries.push(entry);
    start = index + 1;
  }
  const tail = value.slice(start).trim();
  if (tail) entries.push(tail);
  return entries;
}

function parseInlineMapEntry(entry) {
  const match = /^['"]?([A-Za-z_-][\w-]*)['"]?\s*:\s*(.*)$/u.exec(entry.trim());
  return match ? { key: match[1], value: match[2].trim() } : null;
}

function parseInlineOptions(value) {
  const trimmed = value.trim();
  if (!trimmed) return true;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return true;
  const options = {};
  for (const entry of splitTopLevelInlineEntries(trimmed.slice(1, -1))) {
    const parsed = parseInlineMapEntry(entry);
    if (!parsed) continue;
    options[parsed.key] = parsed.value ? parseList(parsed.value) : true;
  }
  return options;
}

function parseInlineOn(value) {
  const triggers = new Map();
  const trimmed = value.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    for (const entry of splitTopLevelInlineEntries(trimmed.slice(1, -1))) {
      const parsed = parseInlineMapEntry(entry);
      if (!parsed) continue;
      triggers.set(parsed.key, parseInlineOptions(parsed.value));
    }
    return triggers;
  }
  for (const eventName of parseList(value)) triggers.set(eventName, true);
  return triggers;
}

function childLines(lines, startIndex, parentIndent) {
  const output = [];
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    if (indentOf(line) <= parentIndent) break;
    output.push(line);
  }
  return output;
}

function firstChildIndent(lines) {
  const indents = lines.map(indentOf).filter((indent) => indent > 0);
  return indents.length === 0 ? null : Math.min(...indents);
}

function parseOptions(lines) {
  const options = {};
  const childIndent = firstChildIndent(lines);
  if (childIndent === null) return options;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (indentOf(line) !== childIndent) continue;
    const match = /^([A-Za-z_-][\w-]*)\s*:\s*(.*)$/u.exec(line.trim());
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (value) {
      options[key] = parseList(value);
      continue;
    }
    const nestedList = parseBlockList(childLines(lines, index, childIndent));
    options[key] = nestedList ?? true;
  }
  return options;
}

function parseOnBlock(lines) {
  const triggers = new Map();
  const childIndent = firstChildIndent(lines);
  if (childIndent === null) return triggers;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (indentOf(line) !== childIndent) continue;
    const trimmed = line.trim();
    const item = /^-\s*([A-Za-z_-][\w-]*)\s*$/u.exec(trimmed);
    if (item) {
      triggers.set(item[1], true);
      continue;
    }
    const match = /^([A-Za-z_-][\w-]*)\s*:\s*(.*)$/u.exec(trimmed);
    if (!match) continue;
    const eventName = match[1];
    const value = match[2].trim();
    triggers.set(eventName, value ? true : parseOptions(childLines(lines, index, childIndent)));
  }
  return triggers;
}

function parseTriggers(content) {
  const lines = content.split("\n").map(cleanLine).filter((line) => line.trim());
  const onKeyPattern = /^['"]?on['"]?\s*:/u;
  const onIndex = lines.findIndex((line) => onKeyPattern.test(line));
  if (onIndex === -1) return new Map();
  const onLine = lines[onIndex];
  const inline = onLine.replace(onKeyPattern, "").trim();
  if (inline) return parseInlineOn(inline);
  return parseOnBlock(childLines(lines, onIndex, 0));
}

export function workflowRequiresRunCiLabel(content) {
  const uncommented = content.split("\n").map(cleanLine).join("\n");
  return (
    /github\.event\.label\.name\s*==\s*['"]run-ci['"]/u.test(uncommented) &&
    /github\.event\.label\.name\s*==\s*['"]full-ci['"]/u.test(uncommented)
  );
}

function isBranchPushTrigger(trigger) {
  if (trigger === undefined) return false;
  if (trigger === true) return true;
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) return true;
  return !(
    Array.isArray(trigger.tags) &&
    trigger.tags.length > 0 &&
    trigger.branches === undefined &&
    trigger["branches-ignore"] === undefined &&
    trigger["tags-ignore"] === undefined
  );
}

function isPullRequestLabeledOnly(trigger) {
  return (
    trigger &&
    typeof trigger === "object" &&
    !Array.isArray(trigger) &&
    Array.isArray(trigger.types) &&
    trigger.types.length === 1 &&
    trigger.types[0] === "labeled"
  );
}

export function inspectGithubActionsTriggerPolicy(content) {
  const triggers = parseTriggers(content);
  const pushTrigger = triggers.get("push");
  const pullRequestTrigger = triggers.get("pull_request");
  const triggerNames = [...triggers.keys()].sort();
  return {
    triggerNames,
    pushTriggerPresent: pushTrigger !== undefined,
    branchPushTriggerPresent: isBranchPushTrigger(pushTrigger),
    pullRequestTriggerPresent: pullRequestTrigger !== undefined,
    pullRequestLabeledOnly: isPullRequestLabeledOnly(pullRequestTrigger),
    workflowDispatchPresent: triggers.has("workflow_dispatch"),
    nonOptInTriggerPresent: triggerNames.some((triggerName) => !["pull_request", "workflow_dispatch"].includes(triggerName)),
  };
}

export function assertGithubActionsTriggerPolicySelfCheck() {
  const samples = [
    ["on: push", { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ['"on":\n  push:', { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ["'on':\n  push:", { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ["on: [push, workflow_dispatch]", { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ["on: { push: {}, workflow_dispatch: {} }", { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ['on: { "push": {}, workflow_dispatch: {} }', { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ['on: { "push": { tags: ["v*"] }, workflow_dispatch: {} }', { pushTriggerPresent: true, branchPushTriggerPresent: false }],
    ['on: { workflow_dispatch: { inputs: { "push": { description: test } } } }', { pushTriggerPresent: false, workflowDispatchPresent: true }],
    ["on:\n  push:\n    tags: ['v*']", { pushTriggerPresent: true, branchPushTriggerPresent: false }],
    ["on:\n  push:\n    tags:\n      - 'v*'", { pushTriggerPresent: true, branchPushTriggerPresent: false }],
    ["on:\n  push:\n    branches: [main]", { pushTriggerPresent: true, branchPushTriggerPresent: true }],
    ["on:\n  schedule:\n    - cron: '0 0 * * *'\n  workflow_dispatch:", { workflowDispatchPresent: true, nonOptInTriggerPresent: true }],
    [
      "on:\n  pull_request:\n    types: [labeled]\n  workflow_dispatch:",
      {
        pullRequestTriggerPresent: true,
        pullRequestLabeledOnly: true,
        workflowDispatchPresent: true,
      },
    ],
    ["on: [pull_request, workflow_dispatch]", { pullRequestTriggerPresent: true, pullRequestLabeledOnly: false }],
  ];
  for (const [source, expected] of samples) {
    const actual = inspectGithubActionsTriggerPolicy(source);
    for (const [key, value] of Object.entries(expected)) {
      if (actual[key] !== value) {
        throw new Error(`GitHub Actions trigger policy self-check failed for ${key}: ${source}`);
      }
    }
  }
  if (!workflowRequiresRunCiLabel("if: github.event.label.name == 'run-ci' || github.event.label.name == \"full-ci\"")) {
    throw new Error("GitHub Actions trigger policy self-check failed for label gate");
  }
  if (workflowRequiresRunCiLabel("# github.event.label.name == 'run-ci'\n# github.event.label.name == 'full-ci'")) {
    throw new Error("GitHub Actions trigger policy self-check failed for comment-only label gate");
  }
}
