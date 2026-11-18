#!/usr/bin/env node
// Record assertion for CONSENSUS_CHANGES.md, the normative consensus ledger, and for the per-gate files under
// docs/gates/ that its entries link.
//
// Every `file :NNN` citation in those documents must point at the line it claims IN THE
// CURRENT TREE, and every code quotation must be a literal copy of the line at the
// cited site. LINE NUMBERS are checked as well as content: the recurring defect is a
// shipped line MOVING (a remediation commit inserting a comment above it) while the
// citation silently keeps the old number, which reads as current and is not.
// A gate file the ledger does not link, and a gate file the ledger links that does not exist, are failures too.
//
// Exit 0 = every citation re-derives. Exit 1 = at least one is stale.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

export const LEDGER = "CONSENSUS_CHANGES.md";
export const GATES_DIR = "docs/gates";
// The template carries no citation outside its fenced examples and is linked from the ledger's checklist.
export const GATE_TEMPLATE = `${GATES_DIR}/TEMPLATE.md`;

// A bare basename can name more than one file in the tree, so every bare name the ledger
// cites must be spelled out here. An unlisted bare name
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
const GATE_LINK = /docs\/gates\/[A-Za-z0-9_.-]+\.md/g;

/**
 * The gate files present under docs/gates/, as repo-relative paths.
 * @param {string} root
 * @returns {string[]}
 */
export function gateFiles(root) {
  const dir = join(root, GATES_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => `${GATES_DIR}/${f}`);
}

/**
 * Check the citations of one document (repo-relative `doc`) against the tree at `root`.
 * @param {string} root
 * @param {string} doc
 * @param {string[]} checked
 * @param {string[]} failures
 */
