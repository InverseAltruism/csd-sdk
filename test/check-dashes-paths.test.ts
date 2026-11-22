// scripts/check-dashes-paths.mjs on a throwaway git sandbox (one file per case) and on this repo.
// Run: pnpm exec tsx test/check-dashes-paths.test.ts   (offline)
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExceptions, offences, packedOffences, SIBLING } from "../scripts/check-dashes-paths.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : `\n      ${detail}`}`); };

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const EM = "\u2014";

console.log("check-dashes-paths:");
const here = offences(root);
ok("this repo is clean", here.length === 0, here.join("\n      "));
const { dashes, paths } = loadExceptions(root);
ok("every exception names its reason", Object.values({ ...dashes, ...paths }).every((r) => r.length > 10));
const read = (f: string) => readFileSync(join(root, f), "utf8");
const stale = [
  ...Object.keys(dashes).filter((f) => !read(f).includes(EM)),
  ...Object.keys(paths).filter((f) => !SIBLING.test(read(f))),
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
  put("scripts/dashes-exceptions.json", read("scripts/dashes-exceptions.json"));
  put("README.md", `a ${EM} b\n`);
  put("docs/archive/old.md", `a ${EM} b\n`);
  put("packages/cairnx/test/vectors/VECTORS.md", `a ${EM} b\n`);
  put("notes.txt", `a ${EM} b\n`);
  put("untracked.md", `a ${EM} b\n`, false);
  put("docs/guide.md", "load ../cairn-wallet/dist, /opt/cairn_substrate/csd-sdk and /home/someone/notes\n");
  put("src/reads-sdk.mjs", 'const d = process.env.X ?? "../csd-sdk/packages";\n');
  put("src/reads-host.ts", 'import x from "/opt/cairn_substrate/cairn/public/a.js";\n');
  put("tools/run.sh", 'cd "${DIR:-../cairnx}"\n');
  put("src/reads-home.ts", 'const plan = "/home/someone/plans/next.md";\n');
  put("src/local.ts", 'import { a } from "../cairnx.js";\nimport { b } from "../csd-local.ts";\n');
  put("packages/cairnx/test/primary.test.ts", 'const p = "../../../../cairnx/test/fixtures/primary-vectors.json";\n');
  const found = offences(dir);
  const files = found.map((l) => l.split(":")[0]).sort();
  ok("only the tracked offences outside the exceptions are reported",
    JSON.stringify(files) === JSON.stringify(["README.md", "src/reads-home.ts", "src/reads-host.ts", "src/reads-sdk.mjs", "tools/run.sh"]), files.join(", "));
  ok("an em dash is reported as one", found.includes("README.md: em dash (U+2014)"));
  ok("a sibling read names the path it matched", found.includes("src/reads-sdk.mjs: reads a sibling checkout (../csd-sdk)"));
  ok("a path under /home/ in code is reported; in a doc it is not", found.includes("src/reads-home.ts: reads a sibling checkout (/home/)") && !files.includes("docs/guide.md"));

  const refuses = (text: string) => {
    put("scripts/dashes-exceptions.json", text);
    try { offences(dir); return false; } catch { return true; }
  };
  ok("an exceptions file without the paths map is refused", refuses('{"dashes": {}}'));
  ok("an exceptions file with an unknown key is refused", refuses('{"dashes": {}, "paths": {}, "docs": {}}'));
  ok("an exception without a string reason is refused", refuses('{"dashes": {"README.md": true}, "paths": {}}'));
  ok("an exceptions file that lists one map as an array is refused", refuses('{"dashes": ["README.md"], "paths": {}}'));
  put("scripts/dashes-exceptions.json", '{"dashes": {"README.md": "a sandbox exception"}, "paths": {}}');
  ok("a well-formed exceptions file is read from the checked root", !offences(dir).some((l) => l.startsWith("README.md")));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("run through a symlinked path:");
// Node gives a script's import.meta.url its real path, so a guard that compares it with argv[1] unresolved is false when the
// tree is reached through a symlink and the script then does nothing and exits 0: a gate that passes without checking.
const linkRoot = mkdtempSync(join(tmpdir(), "csdsdk-dashes-link-"));
try {
  symlinkSync(join(root, "scripts"), join(linkRoot, "scripts-link"));
  const tree = (name: string, readme: string) => {
    const t = join(linkRoot, name);
    mkdirSync(join(t, "scripts"), { recursive: true });
    copyFileSync(join(root, "scripts/dashes-exceptions.json"), join(t, "scripts/dashes-exceptions.json"));
    writeFileSync(join(t, "README.md"), readme);
    execFileSync("git", ["init", "-q"], { cwd: t });
    execFileSync("git", ["add", "."], { cwd: t });
    return t;
  };
  const viaLink = (t: string) => spawnSync(process.execPath, [join(linkRoot, "scripts-link/check-dashes-paths.mjs"), t], { encoding: "utf8" });
  const bad = viaLink(tree("dirty", `a ${EM} b\n`));
  ok("through a symlinked scripts directory a tree with a tracked em dash is refused: exit 1 naming the file",
    bad.status === 1 && /README\.md: em dash \(U\+2014\)/.test(bad.stderr) && /1 offence/.test(bad.stdout), `exit ${bad.status}: ${bad.stdout}${bad.stderr}`);
  const good = viaLink(tree("clean", "a - b\n"));
  ok("through the symlink a clean tree passes: exit 0 and its line printed", good.status === 0 && /check-dashes-paths: clean/.test(good.stdout), `exit ${good.status}: ${good.stdout}${good.stderr}`);
} finally {
  rmSync(linkRoot, { recursive: true, force: true });
}

// A packed tarball's files: every file is read, the built ones (dist/, a .d.ts that carries a doc comment) included.
{
  const enc = (s: string) => new TextEncoder().encode(s);
  const clean = packedOffences(new Map([["package/README.md", enc("a - b\n")], ["package/dist/index.d.ts", enc("/** a, b */\n")]]));
  ok("packed: a clean tarball has no offence", clean.length === 0, clean.join("; "));
  const bad = packedOffences(new Map([["package/dist/index.d.ts", enc(`/** a ${EM} b */\n`)], ["package/dist/chunk.js", enc('const p = "/home/someone/x";\n')],
    ["package/README.md", enc("see ../cairn-wallet/src\n")]]));
  ok("packed: an em dash in a .d.ts, a home path in a chunk and a sibling path in the README are each refused",
    bad.length === 3 && bad.some((l) => /index\.d\.ts: em dash/.test(l)) && bad.some((l) => /chunk\.js: a sibling or host path \(\/home\/\)/.test(l))
      && bad.some((l) => /README\.md: a sibling or host path \(\.\.\/cairn-wallet\)/.test(l)), bad.join("; "));
}

// Every script that decides whether to run by comparing argv[1] with import.meta.url resolves argv[1]'s symlinks first.
const tracked = execFileSync("git", ["ls-files", "-z", "--", "*.mjs"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
const guards = tracked.flatMap((f) => read(f).split("\n").filter((l) => l.includes("process.argv[1]") && l.includes("import.meta.url")).map((l) => ({ f, l })));
const unresolved = guards.filter((g) => !g.l.includes("realpathSync(process.argv[1])")).map((g) => g.f);
ok(`each of the ${guards.length} main guards in the tracked .mjs files resolves argv[1] with realpathSync`, guards.length >= 12 && unresolved.length === 0, unresolved.join(", "));

console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
