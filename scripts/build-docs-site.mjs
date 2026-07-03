#!/usr/bin/env node
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const next = process.argv[index + 1];
  if (!next || next.startsWith("--")) throw new Error(`${name} requires a value`);
  return next;
}

function hasOption(name) {
  return process.argv.includes(name);
}

function toPosix(filePath) {
  return filePath.split(path.sep).join(path.posix.sep);
}

function sourceDocs() {
  const rootDocs = [
    "README.md",
    "SECURITY.md",
    "CONTRIBUTING.md",
    "RELEASE_CHECKLIST.md",
    "CODE_OF_CONDUCT.md",
  ].filter((file) => existsSync(path.join(root, file)));
  const docDir = path.join(root, "docs");
  const nestedDocs = readdirSync(docDir)
    .filter((file) => file.endsWith(".md"))
    .sort()
    .map((file) => path.posix.join("docs", file));
  return [...rootDocs, ...nestedDocs];
}

function outputPathForSource(source) {
  if (source === "README.md") return "index.html";
  return source.replace(/\.md$/u, ".html");
}

function escapeHtml(value) {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/gu, "&#39;");
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .replace(/`([^`]+)`/gu, "$1")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return slug || "section";
}

function rewriteMarkdownHref(href, source) {
  if (/^(https?:|mailto:|#)/iu.test(href)) return href;
  const [target, hash = ""] = href.split("#");
  if (!target.endsWith(".md")) return href;
  const sourceDir = path.posix.dirname(source);
  const resolved = path.posix.normalize(path.posix.join(sourceDir === "." ? "" : sourceDir, target));
  const rewritten = outputPathForSource(resolved);
  const currentOutputDir = path.posix.dirname(outputPathForSource(source));
  const relative = path.posix.relative(currentOutputDir === "." ? "" : currentOutputDir, rewritten) || path.posix.basename(rewritten);
  return `${relative}${hash ? `#${hash}` : ""}`;
}

function renderInline(text, source) {
  const tokens = [];
  const stash = (html) => {
    const token = `\u0000GMOS_HTML_${tokens.length}\u0000`;
    tokens.push([token, html]);
    return token;
  };
  let working = text.replace(/`([^`]+)`/gu, (_match, code) =>
    stash(`<code>${escapeHtml(code)}</code>`),
  );
  working = working.replace(/\[([^\]]+)\]\(([^)]+)\)/gu, (_match, label, href) =>
    stash(
      `<a href="${escapeAttribute(rewriteMarkdownHref(href.trim(), source))}">${renderInline(label, source)}</a>`,
    ),
  );
  working = working.replace(/\*\*([^*]+)\*\*/gu, (_match, bold) =>
    stash(`<strong>${escapeHtml(bold)}</strong>`),
  );
  let html = escapeHtml(working);
  for (const [token, replacement] of tokens) {
    html = html.replaceAll(escapeHtml(token), replacement);
  }
  return html;
}

function isTableSeparator(line) {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line);
}

function tableCells(line) {
  return line.trim().replace(/^\|/u, "").replace(/\|$/u, "").split("|").map((cell) => cell.trim());
}

