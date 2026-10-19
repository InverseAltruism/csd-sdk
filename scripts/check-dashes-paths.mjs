#!/usr/bin/env node
// Fails when a tracked .md outside docs/archive/ contains an em dash (U+2014), or when tracked code reads a
// sibling checkout (a parent-relative cairn* or csd-* directory, or the host's absolute checkout root). Docs may
// name those paths; only code is checked for them. The check sees literal paths: a sibling path computed at run
// time (scripts/check-consumer-pins.mjs joins its own parent directory, an AGENTS.md deviation) is out of reach.
// Run: node scripts/check-dashes-paths.mjs [repo root]
// KEEP-IN-SYNC with scripts/check-dashes-paths.mjs in cairn-wallet, cairn-sdk and csd-indexer: the same checks with
// each repo's own exceptions (the wallet takes no shared npm package, so the script has no common home).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Docs allowed to keep em dashes, each with its reason.
export const DASH_EXCEPTIONS = {
  "packages/cairnx/CONVENTION.md": "the normative convention (ships in cairnx-core); its em-dash pass is Plan 85 item 13d.2",
  "packages/cairnx/test/vectors/VECTORS.md": "a B6-era pin: scripts/seal-differential.mjs requires it unchanged since the 0.1.38 baseline",
};

// Code allowed to read a sibling checkout, each with its reason.
export const PATH_EXCEPTIONS = {
  "packages/cairnx/test/primary.test.ts": "byte-parity tripwire against the canonical cairnx fixture, read only when that sibling checkout exists; the vendored copy is the one the test needs",
  "test/check-dashes-paths.test.ts": "fixtures for this check",
};

export const SIBLING = /\.\.\/(?:cairn[a-z-]*|csd-[a-z-]+)(?![\w.])|\/opt\/cairn_substrate\//;
const CODE = /\.(?:[cm]?js|[cm]?ts|tsx|sh|json|ya?ml|html)$/;

/** @param {string} root @returns {string[]} one line per offence */
export function offences(root) {
  const files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of files) {
    const isDoc = f.endsWith(".md") && !f.startsWith("docs/archive/") && !(f in DASH_EXCEPTIONS);
    const isCode = CODE.test(f) && !(f in PATH_EXCEPTIONS);
    if (!isDoc && !isCode) continue;
    const text = readFileSync(join(root, f), "utf8");
    if (isDoc && text.includes("—")) out.push(`${f}: em dash (U+2014)`);
    const sibling = isCode ? text.match(SIBLING) : null;
    if (sibling) out.push(`${f}: reads a sibling checkout (${sibling[0]})`);
  }
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const found = offences(resolve(process.argv[2] ?? "."));
  for (const line of found) console.error(line);
  console.log(found.length === 0 ? "check-dashes-paths: clean" : `check-dashes-paths: ${found.length} offence(s)`);
  process.exit(found.length === 0 ? 0 : 1);
}
