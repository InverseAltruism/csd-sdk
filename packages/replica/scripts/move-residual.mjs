#!/usr/bin/env node
// The residual of the files this package took from the private CairnX resolver: each moved file against the resolver's
// copy at a commit, read from that repository's git directory (`git show`, nothing in its working tree is read). A
// file whose lines pair one to one and differ only inside the module specifier of an import or re-export is reported
// "import paths only"; a TypeScript file whose tokens, comments and whitespace aside and module specifiers blanked,
// equal the resolver's is "code identical" and prints its diff; any other file prints its diff. With --check the exit
// code is 1 when a file is none of these, or cannot be read.
// Run: node packages/replica/scripts/move-residual.mjs <resolver git dir> <commit> [--check]
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SCAN_TESTS = [
  "anchor-bracket", "anchor", "attest-dedup", "bind-fields", "cache-band", "cursor", "defer", "double-switch", "epoch",
  "f4", "feed-cost", "guards", "hardening", "incremental-fallback", "long-list", "nul-body", "refused-cache",
  "reorg-epoch", "reorg-pos", "reorg", "tip-guard", "verify-signer",
];
/** [the resolver's path, this package's path]. */
export const MOVED = [
  ["src/scan.ts", "src/scanner.ts"],
  ["src/scankept.ts", "src/kept.ts"],
  ["src/namehist.ts", "src/namehist.ts"],
  ["test/scan-chain.ts", "test/scan/scan-chain.ts"],
  ...SCAN_TESTS.map((n) => [`test/scan-${n}.test.ts`, `test/scan/scan-${n}.test.ts`]),
  ["test/fixtures/scan-flag-off-358ccdc.json", "test/scan/fixtures/scan-flag-off-358ccdc.json"],
  ["test/namehist.test.ts", "test/namehist.test.ts"],
  ["test/namehist-prune.test.ts", "test/namehist-prune.test.ts"],
  ["test/namehist-commit-bound.test.ts", "test/namehist-commit-bound.test.ts"],
  ["src/resolver/read.ts", "src/handlers.ts"],
  ["src/nameview.ts", "src/nameview.ts"],
];

/** A TypeScript text's tokens, comments and whitespace aside, with the string after each `from` blanked: two files
 *  whose lists are equal run the same code, whatever their comments and import paths. */
export function codeTokens(text) {
  const ts = createRequire(import.meta.url)("typescript");
  const sc = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text), out = [];
  for (let k = sc.scan(); k !== ts.SyntaxKind.EndOfFileToken; k = sc.scan()) {
    out.push(k === ts.SyntaxKind.StringLiteral && out.at(-1) === "from" ? "<specifier>" : sc.getTokenText());
  }
  return out;
}

const IMPORT = /^(\s*(?:(?:import|export)\b.*\s|\}\s*)from\s+)"[^"]+"(;?\s*)$/;
/** Whether two lines are one import or re-export that differs only in its module specifier. */
export const specifierOnly = (a, b) => {
  const x = IMPORT.exec(a), y = IMPORT.exec(b);
  return x !== null && y !== null && x[1] === y[1] && x[2] === y[2];
};

/** "identical", "import paths only" with the changed pairs, or "code identical" (TypeScript files, `ts` true) or
 *  "other" with a unified diff. */
export function residual(theirs, ours, ts = false) {
  if (theirs === ours) return { kind: "identical", lines: [] };
  const a = theirs.split("\n"), b = ours.split("\n");
  if (a.length === b.length) {
    const pairs = [];
    let only = true;
    for (let i = 0; i < a.length; i++) {
      if (a[i] === b[i]) continue;
      pairs.push(`${i + 1}: - ${a[i]}`, `${i + 1}: + ${b[i]}`);
      only &&= specifierOnly(a[i], b[i]);
    }
    if (only) return { kind: "import paths only", lines: pairs };
  }
  const dir = mkdtempSync(join(tmpdir(), "move-residual-"));
  try {
    writeFileSync(join(dir, "theirs"), theirs);
    writeFileSync(join(dir, "ours"), ours);
    let out = "";
    try { execFileSync("git", ["diff", "--no-index", "--no-color", "-U0", "theirs", "ours"], { cwd: dir, encoding: "utf8" }); }
    catch (e) {
      // git diff exits 1 when the files differ; any other status is a failure of the diff itself
      if (e?.status !== 1) throw e;
      out = String(e.stdout ?? "");
    }
    const lines = out.split("\n").filter((l) => /^[-+@]/.test(l) && !/^(---|\+\+\+) /.test(l));
    const same = ts && codeTokens(theirs).join("\u0000") === codeTokens(ours).join("\u0000");
    return { kind: same ? "code identical" : "other", lines };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [gitDir, commit] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const check = process.argv.includes("--check");
  if (!gitDir || !commit) {
    console.error("usage: move-residual.mjs <resolver git dir> <commit> [--check]");
    process.exit(2);
  }
  const pkg = join(dirname(fileURLToPath(import.meta.url)), "..");
  const count = { identical: 0, "import paths only": 0, "code identical": 0, other: 0, unread: 0 };
  for (const [from, to] of MOVED) {
    let theirs, ours;
    try {
      theirs = execFileSync("git", ["-C", gitDir, "show", `${commit}:${from}`], { encoding: "utf8", maxBuffer: 1 << 26 });
      ours = readFileSync(join(pkg, to), "utf8");
    } catch (e) {
      count.unread++;
      console.log(`${to}: cannot read (${e instanceof Error ? e.message.split("\n")[0] : String(e)})`);
      continue;
    }
    const r = residual(theirs, ours, to.endsWith(".ts"));
    count[r.kind]++;
    console.log(`${to} <- ${from}: ${r.kind}${r.lines.length > 0 ? `, ${r.lines.length} lines` : ""}`);
    for (const l of r.lines) console.log(`    ${l}`);
  }
  console.log(`move-residual at ${commit}: ${MOVED.length} files, ${count.identical} identical, ${count["import paths only"]} import paths only, ${count["code identical"]} code identical, ${count.other} other, ${count.unread} unread`);
  if (check && (count.other > 0 || count.unread > 0)) process.exit(1);
}