function renderTable(lines, source) {
  const [header, _separator, ...body] = lines;
  const head = tableCells(header)
    .map((cell) => `<th>${renderInline(cell, source)}</th>`)
    .join("");
  const rows = body
    .map((line) => `<tr>${tableCells(line).map((cell) => `<td>${renderInline(cell, source)}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

function isBlockStart(lines, index) {
  const line = lines[index] ?? "";
  const next = lines[index + 1] ?? "";
  return (
    /^```/u.test(line) ||
    /^#{1,6}\s+/u.test(line) ||
    /^---\s*$/u.test(line) ||
    /^>\s?/u.test(line) ||
    /^\s*[-*]\s+/u.test(line) ||
    /^\s*\d+\.\s+/u.test(line) ||
    (line.includes("|") && isTableSeparator(next))
  );
}

function renderList(lines, start, ordered, source) {
  const marker = ordered ? /^\s*\d+\.\s+/u : /^\s*[-*]\s+/u;
  const items = [];
  let index = start;
  while (index < lines.length && marker.test(lines[index])) {
    let item = lines[index].replace(marker, "").trim();
    index += 1;
    while (
      index < lines.length &&
      /^\s{2,}\S/u.test(lines[index]) &&
      !/^\s*[-*]\s+/u.test(lines[index]) &&
      !/^\s*\d+\.\s+/u.test(lines[index])
    ) {
      item += ` ${lines[index].trim()}`;
      index += 1;
    }
    items.push(`<li>${renderInline(item, source)}</li>`);
  }
  const tag = ordered ? "ol" : "ul";
  return { html: `<${tag}>\n${items.join("\n")}\n</${tag}>`, next: index };
}

function renderMarkdown(markdown, source) {
  const lines = markdown.replace(/\r\n/gu, "\n").split("\n");
  const blocks = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    if (line.startsWith("```")) {
      const language = line.slice(3).trim();
      index += 1;
      const code = [];
      while (index < lines.length && !lines[index].startsWith("```")) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const className = language ? ` class="language-${escapeAttribute(language)}"` : "";
      blocks.push(`<pre><code${className}>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      blocks.push(`<h${level} id="${escapeAttribute(slugify(title))}">${renderInline(title, source)}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^---\s*$/u.test(line)) {
      blocks.push("<hr>");
      index += 1;
      continue;
    }
    if (line.includes("|") && isTableSeparator(lines[index + 1] ?? "")) {
      const table = [line, lines[index + 1]];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        table.push(lines[index]);
        index += 1;
      }
      blocks.push(renderTable(table, source));
      continue;
    }
    if (/^>\s?/u.test(line)) {
      const quote = [];
      while (index < lines.length && /^>\s?/u.test(lines[index])) {
        quote.push(lines[index].replace(/^>\s?/u, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderMarkdown(quote.join("\n"), source)}</blockquote>`);
      continue;
    }
    if (/^\s*[-*]\s+/u.test(line)) {
      const list = renderList(lines, index, false, source);
      blocks.push(list.html);
      index = list.next;
      continue;
    }
    if (/^\s*\d+\.\s+/u.test(line)) {
      const list = renderList(lines, index, true, source);
      blocks.push(list.html);
      index = list.next;
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push(`<p>${renderInline(paragraph.join(" "), source)}</p>`);
  }
  return blocks.join("\n");
}

function titleFor(markdown, fallback) {
  const heading = /^#\s+(.+)$/mu.exec(markdown);
  return heading ? heading[1].replace(/`/gu, "") : fallback;
}

function stylesheetPath(source) {
  const from = path.posix.dirname(outputPathForSource(source));
  return path.posix.relative(from === "." ? "" : from, "assets/style.css") || "assets/style.css";
}

function renderPage(input) {
  const nav = input.docs
    .map((doc) => {
      const href = path.posix.relative(
        path.posix.dirname(outputPathForSource(input.source)) === "." ? "" : path.posix.dirname(outputPathForSource(input.source)),
        outputPathForSource(doc.source),
      ) || "index.html";
      const current = doc.source === input.source ? " aria-current=\"page\"" : "";
      return `<a${current} href="${escapeAttribute(href)}">${escapeHtml(doc.title)}</a>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)}</title>
  <link rel="stylesheet" href="${escapeAttribute(stylesheetPath(input.source))}">
</head>
<body>
  <aside class="sidebar">
    <a class="brand" href="${input.source === "README.md" ? "index.html" : escapeAttribute(path.posix.relative(path.posix.dirname(outputPathForSource(input.source)), "index.html") || "index.html")}">gmOS docs</a>
    <nav>${nav}</nav>
  </aside>
  <main>
    ${input.body}
    <footer>@ghast/memory ${escapeHtml(input.version)}</footer>
  </main>
</body>
</html>
`;
}

function css() {
  return `:root{color-scheme:light;--text:#172026;--muted:#5d6b76;--line:#d9e0e6;--bg:#f7f9fb;--panel:#ffffff;--accent:#1f766f}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;display:grid;grid-template-columns:280px minmax(0,1fr);min-height:100vh}
.sidebar{background:var(--panel);border-right:1px solid var(--line);padding:24px;position:sticky;top:0;height:100vh;overflow:auto}
.brand{display:block;font-weight:700;color:var(--text);text-decoration:none;margin-bottom:18px}
nav{display:grid;gap:4px}
nav a{color:var(--muted);text-decoration:none;border-radius:6px;padding:6px 8px}
nav a[aria-current="page"],nav a:hover{background:#edf5f3;color:var(--accent)}
main{max-width:980px;width:100%;padding:44px 48px 64px}
h1,h2,h3,h4,h5,h6{line-height:1.25;margin:1.8em 0 .55em}
h1{font-size:2.2rem;margin-top:0}
h2{border-top:1px solid var(--line);padding-top:1.1em}
a{color:#0b6fba}
code{background:#eef2f5;border-radius:4px;padding:.12em .28em;font-size:.92em}
pre{background:#101820;color:#eff6f7;border-radius:8px;padding:16px;overflow:auto}
pre code{background:transparent;color:inherit;padding:0}
table{width:100%;border-collapse:collapse;margin:1.2em 0;display:block;overflow:auto}
th,td{border:1px solid var(--line);padding:8px 10px;text-align:left;vertical-align:top}
th{background:#eef2f5}
blockquote{border-left:4px solid var(--line);margin:1.2em 0;padding:.1em 1em;color:var(--muted);background:#fff}
hr{border:0;border-top:1px solid var(--line);margin:32px 0}
footer{border-top:1px solid var(--line);margin-top:48px;padding-top:16px;color:var(--muted);font-size:.9rem}
@media (max-width: 820px){body{display:block}.sidebar{position:static;height:auto;border-right:0;border-bottom:1px solid var(--line)}main{padding:28px 20px}}`;
}

function extractExternalUrls(text) {
  return new Set((text.match(/https?:\/\/[^\s&"'<>`)]+/gu) ?? []).map((url) => url.replace(/[.,;]+$/u, "")));
}

function assertCleanOutput(outputDir, docs, sourceExternalUrls) {
  const generated = new Set(docs.map((doc) => outputPathForSource(doc.source)));
  for (const doc of docs) {
    const outputRelative = outputPathForSource(doc.source);
    const html = readFileSync(path.join(outputDir, outputRelative), "utf8");
    if (html.includes("```")) throw new Error(`${outputRelative} leaked a fenced-code marker`);
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/mu.test(html)) {
      throw new Error(`${outputRelative} leaked a markdown table separator`);
    }
    for (const url of extractExternalUrls(html)) {
      if (!sourceExternalUrls.has(url)) throw new Error(`${outputRelative} introduced external URL ${url}`);
    }
    const sourceText = readFileSync(path.join(root, doc.source), "utf8");
    for (const match of sourceText.matchAll(/\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/gu)) {
      const href = rewriteMarkdownHref(match[1], doc.source).split("#")[0];
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(outputRelative), href));
      if (!generated.has(target)) {
        throw new Error(`${doc.source} links to ${match[1]}, but ${target} was not generated`);
      }
    }
  }
}

export function buildDocsSite(options = {}) {
  const outputDir = path.resolve(root, options.outputDir ?? "site");
  if (outputDir === root || outputDir === path.dirname(root)) {
    throw new Error("Refusing to write docs site over the repository root");
  }
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const docs = sourceDocs().map((source) => {
    const markdown = readFileSync(path.join(root, source), "utf8");
    return {
      source,
      markdown,
      title: titleFor(markdown, source),
    };
  });
  const sourceExternalUrls = new Set(docs.flatMap((doc) => [...extractExternalUrls(doc.markdown)]));
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(path.join(outputDir, "assets"), { recursive: true });
  writeFileSync(path.join(outputDir, "assets", "style.css"), css());
  for (const doc of docs) {
    const outputRelative = outputPathForSource(doc.source);
    const outputFile = path.join(outputDir, outputRelative);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(
      outputFile,
      renderPage({
        source: doc.source,
        title: doc.title,
        body: renderMarkdown(doc.markdown, doc.source),
        docs,
        version: packageJson.version ?? "unknown",
      }),
    );
  }
  if (options.check) assertCleanOutput(outputDir, docs, sourceExternalUrls);
  return { outputDir, pageCount: docs.length };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = buildDocsSite({
    outputDir: optionValue("--output-dir", "site"),
    check: hasOption("--check"),
  });
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
}
