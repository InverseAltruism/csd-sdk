// The parts of scripts/seal-differential.mjs that run offline. Step 0: a copy of the script on a throwaway tree with a
// stand-in dist stops with the reason when the dist's CAIRNX_CORE_VERSION is not the manifest's version, and goes on
// to step 1 when it is (where it stops for want of check-lockstep.mjs, before any network read). The whole-result
// compares: they go through the typed text of conformance/sweep-streams.mjs, which keeps NaN, both infinities and null
// apart where JSON.stringify writes all four as null.
// Run: pnpm exec tsx test/seal-differential.test.ts   (offline)
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { parseNumbers, stringifyNumbers } from "../conformance/sweep-streams.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c ? "" : `: ${detail}`}`); };
const REPO = fileURLToPath(new URL("..", import.meta.url));

// The seal and the scripts it imports at load, on a tree whose cairnx dist says `distVersion` and manifest `manifest`.
const runSeal = (distVersion: string, manifest: string) => {
  const t = mkdtempSync(join(tmpdir(), "seal-version-"));
  try {
    mkdirSync(join(t, "scripts"));
    mkdirSync(join(t, "packages", "cairnx", "dist"), { recursive: true });
    for (const f of ["seal-differential.mjs", "published-dist.mjs", "workspace.mjs", "git-head.mjs"]) cpSync(join(REPO, "scripts", f), join(t, "scripts", f));
    writeFileSync(join(t, "packages", "cairnx", "package.json"), JSON.stringify({ name: "@inversealtruism/cairnx-core", version: manifest, type: "module" }));
    writeFileSync(join(t, "packages", "cairnx", "dist", "index.js"), `export const CAIRNX_CORE_VERSION = ${JSON.stringify(distVersion)};\n`);
    return spawnSync(process.execPath, [join(t, "scripts", "seal-differential.mjs")], { cwd: t, encoding: "utf8", timeout: 60_000 });
  } finally {
    rmSync(t, { recursive: true, force: true });
  }
};

// ── step 0: the build under test carries the manifest's version ──
{
  const r = runSeal("0.2.8", "0.2.9");
  ok("a dist of another version stops the seal with a non-zero exit", r.status === 1, `status ${r.status}`);
  ok("the reason names both versions", /SEAL FAIL: the build in packages\/cairnx\/dist is cairnx-core 0\.2\.8, the manifest says 0\.2\.9/.test(r.stderr), r.stderr);
  ok("it stops before step 1", !r.stdout.includes("settled-tree check"), r.stdout);
}
{
  const r = runSeal("0.2.9", "0.2.9");
  ok("a dist of the manifest's version passes step 0", r.stdout.includes("cairnx-core 0.2.9") && !r.stderr.includes("the manifest says"), r.stderr);
  ok("and the seal goes on to step 1", r.stdout.includes("== SEAL: settled-tree check"), r.stdout);
}

// ── the whole-result compares: the typed text ──
{
  const values = [Number.NaN, Infinity, -Infinity, null];
  const typed = values.map((v) => stringifyNumbers({ height: v }));
  ok("JSON.stringify writes NaN, Infinity, -Infinity and null alike (what the compares no longer use)", new Set(values.map((v) => JSON.stringify({ height: v }))).size === 1);
  ok("the typed text keeps all four apart", new Set(typed).size === 4, typed.join(" "));
  const back = typed.map((x) => (parseNumbers(x) as { height: unknown }).height);
  ok("and reads each back", back.every((v, i) => Object.is(v, values[i])), String(back));
  const seal = readFileSync(join(REPO, "scripts", "seal-differential.mjs"), "utf8");
  ok("the seal's whole-result compares (case, code baseline, dense walk) go through it",
    !/JSON\.stringify\((os|bs|stripCodes|CODE\.resolve|CODE_MOVES)\b/.test(seal) && (seal.match(/SW\.stringifyNumbers\(/g) ?? []).length >= 6);
}

console.log(`\nseal-differential (offline): ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
