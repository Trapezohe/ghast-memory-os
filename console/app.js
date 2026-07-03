const KEY_STORAGE = "gmos.console.apiKey";
const PROFILE_STORAGE = "gmos.console.profileId";

const state = {
  apiKey: sessionStorage.getItem(KEY_STORAGE) || "",
  profileId: sessionStorage.getItem(PROFILE_STORAGE) || "",
  scope: "read",
  preview: null,
  maintainDryRun: null,
};

const auth = document.querySelector("#auth");
const shell = document.querySelector("#shell");
const authForm = document.querySelector("#authForm");
const authMessage = document.querySelector("#authMessage");
const apiKeyInput = document.querySelector("#apiKey");
const profileInput = document.querySelector("#profileId");
const notice = document.querySelector("#notice");
const view = document.querySelector("#view");
const scopeBadge = document.querySelector("#scopeBadge");
const signOutButton = document.querySelector("#signOut");
const nav = document.querySelector("#nav");

apiKeyInput.value = state.apiKey;
profileInput.value = state.profileId;

function setNotice(message, isError = false) {
  notice.textContent = message || "";
  notice.classList.toggle("error", isError);
}

function setAuthMessage(message, isError = false) {
  authMessage.textContent = message || "";
  authMessage.classList.toggle("error", isError);
}

function showAuth(message) {
  shell.hidden = true;
  auth.hidden = false;
  if (message) setAuthMessage(message, true);
}

function showShell() {
  auth.hidden = true;
  shell.hidden = false;
}

function signOut(message = "") {
  state.apiKey = "";
  sessionStorage.removeItem(KEY_STORAGE);
  apiKeyInput.value = "";
  showAuth(message);
}

function currentProfile() {
  const value = profileInput.value.trim();
  state.profileId = value;
  if (value) sessionStorage.setItem(PROFILE_STORAGE, value);
  else sessionStorage.removeItem(PROFILE_STORAGE);
  return value;
}

function profileBody(extra = {}) {
  const profileId = currentProfile();
  return profileId ? { ...extra, profileId } : extra;
}

function profileQuery(extra = {}) {
  const profileId = currentProfile();
  return profileId ? { ...extra, profileId } : extra;
}

function appendQuery(path, query = {}) {
  const url = new URL(path, window.location.origin);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = { accept: "application/json" };
  if (state.apiKey) headers.authorization = `Bearer ${state.apiKey}`;
  let body;
  if (method === "POST") {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body || {});
  }
  const response = await fetch(appendQuery(path, options.query), { method, headers, body });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};
  if (response.status === 401) {
    signOut("The key was rejected.");
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    setNotice(`Rate limited. Retry after ${retryAfter || "the server window"} seconds.`, true);
  }
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Request failed with ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    error.retryAfter = response.headers.get("retry-after");
    throw error;
  }
  return payload;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    } else node.setAttribute(key, String(value));
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function clear(node) {
  node.replaceChildren();
}

function jsonBlock(value) {
  return el("pre", { class: "json" }, JSON.stringify(value, null, 2));
}

function badge(text, tone = "") {
  return el("span", { class: `badge ${tone}`.trim(), text });
}