function checkDoc(root, doc, checked, failures) {
  const md = readFileSync(join(root, doc), "utf8").split("\n");
  /** @param {number} n */
  const line = (n) => md[n] ?? "";

  // Fenced blocks hold illustrative JSON and shell, never citations.
  const fenced = new Set();
  let inFence = false;
  for (let i = 0; i < md.length; i++) {
    if (/^```/.test(line(i))) { inFence = !inFence; fenced.add(i); continue; }
    if (inFence) fenced.add(i);
  }

  /** @param {string} name */
  const srcPath = (name) => {
    const rel = name.includes("/") ? name : ALIASES[/** @type {keyof typeof ALIASES} */ (name)];
    if (!rel) return null;
    return existsSync(join(root, rel)) ? rel : null;
  };

  // A paragraph is a maximal run of non-blank, non-fenced lines. A quotation is a
  // blank-line-separated 4-space-indented block immediately after it, and it anchors
  // the LAST citation of that paragraph ("As shipped at X :N:" then the line).
  let i = 0;
  while (i < md.length) {
    if (line(i).trim() === "" || fenced.has(i)) { i++; continue; }
    const start = i;
    while (i < md.length && line(i).trim() !== "" && !fenced.has(i)) i++;
    const para = md.slice(start, i);

    /** @type {Array<{ name: string, line: number, mdLine: number }>} */
    const cites = [];
    for (let k = 0; k < para.length; k++) {
      const text = para[k] ?? "";
      let rest = text;
      let m;
      CITE.lastIndex = 0;
      while ((m = CITE.exec(text)) !== null) {
        cites.push({ name: m[1] ?? "", line: Number(m[2]), mdLine: start + k + 1 });
        rest = rest.replace(m[0], " ".repeat(m[0].length));
      }
      // `:546 bid` inherits the file named earlier on the SAME markdown line; a bare
      // number on a line that names no file is prose, not a citation.
      const last = cites[cites.length - 1];
      if (last && last.mdLine === start + k + 1) {
        let b;
        BARE.lastIndex = 0;
        while ((b = BARE.exec(rest)) !== null) {
          cites.push({ name: last.name, line: Number(b[1]), mdLine: start + k + 1 });
        }
      }
    }
    if (cites.length === 0) continue;

    /** @type {string[]} */
    const quote = [];
    if (i + 1 < md.length && line(i).trim() === "" && /^ {4}\S/.test(line(i + 1))) {
      let q = i + 1;
      while (q < md.length && /^ {4}/.test(line(q)) && line(q).trim() !== "") { quote.push(line(q)); q++; }
    }

    /** @type {string[]} */
    const anchors = [];
    for (const text of para) {
      let s;
      SPAN.lastIndex = 0;
      while ((s = SPAN.exec(text)) !== null) if ((s[1] ?? "").length >= MIN_ANCHOR) anchors.push(s[1] ?? "");
    }

    const quoted = quote.length ? cites[cites.length - 1] : null;

    for (const c of cites) {
      const rel = srcPath(c.name);
      if (!rel) {
        failures.push(`${doc}:${c.mdLine} cites "${c.name}" which resolves to no file (add it to ALIASES)`);
        continue;
      }
      const src = readFileSync(join(root, rel), "utf8").split("\n");
      if (c.line < 1 || c.line > src.length) {
        failures.push(`${doc}:${c.mdLine} cites ${rel}:${c.line}, which is past end of file (${src.length} lines)`);
        continue;
      }
      const cited = src[c.line - 1] ?? "";
      if (c === quoted) {
        let ok = true;
        for (let k = 0; k < quote.length; k++) {
          const want = (quote[k] ?? "").trim();
          const got = (src[c.line - 1 + k] ?? "").trim();
          if (want !== got) {
            ok = false;
            failures.push(
              `${doc}:${c.mdLine} quotes ${rel}:${c.line + k} verbatim, but that line is not the quotation\n` +
              `    quoted: ${want}\n` +
              `    shipped: ${got}`
            );
          }
        }
        if (ok) checked.push(`${rel}:${c.line} quoted verbatim (${doc})`);
        continue;
      }
      const hit = anchors.find((a) => cited.includes(a));
      if (!hit) {
        failures.push(
          `${doc}:${c.mdLine} cites ${rel}:${c.line} with no content anchor: no code span >= ${MIN_ANCHOR} chars ` +
          `in that paragraph appears on the cited line\n    shipped: ${cited.trim()}`
        );
        continue;
      }
      checked.push(`${rel}:${c.line} anchored by \`${hit}\` (${doc})`);
    }
  }
}

/**
 * Check the ledger and every gate file at `root`: their citations, and that the ledger links each gate file and
 * links none that is missing.
 * @param {string} root
 * @returns {{ docs: string[], checked: string[], failures: string[] }}
 */
export function checkCitations(root) {
  /** @type {string[]} */
  const checked = [];
  /** @type {string[]} */
  const failures = [];
  const gates = gateFiles(root);
  const docs = [LEDGER, ...gates];
  for (const doc of docs) checkDoc(root, doc, checked, failures);

  const ledger = readFileSync(join(root, LEDGER), "utf8");
  const linked = new Set(ledger.match(GATE_LINK) ?? []);
  for (const g of gates) if (g !== GATE_TEMPLATE && !linked.has(g)) failures.push(`${g} is not linked from ${LEDGER}`);
  for (const l of [...linked].sort()) if (!existsSync(join(root, l))) failures.push(`${LEDGER} links ${l}, which does not exist`);
  return { docs, checked, failures };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
  const { docs, checked, failures } = checkCitations(ROOT);
  if (checked.length + failures.length === 0) {
    console.error("FAIL: the citation parser matched NOTHING in " + docs.join(", ") + " (dead-green parser)");
    process.exit(1);
  }
  for (const c of checked) console.log("  ok   " + c);
  for (const f of failures) console.error("  FAIL " + f);
  console.log(`citations re-derived against the current tree in ${docs.length} documents: ${checked.length} ok, ${failures.length} stale`);
  if (failures.length) process.exit(1);
}
