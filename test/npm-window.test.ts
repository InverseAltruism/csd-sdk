// Offline checks of the npm window (scripts/npm-window.mjs, scripts/verify-tarball.mjs). The window publishes with
// `npm publish <tgz>`, which runs no package hook, so these are the checks on that path: the tarball gate on a real
// `pnpm pack` of csd-crypto (needs a built dist, as CI has) and the publish step against a stand-in npm and registry.
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyTarball, workspaceVersions } from "../scripts/verify-tarball.mjs";
import { checkWindow, finishWindow, headOnOriginMaster, publishOrder, publishWindow } from "../scripts/npm-window.mjs";
import { workspacePackagesAtHead } from "../scripts/workspace.mjs";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, detail = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✅" : "❌"} ${n}${c || !detail ? "" : ` (${detail})`}`); };

const root = fileURLToPath(new URL("..", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "npm-window-test-"));
const versions = workspaceVersions(root);
const crypto = join(root, "packages", "crypto");

console.log("verify-tarball on the bytes the window publishes:");
{
  execFileSync("pnpm", ["pack", "--pack-destination", work], { cwd: crypto, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" });
  const tgzPath = join(work, readdirSync(work).find((f) => f.endsWith(".tgz"))!);
  const honest = verifyTarball(new Uint8Array(readFileSync(tgzPath)), crypto, versions);
  ok("a fresh pnpm pack of csd-crypto passes", honest.length === 0, honest.join("; "));
  // repack an edited copy with system tar in the plain-file ustar shape the reader accepts
  const edited = (edit: (dir: string) => void) => {
    const x = mkdtempSync(join(work, "x-"));
    execFileSync("tar", ["xzf", tgzPath, "-C", x]);
    edit(join(x, "package"));
    const files: string[] = [];
    const walk = (d: string, rel: string) => { for (const e of readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(join(d, e.name), `${rel}/${e.name}`) : files.push(`${rel}/${e.name}`); };
    walk(join(x, "package"), "package");
    const out = join(x, "re.tgz");
    execFileSync("tar", ["--format=ustar", "--no-recursion", "-czf", out, "-C", x, ...files]);
    return verifyTarball(new Uint8Array(readFileSync(out)), crypto, versions);
  };
  const same = edited(() => undefined);
  ok("the same files repacked pass (the repack is not what fails below)", same.length === 0, same.join("; "));
  const ws = edited((d) => {
    const m = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    m.dependencies["@inversealtruism/csd-codec"] = "workspace:*";
    writeFileSync(join(d, "package.json"), JSON.stringify(m, null, 2));
  });
  ok("a manifest with an unresolved workspace:* (the raw npm publish incident) is refused", ws.some((f) => /workspace:/.test(f)), ws.join("; "));
  const stale = edited((d) => writeFileSync(join(d, "dist", "index.js"), readFileSync(join(d, "dist", "index.js"), "utf8") + "\n// stale\n"));
  ok("a dist file that is not this tree's build is refused", stale.includes("dist/index.js differs from the local build"), stale.join("; "));
  const hook = edited((d) => {
    const m = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    m.scripts = { ...m.scripts, postinstall: "node -e 1" };
    writeFileSync(join(d, "package.json"), JSON.stringify(m, null, 2));
  });
  ok("a script the tree does not declare is refused", hook.some((f) => /script "postinstall"/.test(f)), hook.join("; "));
  const noTest = edited((d) => {
    const m = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
    delete m.scripts.test;
    writeFileSync(join(d, "package.json"), JSON.stringify(m, null, 2));
  });
  ok("a packed manifest missing a script pnpm keeps (test) is refused", noTest.some((f) => /script "test" is missing/.test(f)), noTest.join("; "));
}

console.log("verify-tarball against the HEAD commit (real git and pnpm pack):");
{
  // As packages/cairnx ships test/vectors: a "files" directory under a repo-root ignore rule, which pnpm does not read
  const repo = mkdtempSync(join(work, "tracked-"));
  const pkg = join(repo, "pkg");
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  mkdirSync(join(pkg, "vectors"), { recursive: true });
  mkdirSync(join(pkg, "dist"));
  writeFileSync(join(repo, ".gitignore"), "**/*key*.json\ndist/\n");
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@x/fixture", version: "1.0.0", files: ["dist", "vectors"],
    scripts: { test: "node -e 0", prepack: "node -e 0", prepublishOnly: "node -e 0" } }, null, 2));
  writeFileSync(join(pkg, "dist", "index.js"), "export {};\n");
  writeFileSync(join(pkg, "vectors", "cases.json"), "[]\n");
  writeFileSync(join(pkg, "vectors", "more.json"), "{}\n");
  git("init", "-q", "-b", "master");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "fixture");
  const pack = () => {
    const out = mkdtempSync(join(work, "pack-"));
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: pkg, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" });
    return new Uint8Array(readFileSync(join(out, readdirSync(out).find((f) => f.endsWith(".tgz"))!)));
  };
  const packAndVerify = () => verifyTarball(pack(), pkg, new Map());
  const clean = packAndVerify();
  ok("a pack of a committed package with a tracked vector passes", clean.length === 0, clean.join("; "));
  writeFileSync(join(pkg, "vectors", "stray-key.json"), "{}\n");
  const ignored = git("status", "--porcelain") === "" ? packAndVerify() : ["fixture: the stray file is not ignored"];
  ok("an ignored file inside a packed directory (git status clean) is refused",
    ignored.some((f) => f.includes("package/vectors/stray-key.json") && /not in the commit/.test(f)), ignored.join("; "));
  rmSync(join(pkg, "vectors", "stray-key.json"));
  writeFileSync(join(pkg, "vectors", "new.json"), "{}\n");
  const untracked = packAndVerify();
  ok("an untracked file inside a packed directory is refused", untracked.some((f) => f.includes("package/vectors/new.json") && /not in the commit/.test(f)), untracked.join("; "));
  rmSync(join(pkg, "vectors", "new.json"));
  // a committed file rewritten on disk under skip-worktree: git status stays clean and pnpm packs the new bytes
  git("update-index", "--skip-worktree", "pkg/vectors/cases.json");
  writeFileSync(join(pkg, "vectors", "cases.json"), "[\"not the commit\"]\n");
  const hidden = git("status", "--porcelain") === "" ? packAndVerify() : ["fixture: the rewrite shows in git status"];
  ok("a committed file rewritten under skip-worktree (git status clean) is refused",
    hidden.some((f) => f.includes("package/vectors/cases.json") && /differs from the commit/.test(f)), hidden.join("; "));
  writeFileSync(join(pkg, "vectors", "cases.json"), "[]\n");
  git("update-index", "--no-skip-worktree", "pkg/vectors/cases.json");
  git("update-index", "--skip-worktree", "pkg/package.json");
  const manifest = readFileSync(join(pkg, "package.json"), "utf8");
  writeFileSync(join(pkg, "package.json"), manifest.replace('"1.0.0"', '"1.0.0", "description": "not the commit"'));
  const hiddenManifest = git("status", "--porcelain") === "" ? packAndVerify() : ["fixture: the rewrite shows in git status"];
  ok("a committed package.json rewritten under skip-worktree is refused", hiddenManifest.some((f) => /package\.json fields .* differ from the commit/.test(f)), hiddenManifest.join("; "));
  writeFileSync(join(pkg, "package.json"), manifest);
  // the publish guard and prepack run the scripts on disk: one removed or changed under skip-worktree is refused
  const scriptsEdit = (edit: (sc: Record<string, string>) => void) => {
    const m = JSON.parse(manifest);
    edit(m.scripts);
    writeFileSync(join(pkg, "package.json"), JSON.stringify(m, null, 2));
    const r = git("status", "--porcelain") === "" ? packAndVerify() : ["fixture: the rewrite shows in git status"];
    writeFileSync(join(pkg, "package.json"), manifest);
    return r;
  };
  const noTestOnDisk = scriptsEdit((sc) => { delete sc.test; });
  ok("scripts.test removed on disk under skip-worktree (the guard would skip the suite) is refused",
    noTestOnDisk.some((f) => /scripts on disk differ from the commit/.test(f)), noTestOnDisk.join("; "));
  const prepackOnDisk = scriptsEdit((sc) => { sc.prepack = "node -e 1"; });
  ok("a prepack changed on disk under skip-worktree (pnpm drops it from the packed manifest) is refused",
    prepackOnDisk.some((f) => /scripts on disk differ from the commit/.test(f)), prepackOnDisk.join("; "));
  git("update-index", "--no-skip-worktree", "pkg/package.json");
  // a committed file deleted on disk under skip-worktree: pnpm packs the rest of its directory without it
  git("update-index", "--skip-worktree", "pkg/vectors/cases.json");
  rmSync(join(pkg, "vectors", "cases.json"));
  const dropped = git("status", "--porcelain") === "" ? packAndVerify() : ["fixture: the deletion shows in git status"];
  ok("a committed file missing from the tarball (deleted on disk under skip-worktree) is refused",
    dropped.some((f) => f.includes("package/vectors/cases.json") && /not in the tarball/.test(f)), dropped.join("; "));
  writeFileSync(join(pkg, "vectors", "cases.json"), "[]\n");
  git("update-index", "--no-skip-worktree", "pkg/vectors/cases.json");
  // the same package outside any git checkout: HEAD cannot be read, so the tarball is refused
  const plain = join(mkdtempSync(join(work, "plain-")), "pkg");
  cpSync(pkg, plain, { recursive: true });
  const noGit = verifyTarball(pack(), plain, new Map());
  ok("a package directory outside a git checkout is refused", noGit.some((f) => /git cannot read/.test(f)), noGit.join("; "));
}