function valueText(value) {
  if (value === undefined || value === null || value === "") return "not returned";
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

function metric(label, value) {
  return el("div", { class: "metric" }, [
    el("span", { text: label }),
    el("strong", { text: valueText(value) }),
  ]);
}

function emptyState(text) {
  return el("div", { class: "panel muted", text });
}

function errorState(error) {
  const suffix = error.retryAfter ? ` Retry-After: ${error.retryAfter}` : "";
  return el("div", { class: "panel error", text: `${error.message}${suffix}` });
}

function section(title, children) {
  return el("section", { class: "panel" }, [el("h2", { text: title }), ...children]);
}

function setScope(scope) {
  state.scope = scope;
  const readOnly = scope === "read";
  scopeBadge.textContent = readOnly ? "read-only key" : scope;
  scopeBadge.className = readOnly ? "badge warn" : "badge ok";
  for (const link of nav.querySelectorAll("[data-route='evolution']")) {
    link.classList.toggle("hidden", scope !== "admin");
  }
}

async function detectScope() {
  await api("/runtime-info");
  let scope = "read";
  try {
    await api("/maintain", { method: "POST", body: profileBody({ dryRun: true }) });
    scope = "readwrite";
  } catch (error) {
    if (error.status !== 403) throw error;
  }
  try {
    await api("/profiles");
    scope = "admin";
  } catch (error) {
    if (error.status !== 403) throw error;
  }
  setScope(scope);
}

async function connectWithKey(key) {
  state.apiKey = key.trim();
  if (!state.apiKey) {
    setAuthMessage("Paste an API key.", true);
    return;
  }
  sessionStorage.setItem(KEY_STORAGE, state.apiKey);
  setAuthMessage("Checking key...");
  await detectScope();
  setAuthMessage("");
  showShell();
  await renderRoute();
}

function routeName() {
  return (window.location.hash || "#overview").replace(/^#\/?/u, "") || "overview";
}

function setActiveRoute(route) {
  for (const link of nav.querySelectorAll("a")) {
    link.classList.toggle("active", link.dataset.route === route);
  }
}

async function renderRoute() {
  const route = routeName();
  setActiveRoute(route);
  setNotice("");
  clear(view);
  view.append(el("div", { class: "panel muted", text: "Loading..." }));
  try {
    const renderer = routes[route] || renderOverview;
    const content = await renderer();
    clear(view);
    view.append(...content);
  } catch (error) {
    clear(view);
    view.append(errorState(error));
  }
}

function rowsFromMemories(memories, onOpen) {
  if (!memories.length) return emptyState("No memories returned.");
  return el("div", { class: "list" }, memories.map((memory) =>
    el("button", { class: "row row-button", type: "button", onClick: () => onOpen(memory) }, [
      el("div", { class: "row-head" }, [
        badge(memory.kind || "unknown"),
        badge(memory.status || "unknown", memory.status === "active" ? "ok" : "warn"),
        badge(`sensitivity: ${valueText(memory.sensitivity)}`),
        badge(`confidence: ${valueText(memory.confidence)}`),
        badge(`recall: ${valueText(memory.recallCount)}`),
        badge(`reinforcement: ${valueText(memory.reinforcement)}`),
      ]),
      el("strong", { text: memory.id }),
      el("div", { text: memory.content || "" }),
      el("small", { class: "muted", text: `${valueText(memory.createdAt)} -> ${valueText(memory.updatedAt)}` }),
    ]),
  ));
}

async function renderOverview() {
  const [health, status] = await Promise.all([
    api("/healthz"),
    api("/status", { query: profileQuery() }),
  ]);
  const report = status.report || {};
  let profiles = null;
  if (state.scope === "admin") {
    profiles = await api("/profiles");
  }
  const storage = report.storage || {};
  const lifecycle = storage.lifecycle || {};
  const rowCounts = storage.rowCounts || {};
  const searchIndex = storage.searchIndex || {};
  const vectorIndex = searchIndex.vectorIndex || {};
  return [
    section("Overview", [
      el("div", { class: "grid" }, [
        metric("Health", health.ok ? "ok" : "failed"),
        metric("Schema version", storage.schemaVersion),
        metric("Search index", searchIndex.status),
        metric("Vector index", vectorIndex.status || "not returned"),
        metric("Audit rows", rowCounts.gmos_http_audit_log),
        metric("Active memories", lifecycle.counts?.active),
        metric("Dormant memories", lifecycle.counts?.dormant),
        metric("Archived memories", lifecycle.counts?.archived),
      ]),
    ]),
    profiles
      ? section("Profiles", [
          profiles.profiles?.length
            ? el("div", { class: "list" }, profiles.profiles.map((profile) =>
                el("div", { class: "row" }, [
                  el("strong", { text: profile.profileId }),
                  el("small", { class: "muted", text: JSON.stringify(profile) }),
                ]),
              ))
            : emptyState("No profiles returned."),
        ])
      : section("Served Profile", [jsonBlock({ profileId: report.profileId || "served default" })]),
    section("Status API response", [jsonBlock(status)]),
  ];
}

function searchForm(onSubmit) {
  const form = el("form", { class: "toolbar" }, [
    el("label", {}, ["Query", el("input", { name: "query", type: "search", autocomplete: "off" })]),
    el("label", {}, [
      "Status",
      el("select", { name: "status" }, [
        el("option", { value: "", text: "any returned" }),
        el("option", { value: "active", text: "active" }),
        el("option", { value: "dormant", text: "dormant" }),
        el("option", { value: "archived", text: "archived" }),
      ]),
    ]),
    el("label", {}, [
      "Kind",
      el("select", { name: "kind" }, [
        el("option", { value: "", text: "any kind" }),
        ...["fact", "preference", "boundary", "procedure", "project", "task_trajectory"].map((kind) =>
          el("option", { value: kind, text: kind }),
        ),
      ]),
    ]),
    el("label", {}, ["Limit", el("input", { name: "limit", type: "number", min: "1", value: "25" })]),
    el("button", { type: "submit", text: "Search" }),
  ]);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    onSubmit(new FormData(form));
  });
  return form;
}

