// Offline checks of the npm window (scripts/npm-window.mjs, scripts/verify-tarball.mjs). The window publishes with
// `npm publish <tgz>`, which runs no package hook, so these are the checks on that path: the tarball gate on a real
// `pnpm pack` of csd-crypto (needs a built dist, as CI has) and the publish step against a stand-in npm and registry.
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { verifyTarball, workspaceVersions } from "../scripts/verify-tarball.mjs";
import { checkWindow, headOnOriginMaster, publishWindow } from "../scripts/npm-window.mjs";

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
}

console.log("window checks (stand-in git and publish guard; real pack and verify-tarball of csd-crypto):");
{
  const CRYPTO = "@inversealtruism/csd-crypto";
  const window = async (o: { guard?: boolean; onMaster?: boolean; verify?: typeof verifyTarball } = {}) => {
    const out = mkdtempSync(join(work, "win-"));
    const sh = (cmd: string, args: string[], cwd: string) => {
      if (cmd === "git") return { ok: args[0] === "merge-base" ? (o.onMaster ?? true) : true, out: "" };
      if (args[0] === "run" && args[1] === "prepublishOnly") return { ok: o.guard ?? true, out: "stand-in publish guard" };
      if (args[0] === "pack") {
        try { execFileSync(cmd, args, { cwd, env: { ...process.env, npm_config_ignore_scripts: "true" }, stdio: "ignore" }); return { ok: true, out: "" }; }
        catch (e) { return { ok: false, out: String(e) }; }
      }
      throw new Error(`unexpected command: ${cmd} ${args.join(" ")}`);
    };
    const registry = async (name: string) => ({ status: name === CRYPTO ? 404 : 200, meta: null });
    const lines: string[] = [];
    const r = await checkWindow({ root, out, run: false, log: (l) => lines.push(l), sh, registry, verify: o.verify ?? verifyTarball, env: {} });
    return { ...r, lines: lines.join("\n") };
  };

  const honest = await window();
  ok("honest: csd-crypto is the one package to publish and every check passes", honest.fails.length === 0 && honest.order.map((p) => p.name).join() === CRYPTO && honest.tarballs.every((t) => existsSync(t.path)), honest.fails.join("; "));
  ok("checkWindow records the digests of the packed bytes it verified on each tarball",
    honest.tarballs.length === 1 && honest.tarballs.every((t) => { const b = readFileSync(t.path); return t.sha1 === createHash("sha1").update(b).digest("hex") && t.integrity === "sha512-" + createHash("sha512").update(b).digest("base64"); }));
  const guard = await window({ guard: false });
  ok("a failing publish guard fails the window, and nothing else does", guard.fails.length === 1 && /publish guard/.test(guard.fails[0]!), guard.fails.join("; "));
  const verify = await window({ verify: () => ["dist/index.js differs from the local build"] });
  ok("a failing verify-tarball fails the window, and nothing else does", verify.fails.length === 1 && /verify-tarball/.test(verify.fails[0]!), verify.fails.join("; "));
  const off = await window({ onMaster: false });
  ok("a HEAD that is not on origin/master fails the window, and nothing else does", off.fails.length === 1 && /origin\/master/.test(off.fails[0]!), off.fails.join("; "));
}

console.log("HEAD on origin/master (real git):");
{
  const repo = mkdtempSync(join(work, "repo-"));
  const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...a], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "master");
  git("commit", "-q", "--allow-empty", "-m", "merged");
  git("update-ref", "refs/remotes/origin/master", "HEAD");
  ok("a commit that is origin/master passes", headOnOriginMaster(repo));
  git("checkout", "-q", "-b", "topic");
  git("commit", "-q", "--allow-empty", "-m", "unmerged");
  git("update-ref", "refs/remotes/origin/topic", "HEAD");
  ok("a commit pushed on a topic branch, not merged, is refused", !headOnOriginMaster(repo) && git("branch", "-r", "--contains", "HEAD").trim() !== "");
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

  // a tarball replaced after verification (another process repacking into the directory during the confirmation)
  const swap = async (o: { during: "confirm" | "publish" }) => {
    rmSync(record, { force: true });
    const t = [entry("@x/s", `s-${o.during}.tgz`)];
    const verifiedSha1 = t[0]!.sha1;
    const replace = () => writeFileSync(t[0]!.path, "replaced after verification");
    // the registry serves what npm was handed, as the real one does; for "publish" the path is swapped once npm has run
    const lines: string[] = [];
    const registry = async () => {
      const p = calls().find((c) => c.published);
      return p ? { status: 200, meta: { dist: { shasum: p.published, integrity: p.integrity } } } : { status: 404, meta: null };
    };
    const r = await publishWindow({ tarballs: t, tokenFile, npm, registry, waitMs: 0, pollMs: 0, log: (s: string) => { lines.push(s); if (o.during === "publish" && / publish @x\/s@/.test(s)) replace(); },
      confirm: async () => { if (o.during === "confirm") replace(); return "publish"; } });
    return { r, lines, verifiedSha1, publishedSha1: calls().find((c) => c.published)?.published as string | undefined, npmRan: calls().length };
  };
  const during = await swap({ during: "confirm" });
  ok("a tarball replaced during the confirmation is refused before npm runs, never published",
    !during.r.ok && during.npmRan === 0 && during.publishedSha1 === undefined && /not the bytes that were verified/.test(during.r.failures.join()), JSON.stringify({ r: during.r, published: during.publishedSha1 }));
  const after = await swap({ during: "publish" });
  ok("the registry is compared with the digests recorded at verification, not a re-read of the path: the verified bytes published, MATCH",
    after.r.ok && after.publishedSha1 === after.verifiedSha1 && after.lines.some((l) => l.endsWith("MATCH")), JSON.stringify({ r: after.r, lines: after.lines }));
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${fail === 0 ? "ALL PASS" : "FAILURES"}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