console.log("verify-tarball: the one range peer, and a package without its build:");
{
  // cairnx-pin as this tree packs it: its optional peer on cairnx-replica is workspace:^, packed as ^ the version
  const pinDir = join(root, "packages", "pin"), out = mkdtempSync(join(work, "pin-"));
  execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: pinDir, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" });
  const pinTgz = new Uint8Array(readFileSync(join(out, readdirSync(out).find((f) => f.endsWith(".tgz"))!)));
  const pinPeer = JSON.parse(execFileSync("tar", ["xzfO", join(out, readdirSync(out).find((f) => f.endsWith(".tgz"))!), "package/package.json"], { encoding: "utf8" })).peerDependencies;
  const pinOk = verifyTarball(pinTgz, pinDir, versions);
  ok("a pack of cairnx-pin passes, its replica peer packed as ^ the version HEAD names",
    pinOk.length === 0 && JSON.stringify(pinPeer) === JSON.stringify({ "@inversealtruism/cairnx-replica": `^${versions.get("@inversealtruism/cairnx-replica")}` }), `${pinOk.join("; ")} ${JSON.stringify(pinPeer)}`);
  // the same package committed without its build: no dist on disk and none in the tarball, which diffDist cannot see
  const repo = mkdtempSync(join(work, "nobuild-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  const m = JSON.parse(readFileSync(join(pinDir, "package.json"), "utf8"));
  delete m.peerDependencies; delete m.peerDependenciesMeta; delete m.devDependencies;
  writeFileSync(join(repo, "package.json"), JSON.stringify(m, null, 2));
  for (const f of ["pin.json", "README.md", "LICENSE", "CHANGELOG.md"]) cpSync(join(pinDir, f), join(repo, f));
  git("init", "-q", "-b", "master"); git("add", "."); git("commit", "-q", "--no-verify", "-m", "pin without its build");
  const nb = mkdtempSync(join(work, "nobuild-pack-"));
  execFileSync("pnpm", ["pack", "--pack-destination", nb], { cwd: repo, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" });
  const noBuild = verifyTarball(new Uint8Array(readFileSync(join(nb, readdirSync(nb).find((f) => f.endsWith(".tgz"))!))), repo, new Map());
  ok("cairnx-pin packed without dist/ is refused: dist/index.js and dist/index.d.ts are named by its manifest and not in the tarball",
    noBuild.some((f) => /package\/dist\/index\.js is named by the manifest/.test(f)) && noBuild.some((f) => /package\/dist\/index\.d\.ts is named by the manifest/.test(f)), noBuild.join("; "));
}

console.log("workspace versions from the HEAD commit (fixture workspace, real git and pnpm):");
{
  const ws = mkdtempSync(join(work, "ws-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: ws, encoding: "utf8" });
  const put = (rel: string, body: string) => { mkdirSync(dirname(join(ws, rel)), { recursive: true }); writeFileSync(join(ws, rel), body); };
  put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  put("package.json", JSON.stringify({ name: "fixture-ws", private: true }));
  put(".gitignore", "node_modules/\npnpm-lock.yaml\n");
  put("packages/a/package.json", JSON.stringify({ name: "@x/a", version: "1.0.1", files: ["index.js"] }, null, 2));
  put("packages/b/package.json", JSON.stringify({ name: "@x/b", version: "1.0.0", files: ["index.js"], dependencies: { "@x/a": "workspace:*" } }, null, 2));
  put("packages/c/package.json", JSON.stringify({ name: "@x/c", version: "1.0.0", private: true, files: ["index.js"] }, null, 2));
  // a peer as workspace:~, which pnpm packs as ~ the version and verify-tarball does not admit (only workspace:^ is)
  put("packages/d/package.json", JSON.stringify({ name: "@x/d", version: "1.0.0", private: true, files: ["index.js"], peerDependencies: { "@x/a": "workspace:~" } }, null, 2));
  put("packages/d/index.js", "export {};\n");
  put("packages/a/index.js", "export {};\n");
  put("packages/b/index.js", "export {};\n");
  git("init", "-q", "-b", "master");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "fixture");
  execFileSync("pnpm", ["install", "--offline"], { cwd: ws, stdio: "ignore" });   // links the workspace; no registry
  const b = join(ws, "packages", "b");
  const packB = () => {
    const out = mkdtempSync(join(work, "pack-"));
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: b, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" });
    return new Uint8Array(readFileSync(join(out, readdirSync(out).find((f) => f.endsWith(".tgz"))!)));
  };
  const honest = verifyTarball(packB(), b, workspaceVersions(ws));
  ok("b packed pinning a at the version HEAD names passes", honest.length === 0, honest.join("; "));
  const dDir = join(ws, "packages", "d"), dOut = mkdtempSync(join(work, "pack-"));
  execFileSync("pnpm", ["pack", "--pack-destination", dOut], { cwd: dDir, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" });
  const tilde = verifyTarball(new Uint8Array(readFileSync(join(dOut, readdirSync(dOut).find((f) => f.endsWith(".tgz"))!))), dDir, workspaceVersions(ws));
  ok("a peer given as workspace:~, packed as ~1.0.1, is refused", tilde.some((f) => /peerDependencies .*~1\.0\.1.*expected .*"1\.0\.1"/.test(f)), tilde.join("; "));
  // a's version rolled back on disk under skip-worktree: git status stays clean and pnpm pins the disk version
  const aManifest = join(ws, "packages", "a", "package.json");
  git("update-index", "--skip-worktree", "packages/a/package.json");
  writeFileSync(aManifest, readFileSync(aManifest, "utf8").replace('"1.0.1"', '"1.0.0"'));
  const rolled = git("status", "--porcelain") === "" ? verifyTarball(packB(), b, workspaceVersions(ws)) : ["fixture: the rollback shows in git status"];
  ok("a workspace pin resolved from a manifest rolled back on disk is refused",
    rolled.some((f) => /dependencies/.test(f) && f.includes("1.0.1")), rolled.join("; "));
  // the window's plan: a@1.0.0 is on the stand-in registry, a@1.0.1 (the version HEAD names) is not; real git, so
  // the tree and HEAD checks run on the fixture as it is (skip-worktree keeps git status clean); pnpm is not run
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  const lines: string[] = [];
  const plan = await checkWindow({ root: ws, out: mkdtempSync(join(work, "wsout-")), run: false, log: (l) => lines.push(l), env: {},
    sh: (cmd, args) => {
      if (cmd !== "git") return { ok: false, out: "stand-in: not run" };
      try { return { ok: true, out: git(...args) }; } catch (e) { return { ok: false, out: String(e) }; }
    },
    registry: async (name: string, version: string) => ({ status: name === "@x/a" && version === "1.0.0" ? 200 : 404, meta: null }) });
  const planned = plan.order.map((p) => `${p.name}@${p.version}`).join();
  ok("the window plans the versions HEAD names (a@1.0.1 and b), not a@1.0.0 from disk", planned === "@x/a@1.0.1,@x/b@1.0.0", planned);
  ok("a private package (@x/c, unpublished) is never planned, and the plan names it as private",
    !planned.includes("@x/c") && lines.includes("  not published, marked private: @x/c@1.0.0"), lines.join("\n"));
  ok("its only failed checks are the stand-in pack and guard of the two planned packages (the tree and HEAD checks pass)",
    plan.fails.length === 4 && plan.fails.every((f) => /^@x\/[ab]: (pnpm pack|publish guard)/.test(f)), plan.fails.join("; "));
}

type Checked = Awaited<ReturnType<typeof checkWindow>> & { out: string };
// two checkWindow results the publish step below takes as they are, as main() hands them on
let checked: { honest: Checked; verifyFailed: Checked } | undefined;

console.log("window checks (stand-in git and publish guard; real pack and verify-tarball of csd-crypto):");
{
  const CRYPTO = "@inversealtruism/csd-crypto";
  const HEAD = "a".repeat(40);
  const window = async (o: { guard?: boolean; onMaster?: boolean; dirty?: boolean; env?: Record<string, string>; verify?: typeof verifyTarball; unpublished?: string } = {}) => {
    const out = mkdtempSync(join(work, "win-"));
    const sh = (cmd: string, args: string[], cwd: string) => {
      if (cmd === "git" && args[0] === "status") return { ok: true, out: o.dirty ? " M packages/crypto/src/index.ts\n" : "" };
      if (cmd === "git" && args[0] === "rev-parse") return { ok: true, out: `${HEAD}\n` };
      if (cmd === "git" && args[0] === "rev-list") return { ok: true, out: `${"b".repeat(40)}\n${o.onMaster === false ? "" : `${HEAD}\n`}` };
      if (cmd === "git") throw new Error(`unexpected git command: ${args.join(" ")}`);
      if (args[0] === "run" && args[1] === "prepublishOnly") return { ok: o.guard ?? true, out: "stand-in publish guard" };
      if (args[0] === "pack") {
        try { execFileSync(cmd, args, { cwd, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" }); return { ok: true, out: "" }; }
        catch (e) { return { ok: false, out: String(e) }; }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };
    const registry = async (name: string) => ({ status: name === (o.unpublished ?? CRYPTO) ? 404 : 200, meta: null });
    const lines: string[] = [];
    const r = await checkWindow({ root, out, run: false, log: (l) => lines.push(l), sh, registry, verify: o.verify ?? verifyTarball, env: o.env ?? {} });
    return { ...r, out, lines: lines.join("\n") };
  };

  const honest = await window();
  ok("honest: csd-crypto is the one package to publish and every check passes", honest.fails.length === 0 && honest.order.map((p) => p.name).join() === CRYPTO && honest.tarballs.every((t) => existsSync(t.path)), honest.fails.join("; "));
  ok("checkWindow records the digests of the packed bytes it verified on each tarball",
    honest.tarballs.length === 1 && honest.tarballs.every((t) => { const b = readFileSync(t.path); return t.sha1 === createHash("sha1").update(b).digest("hex") && t.integrity === "sha512-" + createHash("sha512").update(b).digest("base64"); }));
  const guard = await window({ guard: false });
  ok("a failing publish guard fails the window, and nothing else does", guard.fails.length === 1 && /publish guard/.test(guard.fails[0]!), guard.fails.join("; "));
  const verify = await window({ verify: () => ["dist/index.js differs from the local build"] });
  ok("a failing verify-tarball fails the window, and nothing else does", verify.fails.length === 1 && /verify-tarball/.test(verify.fails[0]!), verify.fails.join("; "));
  ok("a tarball that failed verify-tarball has no digest recorded (publishWindow publishes only recorded digests)",
    verify.tarballs.length === 1 && verify.tarballs.every((t) => t.sha1 === undefined && t.integrity === undefined), JSON.stringify(verify.tarballs));
  const off = await window({ onMaster: false });
  ok("a HEAD off origin/master's first-parent line fails the window, and nothing else does", off.fails.length === 1 && /origin\/master/.test(off.fails[0]!), off.fails.join("; "));
  // src/ is not in the tarball and verify-tarball compares dist/ with the build on disk, so an uncommitted source
  // edit, built, passes every later check: the clean-tree check is what refuses it
  const dirty = await window({ dirty: true });
  ok("a tree with a local change fails the window, and nothing else does", dirty.fails.length === 1 && /no local change/.test(dirty.fails[0]!), dirty.fails.join("; "));
  const skip = await window({ env: { CSD_PUBLISH_SKIP_TESTS: "1" } });
  ok("CSD_PUBLISH_SKIP_TESTS=1 (the guard would skip the suites) fails the window, and nothing else does", skip.fails.length === 1 && /CSD_PUBLISH_SKIP_TESTS/.test(skip.fails[0]!), skip.fails.join("; "));
  const sums = (c: { out: string }, f: string) => readFileSync(join(c.out, f), "utf8");
  const t0 = honest.tarballs[0]!, b0 = readFileSync(t0.path), name0 = t0.path.slice(honest.out.length + 1);
  ok("SHA1SUMS and SHA256SUMS list the tarball that passed, with the digests of its bytes",
    sums(honest, "SHA1SUMS") === `${t0.sha1}  ${name0}\n` && sums(honest, "SHA256SUMS") === `${createHash("sha256").update(b0).digest("hex")}  ${name0}\n`,
    sums(honest, "SHA1SUMS") + sums(honest, "SHA256SUMS"));
  ok("SHA1SUMS and SHA256SUMS do not list a tarball that failed verify-tarball",
    sums(verify, "SHA1SUMS") === "" && sums(verify, "SHA256SUMS") === "", sums(verify, "SHA1SUMS") + sums(verify, "SHA256SUMS"));
  // cairnx-api: an exact peer on cairnx-core, which pnpm packs from workspace:* as the version HEAD names
  const peerFirst = publishOrder([{ name: "@inversealtruism/cairnx-api", peerDependencies: { "@inversealtruism/cairnx-core": "workspace:*" } }, { name: "@inversealtruism/cairnx-core" }]);
  ok("a package is ordered after the workspace package it names as a peer (cairnx-core before cairnx-api, against the name order)",
    peerFirst.map((p) => p.name).join() === "@inversealtruism/cairnx-core,@inversealtruism/cairnx-api", peerFirst.map((p) => p.name).join());
  // the window's order over this repo's own manifests: each package after every workspace package it depends on or peers on
  const real = publishOrder(workspacePackagesAtHead(root).map((p) => ({ ...p, name: String(p.name) }))).map((p) => String(p.name).replace("@inversealtruism/", ""));
  const after = (a: string, ...before: string[]) => before.every((b) => real.indexOf(b) >= 0 && real.indexOf(b) < real.indexOf(a));
  ok("the order over this repo's manifests puts cairnx-replica after cairnx-core, csd-codec, csd-crypto, csd-client and csd-light, cairnx-pin after cairnx-replica, and lists csd-anchors",
    after("cairnx-replica", "cairnx-core", "csd-codec", "csd-crypto", "csd-client", "csd-light") && after("cairnx-pin", "cairnx-replica") && real.includes("csd-anchors"), real.join());
  const API = "@inversealtruism/cairnx-api";
  const api = await window({ unpublished: API });
  const apiTgz = api.tarballs[0]?.path ?? "";
  const apiPeers = existsSync(apiTgz) ? JSON.parse(execFileSync("tar", ["xzfO", apiTgz, "package/package.json"], { encoding: "utf8" })).peerDependencies : null;
  ok("honest: cairnx-api is the one package to publish when it alone is unpublished, and every check passes",
    api.fails.length === 0 && api.order.map((p) => p.name).join() === API && api.tarballs.every((t) => t.sha1 !== undefined), `${api.order.map((p) => p.name).join()} ${api.fails.join("; ")}`);
  ok("its packed manifest pins cairnx-core as a peer at the version HEAD names",
    JSON.stringify(apiPeers) === JSON.stringify({ "@inversealtruism/cairnx-core": versions.get("@inversealtruism/cairnx-core") }), JSON.stringify(apiPeers));
  const REPLICA = "@inversealtruism/cairnx-replica";
  const replica = await window({ unpublished: REPLICA });
  const replicaTgz = replica.tarballs[0]?.path ?? "";
  const replicaManifest = existsSync(replicaTgz) ? JSON.parse(execFileSync("tar", ["xzfO", replicaTgz, "package/package.json"], { encoding: "utf8" })) : null;
  ok("honest: cairnx-replica, no longer private, is the one package to publish when it alone is unpublished, and its real pack passes every check",
    replica.fails.length === 0 && replica.order.map((p) => p.name).join() === REPLICA && replica.tarballs.every((t) => t.sha1 !== undefined), `${replica.order.map((p) => p.name).join()} ${replica.fails.join("; ")}`);
  ok("its packed manifest pins cairnx-core as a peer at the version HEAD names and carries the cairnx-replica command",
    JSON.stringify(replicaManifest?.peerDependencies) === JSON.stringify({ "@inversealtruism/cairnx-core": versions.get("@inversealtruism/cairnx-core") })
      && replicaManifest?.bin?.["cairnx-replica"] === "./dist/cli.js" && replicaManifest?.private === undefined, JSON.stringify(replicaManifest?.peerDependencies));
  checked = { honest, verifyFailed: verify };
}

console.log("the tree and HEAD (real git):");
{
  const repo = mkdtempSync(join(work, "repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  const src = join(repo, "packages", "p", "src", "index.js");
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(join(repo, "packages", "p", "package.json"), JSON.stringify({ name: "@x/p", version: "1.0.0" }));
  writeFileSync(src, "export const payee = \"reviewed\";\n");
  git("init", "-q", "-b", "master");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "merged");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  ok("a commit that is origin/master passes", headOnOriginMaster(repo));
  // the real git runner; @x/p@1.0.0 is on the stand-in registry, so the window ends after the plan with nothing to pack
  const treeChecks = async () => (await checkWindow({ root: repo, out: mkdtempSync(join(work, "tree-")), run: true, log: () => undefined, env: {},
    registry: async () => ({ status: 200, meta: null }) })).fails;
  const clean = await treeChecks();
  ok("a clean tree at origin/master passes the tree and HEAD checks", clean.length === 0, clean.join("; "));
  writeFileSync(src, "export const payee = \"not reviewed\";\n");
  const edited = await treeChecks();
  ok("an uncommitted source edit fails the window on the clean-tree check, and nothing else does",
    edited.length === 1 && edited[0] === "the tree has no local change", edited.join("; "));
  writeFileSync(src, "export const payee = \"reviewed\";\n");
  git("checkout", "-q", "-b", "topic");
  git("commit", "-q", "--allow-empty", "-m", "unmerged");
  git("update-ref", "refs/remotes/origin/topic", "HEAD");
  ok("a commit pushed on a topic branch, not merged, is refused", !headOnOriginMaster(repo) && git("branch", "-r", "--contains", "HEAD").trim() !== "");
  // master advanced by merge commits: every commit of a merged branch is an ancestor of origin/master, but only the
  // merges (and direct commits) are on its first-parent line
  const rev = (r: string) => git("rev-parse", r).trim();
  const first = rev("master");
  git("checkout", "-q", "-b", "fix", "master");
  git("commit", "-q", "--allow-empty", "-m", "release 1.0.1, before the fix");
  const inner = rev("HEAD");
  git("commit", "-q", "--allow-empty", "-m", "the fix");
  const branchTip = rev("HEAD");
  git("checkout", "-q", "master");
  git("merge", "-q", "--no-ff", "--no-edit", "fix");
  const olderMerge = rev("HEAD");
  git("checkout", "-q", "-b", "next");
  git("commit", "-q", "--allow-empty", "-m", "a later change");
  git("checkout", "-q", "master");
  git("merge", "-q", "--no-ff", "--no-edit", "next");
  const tip = rev("HEAD");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  const at = (c: string) => { git("checkout", "-q", "--detach", c); return headOnOriginMaster(repo); };
  const ancestor = (c: string) => { try { git("merge-base", "--is-ancestor", c, "origin/master"); return true; } catch { return false; } };
  ok("the tip of origin/master, a merge commit, passes", at(tip));
  ok("an older merge commit on origin/master's first-parent line passes (a release from an earlier merge)", at(olderMerge));
  ok("a direct commit on the first-parent line, before the first merge, passes", at(first));
  ok("an inner commit of a pull request merged with a merge commit (an ancestor of origin/master, before the branch's last fix) is refused",
    ancestor(inner) && !at(inner));
  ok("the merged branch's own tip (the merge's second parent) is refused: the release commit is the merge", ancestor(branchTip) && !at(branchTip));
  // the stated limit: a fast-forwarded (or rebased) branch puts every one of its commits on the first-parent line
  git("checkout", "-q", "-b", "ff", "master");
  git("commit", "-q", "--allow-empty", "-m", "release 1.0.2, before the fix");
  const ffInner = rev("HEAD");
  git("commit", "-q", "--allow-empty", "-m", "the fix, fast-forwarded");
  git("checkout", "-q", "master");
  git("merge", "-q", "--ff-only", "ff");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  ok("an inner commit of a fast-forwarded branch is on the first-parent line and is admitted (the documented limit)", ancestor(ffInner) && at(ffInner));
}

console.log("main() in check mode (the CLI on a throwaway repo; real git and pnpm, fetch stood in through NODE_OPTIONS):");
{
  const cli = mkdtempSync(join(work, "cli-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: cli, encoding: "utf8" });
  const put = (rel: string, body: string) => { mkdirSync(dirname(join(cli, rel)), { recursive: true }); writeFileSync(join(cli, rel), body); };
  // main() takes the repo root from its own path, so the scripts are copied in and committed with the fixture
  for (const f of ["npm-window.mjs", "verify-tarball.mjs", "workspace.mjs", "git-head.mjs", "published-dist.mjs"]) cpSync(join(root, "scripts", f), join(cli, "scripts", f));
  put("pnpm-workspace.yaml", 'packages:\n  - "packages/*"\n');
  put("package.json", JSON.stringify({ name: "fixture-cli", private: true }));
  put(".gitignore", "node_modules/\npnpm-lock.yaml\n");
  put("packages/p/package.json", JSON.stringify({ name: "@x/p", version: "1.0.0", files: ["index.js"], scripts: { prepublishOnly: "node -e 0" } }, null, 2));
  put("packages/p/index.js", "export {};\n");
  git("init", "-q", "-b", "master");
  git("add", ".");
  git("commit", "-q", "--no-verify", "-m", "fixture");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  // every registry read answers 404, so @x/p@1.0.0 is the one version to pack, guard and verify
  const stub = 'globalThis.fetch = async () => new Response("", { status: 404 });';
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k) && k !== "CSD_PUBLISH_SKIP_TESTS"));
  const window = (env: Record<string, string> = {}) => {
    const r = spawnSync(process.execPath, [join(cli, "scripts", "npm-window.mjs")], { cwd: cli, encoding: "utf8",
      env: { ...base, ...env, NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(stub)}` } });
    return { code: r.status, out: r.stdout + r.stderr };
  };
  const honest = window();
  ok("honest: a clean tree at origin/master passes every check in check mode, exit 0",
    honest.code === 0 && /pass: @x\/p: verify-tarball/.test(honest.out) && /check: every step passed \(check mode, nothing published\)/.test(honest.out), honest.out);
  writeFileSync(join(cli, "stray.txt"), "not committed\n");
  const dirty = window();
  rmSync(join(cli, "stray.txt"));
  ok("a local change: exit 1 and REFUSED naming the clean-tree check",
    dirty.code === 1 && /REFUSED: 1 check\(s\) failed: the tree has no local change \(check mode, nothing published\)/.test(dirty.out), dirty.out);
  const skip = window({ CSD_PUBLISH_SKIP_TESTS: "1" });
  ok("CSD_PUBLISH_SKIP_TESTS=1 in the process environment: exit 1 and REFUSED naming it",
    skip.code === 1 && /REFUSED: 1 check\(s\) failed: CSD_PUBLISH_SKIP_TESTS is not set/.test(skip.out), skip.out);
}

console.log("publish step (stand-in npm and registry):");
{
  const TOKEN = "npm_" + "Q".repeat(36);
  const tokenFile = join(work, "token");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  // the stand-in npm records its argv and whether the userconfig it was given holds the token line
  const record = join(work, "npm-calls.jsonl");
  const npm = join(work, "fake-npm.mjs");
  writeFileSync(npm, `#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const a = process.argv.slice(2), rc = a[a.indexOf("--userconfig") + 1];
const authed = readFileSync(rc, "utf8").includes("_authToken=${TOKEN}");
const pub = a[0] === "publish" ? readFileSync(a[1]) : null;
const published = pub ? { published: createHash("sha1").update(pub).digest("hex"), integrity: "sha512-" + createHash("sha512").update(pub).digest("base64") } : {};
appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: a, rc, authed, ...published }) + "\\n");
if (a[0] === "whoami") console.log("owner");
if (a[0] === "publish") { if (a[1].includes("fail")) { console.error("E403 ${TOKEN}"); process.exit(1); } console.log("+ " + a[1]); }
`);
  chmodSync(npm, 0o755);
  const mkTgz = (name: string) => { const p = join(work, name); writeFileSync(p, `bytes of ${name}`); return p; };
  // the digests checkWindow records from the bytes verify-tarball read
  const digests = (path: string) => { const b = readFileSync(path); return { sha1: createHash("sha1").update(b).digest("hex"), integrity: "sha512-" + createHash("sha512").update(b).digest("base64") }; };
  const entry = (name: string, file: string) => { const path = mkTgz(file); return { name, version: "1.0.0", path, ...digests(path) }; };
  const tb = [entry("@x/a", "a.tgz"), entry("@x/b", "b.tgz")];
  const meta = (path: string, shasumOverride?: string) => {
    const b = readFileSync(path);
    return { dist: { shasum: shasumOverride ?? createHash("sha1").update(b).digest("hex"), integrity: "sha512-" + createHash("sha512").update(b).digest("base64") } };
  };
  const registry = (bad = "") => async (name: string) => {
    const t = tb.find((x) => x.name === name)!;
    return { status: 200, meta: meta(t.path, name === bad ? "0".repeat(40) : undefined) };
  };
  const calls = () => existsSync(record) ? readFileSync(record, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  const run = async (o: { confirm?: string; tarballs?: typeof tb; bad?: string; tokenFile?: string } = {}) => {
    rmSync(record, { force: true });
    const lines: string[] = [];
    const r = await publishWindow({ tarballs: o.tarballs ?? tb, tokenFile: o.tokenFile ?? tokenFile, npm, registry: registry(o.bad), waitMs: 0, pollMs: 0,
      confirm: async () => o.confirm ?? "publish", log: (s: string) => lines.push(s) });
    return { r, lines, calls: calls() };
  };

  const honest = await run();
  ok("honest window: both published in order with the token's userconfig and both registry entries match",
    honest.r.ok && honest.r.published.join() === "@x/a@1.0.0,@x/b@1.0.0" && honest.calls.map((c) => c.argv[0]).join() === "whoami,publish,publish"
      && honest.calls.every((c) => c.authed) && honest.lines.filter((l) => l.endsWith("MATCH")).length === 2, JSON.stringify(honest.r));
  ok("the token is in no npm argv and no log line, and the userconfig is gone afterwards",
    !JSON.stringify(honest.calls.map((c) => c.argv)).includes(TOKEN) && !honest.lines.join("\n").includes(TOKEN)
      && honest.calls.every((c) => !existsSync(c.rc)) && honest.calls.every((c) => !c.rc.startsWith(root)));

  const declined = await run({ confirm: "y" });
  ok("without the typed word publish, npm is never run", !declined.r.ok && declined.calls.length === 0);

  const loose = join(work, "loose-token");
  writeFileSync(loose, TOKEN, { mode: 0o644 });
  chmodSync(loose, 0o644);
  const lr = await run({ tokenFile: loose });
  ok("a token file others can read is refused before anything runs", !lr.r.ok && lr.calls.length === 0 && /readable by others/.test(lr.r.failures.join()));

  const failing = await run({ tarballs: [tb[0]!, entry("@x/fail", "fail.tgz"), tb[1]!] });
  ok("a failed publish stops the rest, names what is unpublished and redacts the token from npm's output",
    !failing.r.ok && failing.calls.filter((c) => c.argv[0] === "publish").length === 2 && failing.r.published.join() === "@x/a@1.0.0"
      && /not published: @x\/fail@1.0.0, @x\/b@1.0.0/.test(failing.r.failures.join()) && !failing.r.failures.join().includes(TOKEN)
      && failing.calls.every((c) => !existsSync(c.rc)), JSON.stringify(failing.r.failures));

  const mism = await run({ bad: "@x/b" });
  ok("a registry entry that is not the packed tarball fails the window", !mism.r.ok && mism.lines.some((l) => l.startsWith("@x/b@1.0.0") && l.endsWith("MISMATCH")));

  // the registry serves what npm was handed, as the real one does
  const servesWhatNpmGot = async () => {
    const p = calls().find((c) => c.published);
    return p ? { status: 200, meta: { dist: { shasum: p.published, integrity: p.integrity } } } : { status: 404, meta: null };
  };
  // a tarball replaced after verification (another process repacking into the directory during the confirmation)
  const swap = async (o: { during: "confirm" | "publish" }) => {
    rmSync(record, { force: true });
    const t = [entry("@x/s", `s-${o.during}.tgz`)];
    const verifiedSha1 = t[0]!.sha1;
    const replace = () => writeFileSync(t[0]!.path, "replaced after verification");
    // for "publish" the path is swapped once npm has run
    const lines: string[] = [];
    const r = await publishWindow({ tarballs: t, tokenFile, npm, registry: servesWhatNpmGot, waitMs: 0, pollMs: 0, log: (s: string) => { lines.push(s); if (o.during === "publish" && / publish @x\/s@/.test(s)) replace(); },
      confirm: async () => { if (o.during === "confirm") replace(); return "publish"; } });
    return { r, lines, verifiedSha1, publishedSha1: calls().find((c) => c.published)?.published as string | undefined, npmRan: calls().length };
  };
  const during = await swap({ during: "confirm" });
  ok("a tarball replaced during the confirmation is refused before npm runs, never published",
    !during.r.ok && during.npmRan === 0 && during.publishedSha1 === undefined && /not the bytes that were verified/.test(during.r.failures.join()), JSON.stringify({ r: during.r, published: during.publishedSha1 }));
  const after = await swap({ during: "publish" });
  ok("the registry is compared with the digests recorded at verification, not a re-read of the path: the verified bytes published, MATCH",
    after.r.ok && after.publishedSha1 === after.verifiedSha1 && after.lines.some((l) => l.endsWith("MATCH")), JSON.stringify({ r: after.r, lines: after.lines }));

  // checkWindow's results through finishWindow, as main() runs them: real checks of csd-crypto, the stand-in npm
  const { honest: honestChecked, verifyFailed } = checked!;
  const finish = async (c: Checked, o: { run: boolean; publish?: typeof publishWindow }) => {
    rmSync(record, { force: true });
    const lines: string[] = [];
    let publishCalls = 0;
    // without o.publish, a stand-in that only counts: any call at all is the failure the refusal cases look for
    const code = await finishWindow({ ...c, run: o.run, tokenFile, out: c.out, log: (s) => lines.push(s), confirm: async () => "publish",
      publish: async (a) => { publishCalls++; return o.publish ? o.publish(a) : { ok: true, published: [], failures: [] }; } });
    return { code, lines: lines.join("\n"), publishCalls, npm: calls() };
  };
  const real = (a: Parameters<typeof publishWindow>[0]) => publishWindow({ ...a, npm, registry: servesWhatNpmGot, waitMs: 0, pollMs: 0 });
  const runHonest = await finish(honestChecked, { run: true, publish: real });
  const crypto0 = honestChecked.tarballs[0]!;
  ok("honest window run: every check passed, so csd-crypto's verified bytes are published and match, exit 0",
    runHonest.code === 0 && runHonest.publishCalls === 1 && runHonest.npm.map((c) => c.argv[0]).join() === "whoami,publish"
      && runHonest.npm[1]?.published === crypto0.sha1 && /published and verified: @inversealtruism\/csd-crypto@/.test(runHonest.lines), runHonest.lines);
  const publishLog = existsSync(join(honestChecked.out, "publish.log")) ? readFileSync(join(honestChecked.out, "publish.log"), "utf8") : "";
  ok("the publish step's lines are kept in <out>/publish.log", /^npm whoami: owner$/m.test(publishLog) && / publish @inversealtruism\/csd-crypto@\S+ exit 0 /.test(publishLog) && /MATCH$/m.test(publishLog), publishLog);
  const incomplete = await finish(honestChecked, { run: true, publish: async () => ({ ok: false, published: [], failures: ["stand-in: npm publish failed"] }) });
  ok("a publish step that did not complete exits 1 and names its failure",
    incomplete.code === 1 && /FAIL: stand-in: npm publish failed/.test(incomplete.lines) && /STOP: the window did not complete/.test(incomplete.lines), incomplete.lines);
  const nothing = (fails: string[]) => finishWindow({ fails, order: [], tarballs: [], run: true, tokenFile, out: honestChecked.out, log: () => undefined, confirm: async () => "publish",
    publish: async () => { throw new Error("publish called with nothing to publish"); } });
  const nothingOk = await nothing([]), nothingFailed = await nothing(["the tree has no local change"]);
  ok("nothing to publish: exit 0 when every check passed, exit 1 when one failed", nothingOk === 0 && nothingFailed === 1, `${nothingOk} ${nothingFailed}`);
  const checkOnly = await finish(honestChecked, { run: false });
  ok("check mode with every check passed publishes nothing, exit 0", checkOnly.code === 0 && checkOnly.publishCalls === 0 && /check mode, nothing published/.test(checkOnly.lines), checkOnly.lines);
  const refused = await finish(verifyFailed, { run: true });
  ok("a run with a failed check (verify-tarball) never reaches the publish step, exit 1",
    refused.code === 1 && refused.publishCalls === 0 && /REFUSED: 1 check\(s\) failed: .*verify-tarball; nothing was published/.test(refused.lines), refused.lines);
  // the refusal above is the first stop; publishWindow is the second, whatever its caller checked
  rmSync(record, { force: true });
  const direct = await real({ tarballs: verifyFailed.tarballs, tokenFile, confirm: async () => "publish", log: () => undefined });
  ok("publishWindow handed the tarball that failed verify-tarball refuses it and never runs npm",
    !direct.ok && direct.published.length === 0 && /no digest was recorded at verification; nothing was published/.test(direct.failures.join()) && calls().length === 0, JSON.stringify(direct));
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