async function renderMemories() {
  const results = el("section", { class: "panel" }, [el("h2", { text: "Results" }), emptyState("Run a search.")]);
  async function runSearch(data) {
    const status = data.get("status");
    const kind = data.get("kind");
    const query = String(data.get("query") || "");
    const limit = Number(data.get("limit") || 25);
    const purpose = status === "dormant" || status === "archived" ? "history" : "context";
    const response = await api("/search", {
      method: "POST",
      body: profileBody({ query, limit, purpose }),
    });
    let memories = response.memories || [];
    if (status) memories = memories.filter((memory) => memory.status === status);
    if (kind) memories = memories.filter((memory) => memory.kind === kind);
    clear(results);
    results.append(el("h2", { text: `Results (${memories.length})` }));
    results.append(rowsFromMemories(memories, openMemoryDetail));
  }
  async function openMemoryDetail(memory) {
    const response = await api("/explain", {
      method: "POST",
      body: profileBody({ id: memory.id }),
    });
    clear(results);
    results.append(el("h2", { text: memory.id }));
    results.append(memoryDetail(response.explanation));
  }
  return [section("Memories", [searchForm(runSearch)]), results];
}

function memoryDetail(explanation) {
  if (!explanation) return emptyState("No explanation returned.");
  const body = el("div");
  const tabs = el("div", { class: "tabs" }, [
    el("button", { type: "button", class: "active", text: "Evidence" }),
    el("button", { type: "button", text: "Timeline" }),
    el("button", { type: "button", text: "JSON" }),
  ]);
  const panes = [
    el("div", {}, [
      el("p", { text: explanation.text || "" }),
      explanation.evidence?.length
        ? el("div", { class: "list" }, explanation.evidence.map((event) =>
            el("div", { class: "row" }, [
              el("strong", { text: event.id }),
              el("small", { class: "muted", text: `${event.sourceType || ""} ${event.createdAt || ""}` }),
            ]),
          ))
        : emptyState("No evidence returned."),
    ]),
    timeline(explanation.lifecycle?.entries || []),
    jsonBlock(explanation),
  ];
  function select(index) {
    for (const [buttonIndex, button] of [...tabs.querySelectorAll("button")].entries()) {
      button.classList.toggle("active", buttonIndex === index);
    }
    body.replaceChildren(panes[index]);
  }
  [...tabs.querySelectorAll("button")].forEach((button, index) => {
    button.addEventListener("click", () => select(index));
  });
  select(0);
  return el("div", {}, [tabs, body]);
}

function timeline(entries) {
  if (!entries.length) return emptyState("No lifecycle events returned.");
  return el("div", { class: "timeline" }, entries.map((entry) =>
    el("div", { class: "event" }, [
      el("strong", { text: entry.kind || entry.eventKind || "event" }),
      el("div", { class: "muted", text: entry.createdAt || entry.timestamp || "" }),
      el("div", { text: entry.reasonSummary || entry.reason || entry.summary || entry.sourceType || "" }),
    ]),
  ));
}

async function renderExplainTurn() {
  const output = el("section", { class: "panel" }, [el("h2", { text: "Explanation" }), emptyState("Submit a query.")]);
  const form = el("form", { class: "form-grid" }, [
    el("label", {}, ["Turn query", el("textarea", { name: "text", rows: "3", required: "required" })]),
    el("label", {}, ["Max excluded", el("input", { name: "maxExcluded", type: "number", min: "0", value: "10" })]),
    el("label", {}, ["Budget tokens", el("input", { name: "contextBudgetTokens", type: "number", min: "1" })]),
    el("button", { type: "submit", text: "Explain" }),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const body = profileBody({
      text: String(data.get("text") || ""),
      maxExcluded: Number(data.get("maxExcluded") || 10),
    });
    const budget = Number(data.get("contextBudgetTokens") || 0);
    if (budget > 0) body.contextBudgetTokens = budget;
    const response = await api("/explain-turn", { method: "POST", body });
    const explanation = response.explanation || {};
    clear(output);
    output.append(el("h2", { text: "Explanation" }));
    output.append(section("Included", [
      explanation.included?.length
        ? el("div", { class: "list" }, explanation.included.map((memory) =>
            el("div", { class: "row" }, [
              el("div", { class: "row-head" }, [badge(memory.kind), badge(memory.status), badge(memory.id)]),
              el("p", { text: memory.content || "" }),
              jsonBlock({ cues: memory.cues, scoreComponents: memory.scoreComponents, retention: memory.retention }),
            ]),
          ))
        : emptyState("No included memories returned."),
    ]));
    output.append(section("Excluded", [
      explanation.excluded?.length
        ? el("div", { class: "list" }, explanation.excluded.map((memory) =>
            el("div", { class: "row" }, [
              el("div", { class: "row-head" }, [
                badge(memory.kind),
                badge(memory.status),
                badge(memory.reason, "warn"),
                badge(memory.id),
              ]),
              jsonBlock({ cues: memory.cues, scoreComponents: memory.scoreComponents, retention: memory.retention }),
            ]),
          ))
        : emptyState("No excluded memories returned."),
    ]));
    output.append(section("Budget", [jsonBlock(explanation.budgets || {})]));
    output.append(section("Raw response", [jsonBlock(response)]));
  });
  return [section("Explain Turn", [form]), output];
}

