// scripts/check-dashes-paths.mjs on a throwaway git sandbox (one file per case) and on this repo.
// Run: pnpm exec tsx test/check-dashes-paths.test.ts   (offline)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DASH_EXCEPTIONS, offences, PATH_EXCEPTIONS, SIBLING } from "../scripts/check-dashes-paths.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EM = "\u2014";

console.log("check-dashes-paths:");
const here = offences(root);
ok("this repo is clean", here.length === 0, here.join("\n      "));
const exceptions = { ...DASH_EXCEPTIONS, ...PATH_EXCEPTIONS };
ok("every exception names its reason", Object.values(exceptions).every((r) => typeof r === "string" && r.length > 10));
const read = (f: string) => readFileSync(join(root, f), "utf8");
const stale = [
  ...Object.keys(DASH_EXCEPTIONS).filter((f) => !read(f).includes(EM)),
  ...Object.keys(PATH_EXCEPTIONS).filter((f) => !SIBLING.test(read(f))),
];
ok("every exception is a file the check would otherwise report", stale.length === 0, `stale: ${stale.join(", ")}`);

const dir = mkdtempSync(join(tmpdir(), "csdsdk-dashes-"));
try {
  const put = (f: string, text: string, track = true) => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
    if (track) execFileSync("git", ["add", f], { cwd: dir });
  };
  execFileSync("git", ["init", "-q"], { cwd: dir });
  put("README.md", `a ${EM} b\n`);
  put("docs/archive/old.md", `a ${EM} b\n`);
  put("packages/cairnx/CONVENTION.md", `a ${EM} b\n`);
  put("notes.txt", `a ${EM} b\n`);
  put("untracked.md", `a ${EM} b\n`, false);
  put("docs/guide.md", "load ../cairn-wallet/dist and /opt/cairn_substrate/csd-sdk\n");
  put("src/reads-sdk.mjs", 'const d = process.env.X ?? "../csd-sdk/packages";\n');
  put("src/reads-host.ts", 'import x from "/opt/cairn_substrate/cairn/public/a.js";\n');
  put("tools/run.sh", 'cd "${DIR:-../cairnx}"\n');
  put("src/local.ts", 'import { a } from "../cairnx.js";\nimport { b } from "../csd-local.ts";\n');
  put("packages/cairnx/test/primary.test.ts", 'const p = "../../../../cairnx/test/fixtures/primary-vectors.json";\n');
  const found = offences(dir);
  const files = found.map((l) => l.split(":")[0]).sort();
  ok("only the tracked offences outside the exceptions are reported",
    JSON.stringify(files) === JSON.stringify(["README.md", "src/reads-host.ts", "src/reads-sdk.mjs", "tools/run.sh"]), files.join(", "));
  ok("an em dash is reported as one", found.includes("README.md: em dash (U+2014)"));
  ok("a sibling read names the path it matched", found.includes("src/reads-sdk.mjs: reads a sibling checkout (../csd-sdk)"));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
