#!/usr/bin/env node
// Record assertion for CONSENSUS_CHANGES.md, the normative consensus ledger.
//
// Every `file :NNN` citation in the ledger must point at the line it claims IN THE
// CURRENT TREE, and every code quotation must be a literal copy of the line at the
// cited site. LINE NUMBERS are checked as well as content: the recurring defect is a
// shipped line MOVING (a remediation commit inserting a comment above it) while the
// citation silently keeps the old number, which reads as current and is not.
//
// Exit 0 = every citation re-derives. Exit 1 = at least one is stale.

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER = "CONSENSUS_CHANGES.md";

// A bare basename is ambiguous on disk (packages/registry/src/resolve.ts exists too),
// so every bare name the ledger cites must be spelled out here. An unlisted bare name
// is a hard failure, never a guess.
const ALIASES = {
  "resolve.ts": "packages/cairnx/src/resolve.ts",
  "cairnx_ref.py": "conformance/cairnx_ref.py",
};

// Inline spans shorter than this (`deny()`, `resolve.ts`) match too many lines to
// anchor anything, so they are not accepted as content anchors.
const MIN_ANCHOR = 12;

const CITE = /([A-Za-z0-9_./-]+\.(?:ts|py|mjs|js))`?\s*~?:(\d+)/g;
const BARE = /(?:^|[^\w.`/~-])~?:(\d+)/g;
const SPAN = /`([^`]+)`/g;

const md = readFileSync(join(ROOT, LEDGER), "utf8").split("\n");

// Fenced blocks hold illustrative JSON and shell, never citations.
const fenced = new Set();
let inFence = false;
for (let i = 0; i < md.length; i++) {
  if (/^```/.test(md[i])) { inFence = !inFence; fenced.add(i); continue; }
  if (inFence) fenced.add(i);
}

function srcPath(name) {
  const rel = name.includes("/") ? name : ALIASES[name];
  if (!rel) return null;
  return existsSync(join(ROOT, rel)) ? rel : null;
}

const failures = [];
const checked = [];

// A paragraph is a maximal run of non-blank, non-fenced lines. A quotation is a
// blank-line-separated 4-space-indented block immediately after it, and it anchors
// the LAST citation of that paragraph ("As shipped at X :N:" then the line).
let i = 0;
while (i < md.length) {
  if (md[i].trim() === "" || fenced.has(i)) { i++; continue; }
  const start = i;
  while (i < md.length && md[i].trim() !== "" && !fenced.has(i)) i++;
  const para = md.slice(start, i);

  const cites = [];
  for (let k = 0; k < para.length; k++) {
    const text = para[k];
    let rest = text;
    let m;
    CITE.lastIndex = 0;
    while ((m = CITE.exec(text)) !== null) {
      cites.push({ name: m[1], line: Number(m[2]), mdLine: start + k + 1 });
      rest = rest.replace(m[0], " ".repeat(m[0].length));
    }
    // `:546 bid` inherits the file named earlier on the SAME markdown line; a bare
    // number on a line that names no file is prose, not a citation.
    if (cites.length && cites[cites.length - 1].mdLine === start + k + 1) {
      const owner = cites[cites.length - 1].name;
      let b;
      BARE.lastIndex = 0;
      while ((b = BARE.exec(rest)) !== null) {
        cites.push({ name: owner, line: Number(b[1]), mdLine: start + k + 1 });
      }
    }
  }
  if (cites.length === 0) continue;

  const quote = [];
  if (i + 1 < md.length && md[i].trim() === "" && /^ {4}\S/.test(md[i + 1] || "")) {
    let q = i + 1;
    while (q < md.length && /^ {4}/.test(md[q]) && md[q].trim() !== "") { quote.push(md[q]); q++; }
  }

  const anchors = [];
  for (const text of para) {
    let s;
    SPAN.lastIndex = 0;
    while ((s = SPAN.exec(text)) !== null) if (s[1].length >= MIN_ANCHOR) anchors.push(s[1]);
  }

  const quoted = quote.length ? cites[cites.length - 1] : null;

  for (const c of cites) {
    const rel = srcPath(c.name);
    if (!rel) {
      failures.push(`${LEDGER}:${c.mdLine} cites "${c.name}" which resolves to no file (add it to ALIASES)`);
      continue;
    }
    const src = readFileSync(join(ROOT, rel), "utf8").split("\n");
    if (c.line < 1 || c.line > src.length) {
      failures.push(`${LEDGER}:${c.mdLine} cites ${rel}:${c.line}, which is past end of file (${src.length} lines)`);
      continue;
    }
    if (c === quoted) {
      let ok = true;
      for (let k = 0; k < quote.length; k++) {
        const want = quote[k].trim();
        const got = (src[c.line - 1 + k] ?? "").trim();
        if (want !== got) {
          ok = false;
          failures.push(
            `${LEDGER}:${c.mdLine} quotes ${rel}:${c.line + k} verbatim, but that line is not the quotation\n` +
            `    quoted: ${want}\n` +
            `    shipped: ${got}`
          );
        }
      }
      if (ok) checked.push(`${rel}:${c.line} quoted verbatim`);
      continue;
    }
    const hit = anchors.find((a) => src[c.line - 1].includes(a));
    if (!hit) {
      failures.push(
        `${LEDGER}:${c.mdLine} cites ${rel}:${c.line} with no content anchor: no code span >= ${MIN_ANCHOR} chars ` +
        `in that paragraph appears on the cited line\n    shipped: ${src[c.line - 1].trim()}`
      );
      continue;
    }
    checked.push(`${rel}:${c.line} anchored by \`${hit}\``);
  }
}

if (checked.length + failures.length === 0) {
  console.error("FAIL: the citation parser matched NOTHING in " + LEDGER + " (dead-green parser)");
  process.exit(1);
}

for (const c of checked) console.log("  ok   " + c);
for (const f of failures) console.error("  FAIL " + f);
console.log(`citations re-derived against the current tree: ${checked.length} ok, ${failures.length} stale`);
if (failures.length) process.exit(1);