async function renderForget() {
  const output = el("section", { class: "panel" }, [el("h2", { text: "Preview" }), emptyState("Preview is required.")]);
  const form = el("form", { class: "form-grid" }, [
    el("label", {}, ["Query", el("input", { name: "query", required: "required", autocomplete: "off" })]),
    el("label", {}, ["Target terms, comma separated", el("input", { name: "targetTerms", autocomplete: "off" })]),
    el("label", {}, ["Reason", el("input", { name: "reason", autocomplete: "off" })]),
    el("button", { type: "submit", text: "Preview" }),
  ]);
  const confirm = el("form", { class: "form-grid" }, [
    el("label", {}, ["Type forget", el("input", { name: "confirm", autocomplete: "off" })]),
    el("button", { type: "submit", class: "danger", text: "Forget previewed matches", disabled: "disabled" }),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const query = String(data.get("query") || "");
    const targetTerms = String(data.get("targetTerms") || "")
      .split(",")
      .map((term) => term.trim())
      .filter(Boolean);
    const reason = String(data.get("reason") || "");
    const response = await api("/search", {
      method: "POST",
      body: profileBody({ query, purpose: "history", limit: 50 }),
    });
    state.preview = { query, targetTerms, reason, response };
    confirm.querySelector("button").disabled = false;
    clear(output);
    output.append(el("h2", { text: `Preview (${(response.memories || []).length})` }));
    output.append(rowsFromMemories(response.memories || [], () => undefined));
  });
  confirm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = new FormData(confirm);
    if (String(data.get("confirm") || "") !== "forget") {
      setNotice("Confirmation must be exactly: forget", true);
      return;
    }
    if (!state.preview) return;
    const body = profileBody({
      query: state.preview.query,
      targetTerms: state.preview.targetTerms,
      reason: state.preview.reason || "console forget",
    });
    const response = await api("/forget", { method: "POST", body });
    clear(output);
    output.append(el("h2", { text: "Archived ids" }));
    output.append(jsonBlock(response.result?.archivedMemoryIds || []));
  });
  return [section("Forget", [form, confirm]), output];
}

async function renderMaintain() {
  const output = el("section", { class: "panel" }, [el("h2", { text: "Dry run" }), emptyState("Dry-run is required.")]);
  const phases = ["decay", "consolidate", "distill", "dossier"];
  const form = el("form", { class: "form-grid" }, [
    ...phases.map((phase) =>
      el("label", {}, [phase, el("input", { name: "phase", type: "checkbox", value: phase, checked: "checked" })]),
    ),
    el("button", { type: "submit", text: "Dry run" }),
  ]);
  const confirm = el("form", { class: "form-grid" }, [
    el("label", {}, ["Type maintain", el("input", { name: "confirm", autocomplete: "off" })]),
    el("button", { type: "submit", text: "Run maintenance", disabled: "disabled" }),
  ]);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = [...form.querySelectorAll("input[name='phase']:checked")].map((input) => input.value);
    const response = await api("/maintain", {
      method: "POST",
      body: profileBody({ dryRun: true, phases: selected }),
    });
    state.maintainDryRun = { phases: selected, response };
    confirm.querySelector("button").disabled = false;
    clear(output);
    output.append(el("h2", { text: "Dry run report" }));
    output.append(maintenanceReport(response.report));
  });
  confirm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (String(new FormData(confirm).get("confirm") || "") !== "maintain") {
      setNotice("Confirmation must be exactly: maintain", true);
      return;
    }
    if (!state.maintainDryRun) return;
    const response = await api("/maintain", {
      method: "POST",
      body: profileBody({ dryRun: false, phases: state.maintainDryRun.phases }),
    });
    clear(output);
    output.append(el("h2", { text: "Maintenance report" }));
    output.append(maintenanceReport(response.report));
  });
  return [section("Maintain", [form, confirm]), output];
}

