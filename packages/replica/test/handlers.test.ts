// The resolver's five state reads (src/handlers.ts with src/nameview.ts, taken from cairnx 0c95ad2's
// src/resolver/read.ts and src/nameview.ts):
// (1) the read path loads nothing impure: the modules it loads (value imports and re-exports, followed through this
// package's files) read no file, process, network, clock or setting, import nothing at run time, and the only package
// among them is cairnx-core; paired, the same check finds the file read of the disk store.
// (2) their code is the resolver's: the tokens of each file, comments and whitespace aside and module specifiers
// blanked (scripts/move-residual.mjs codeTokens), hash to what the resolver's files at 0c95ad2 give.
// (3) the answers on states resolve() gives: every body and status, the 404s included.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { canonicalState, resolve, type CairnXState } from "@inversealtruism/cairnx-core";
import { appliedIds, nameHistory, readName, readNameHistory, readProfile, readResolve, readState, type ReadSnapshot } from "../src/index.js";
import { done, ok } from "./check.js";
import { corpus } from "./core-files.js";

const ROOT = new URL("..", import.meta.url).pathname;
// value imports and re-exports; `import type` and `export type` load nothing
const FROM = /^\s*(?:import|export)\s+(?!type\b)(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/gm;
const FORBIDDEN = [/\bimport\s*\(/, /["']node:(?:fs|child_process|http|https|net|os|worker_threads)["']/, /config\.js["']/, /\/home\//, /process\.env/, /Date\.now\(/, /\bfetch\(/, /\breadFileSync\(/];

/** The package files `entry` loads, and the packages they import. */
function closure(entry: string) {
  const files = new Set<string>(), packages = new Set<string>();
  const visit = (abs: string) => {
    if (files.has(abs)) return;
    files.add(abs);
    for (const m of readFileSync(abs, "utf8").matchAll(FROM)) {
      const spec = m[1]!;
      if (!spec.startsWith(".")) { packages.add(spec); continue; }
      const ts = join(dirname(abs), spec).replace(/\.js$/, ".ts");
      if (!existsSync(ts)) throw new Error(`${relative(ROOT, abs)} imports ${spec}, which is no file`);
      visit(ts);
    }
  };
  visit(join(ROOT, entry));
  return { files: [...files].map((f) => relative(ROOT, f)).sort(), packages: [...packages].sort() };
}
const offences = (files: string[]) => files.flatMap((f) => FORBIDDEN.filter((re) => re.test(readFileSync(join(ROOT, f), "utf8"))).map((re) => `${f}: ${re}`));

console.log("the read path loads only pure modules and cairnx-core:");
{
  const c = closure("src/handlers.ts");
  ok("src/handlers.ts loads src/nameview.ts and cairnx-core alone", JSON.stringify(c.files) === JSON.stringify(["src/handlers.ts", "src/nameview.ts"]) &&
    JSON.stringify(c.packages) === JSON.stringify(["@inversealtruism/cairnx-core"]), JSON.stringify(c));
  ok("none of them reads a file, the process, the network or the clock, or imports at run time", offences(c.files).length === 0, offences(c.files).join("; "));
  const d = closure("src/disk-store.ts");
  ok("paired: the same check finds the disk store's file reads", offences(d.files).some((o) => o.includes("node:")), offences(d.files).join("; "));
  const dyn = FORBIDDEN[0]!.test('const m = await import("./x.js");') && !FORBIDDEN[0]!.test('import { a } from "./x.js";');
  ok("paired: a dynamic import() is an offence, a static one is followed", dyn);
}

console.log("their code is the resolver's at cairnx 0c95ad2:");
{
  const script = new URL("../scripts/move-residual.mjs", import.meta.url).href;
  const { codeTokens } = (await import(script)) as { codeTokens: (text: string) => string[] };
  const hash = (f: string) => createHash("sha256").update(codeTokens(readFileSync(join(ROOT, f), "utf8")).join("\u0000")).digest("hex");
  // Taken with codeTokens over `git show 0c95ad2:src/resolver/read.ts` and `git show 0c95ad2:src/nameview.ts`.
  const THEIRS = { "src/handlers.ts": "0218f7995834a88115d9625e46c03f793cec99f247ead81fe052282b23103bca", "src/nameview.ts": "f12153a89e4e11166608a6e728897459de29375f6311db2a248e1d4e7de505d1" };
  for (const [f, want] of Object.entries(THEIRS)) ok(`${f}: its code hashes to the resolver's`, hash(f) === want, hash(f));
  const a = codeTokens("// one\nimport { x } from \"./a.js\";\nexport const y = x + 1;\n"), b = codeTokens("import { x } from \"@scope/b\"; /* two */ export const y = x + 1;");
  ok("paired: comments, whitespace and specifiers aside the tokens agree, and a changed operand does not", a.join() === b.join() &&
    codeTokens("export const y = x + 2;").join() !== codeTokens("export const y = x + 1;").join());
}

console.log("the answers on resolve()'s states:");
{
  const tip = corpus.tipHeight, events = [...corpus.events], state: CairnXState = resolve(events, tip), applied = appliedIds(state.events);
  const snap: ReadSnapshot = { state, canonical: canonicalState, history: (s, name) => nameHistory(events, name, { tipHeight: s.tipHeight, fullRecord: s.names[name], fullApplied: applied }) };
  const st = readState(snap);
  ok("/cairnx/state: 200, canonicalState's bytes", st.status === 200 && st.body === canonicalState(state));
  const names = Object.keys(state.names), held = names.find((n) => state.names[n]!.pending !== true)!;
  const nm = JSON.parse(readName(snap, held).body), rs = JSON.parse(readResolve(snap, held).body), nh = JSON.parse(readNameHistory(snap, held).body);
  ok(`a held name (${held}): name carries the record, the tip and its lease; resolve its address; name-history its events`,
    nm.owner === state.names[held]!.owner && nm.tipHeight === tip && typeof nm.lease === "object" && rs.ok === true && typeof rs.addr === "string" &&
    nh.ok === true && Array.isArray(nh.events) && nh.events.length > 0 && typeof nh.scopedReplaySufficient === "boolean");
  for (const [route, f] of [["name", readName], ["resolve", readResolve], ["name-history", readNameHistory], ["profile", readProfile]] as const) {
    const r = f(snap, "zzcontracttest"), c = f(snap, "constructor");
    ok(`${route}: an unregistered name, and "constructor", answer 404 with ok false`, r.status === 404 && JSON.parse(r.body).ok === false && c.status === 404 && JSON.parse(c.body).ok === false);
  }
  ok(`${names.length} names in the corpus's state at ${tip}`, names.length > 0);
}

done("cairnx-replica handlers");