function maintenanceReport(report) {
  if (!report) return emptyState("No report returned.");
  const transitionRows = report.transitions?.length
    ? report.transitions.map((transition) =>
        el("div", { class: "row diff" }, [
          el("strong", { text: transition.memoryId || "memory" }),
          el("div", { text: `${transition.from || "?"} -> ${transition.to || "?"}` }),
          el("small", { class: "muted", text: (transition.reasons || []).join("; ") }),
        ]),
      )
    : [emptyState("No transitions returned.")];
  return el("div", { class: "list" }, [
    el("div", { class: "grid" }, [
      metric("Dry run", report.dryRun),
      metric("Evaluated", report.evaluated),
      metric("Transitions", report.transitions?.length || 0),
      metric("Skipped", report.skipped?.length || 0),
    ]),
    ...transitionRows,
    section("Consolidation", [jsonBlock(report.consolidation || {})]),
    section("Distillation", [jsonBlock(report.distillation || {})]),
    section("Dossier", [jsonBlock(report.dossier || {})]),
    section("Raw report", [jsonBlock(report)]),
  ]);
}

async function renderEvolution() {
  if (state.scope !== "admin") {
    return [emptyState("Evolution review requires an admin key.")];
  }
  const response = await api("/evolution/review", { query: profileQuery() });
  const report = response.report || {};
  const proposals = report.patchProposals || [];
  return [
    section("Evolution", [
      el("div", { class: "grid" }, [
        metric("Decision", report.decision),
        metric("Failures inspected", report.inspectedFailureCount),
        metric("Clusters", report.clusters?.length || 0),
        metric("Proposals", proposals.length),
      ]),
    ]),
    section("Clusters", [
      report.clusters?.length
        ? el("div", { class: "list" }, report.clusters.map((cluster) =>
            el("div", { class: "row" }, [
              el("div", { class: "row-head" }, [badge(cluster.failureKind), badge(`${cluster.eventCount} events`)]),
              el("strong", { text: cluster.id }),
              el("div", { text: cluster.suggestedFocus || "" }),
            ]),
          ))
        : emptyState("No clusters returned."),
    ]),
    section("Patch proposals", [
      proposals.length
        ? el("div", { class: "list" }, proposals.map((proposal) => proposalCard(proposal, report.profileId)))
        : emptyState("No proposals returned."),
    ]),
    section("Raw response", [jsonBlock(response)]),
  ];
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function proposalCard(proposal, profileId) {
  const command = [
    "gmos evolution apply",
    "--db ./gmos.db",
    `--profile ${shellQuote(profileId || "default")}`,
    `--proposal ${shellQuote(proposal.id)}`,
    "--approved-by '<approver>'",
    "--yes",
  ].join(" ");
  return el("div", { class: "row" }, [
    el("div", { class: "row-head" }, [badge(proposal.id), badge(`actions: ${(proposal.suggestedActions || []).length}`)]),
    el("strong", { text: proposal.title || "" }),
    el("div", { text: proposal.summary || "" }),
    jsonBlock(proposal.suggestedActions || []),
    el("button", {
      type: "button",
      class: "secondary",
      text: "Copy CLI command",
      onClick: async () => {
        await navigator.clipboard.writeText(command);
        setNotice("CLI command copied.");
      },
    }),
    el("code", { text: command }),
  ]);
}

const routes = {
  overview: renderOverview,
  memories: renderMemories,
  explain: renderExplainTurn,
  forget: renderForget,
  maintain: renderMaintain,
  evolution: renderEvolution,
};

authForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await connectWithKey(apiKeyInput.value);
  } catch (error) {
    setAuthMessage(error.message, true);
  }
});

profileInput.addEventListener("change", () => {
  currentProfile();
  void renderRoute();
});

signOutButton.addEventListener("click", () => signOut());
window.addEventListener("hashchange", () => {
  void renderRoute();
});

if (state.apiKey) {
  connectWithKey(state.apiKey).catch((error) => setAuthMessage(error.message, true));
} else {
  showAuth();
}
