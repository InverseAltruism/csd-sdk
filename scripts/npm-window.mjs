#!/usr/bin/env node
// The npm window: publish every workspace package whose version is not on npm yet, from the tarballs checked here.
// `npm publish <tgz>` runs no package hook, so this script runs the gate itself, on the bytes it will publish.
//
//   node scripts/npm-window.mjs [--out <dir>]
//       check mode, publishes nothing: the plan (unpublished versions, dependencies first), then per package
//       `pnpm pack` (its prepack builds dist/), the publish guard (`pnpm run prepublishOnly`: lockstep, the package
//       suite, test:crosslang for cairnx-core) and verify-tarball.mjs on the packed tarball; SHA1SUMS and
//       SHA256SUMS. Without --out the tarballs go to a temporary directory that is removed.
//   node scripts/npm-window.mjs --out <dir> --run --token-file <path>
//       the same checks, which must all pass, on a clean tree whose HEAD is on origin/master; then a typed
//       confirmation, `npm whoami`, `npm publish <tgz>` per package in order, and each registry dist.shasum and
//       dist.integrity compared with the tarball. <dir> must be new or empty; it keeps the tarballs and the logs.
// The token file is the owner's one-time token, a file of mode 600 owned by the caller. Its content is copied into
// a userconfig in a private temporary directory, passed to npm as a path and removed when the script exits; it is
// not printed, not put in any argv and not written under this repo.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { integrityOk } from "./published-dist.mjs";
import { verifyTarball, workspaceVersions } from "./verify-tarball.mjs";
import { registryVersion, workspacePackages } from "./workspace.mjs";

const USAGE = `usage: node scripts/npm-window.mjs [--out <dir>]
       node scripts/npm-window.mjs --out <dir> --run --token-file <path>`;

/** @typedef {{ name: string, version: string, path: string }} Tarball */
/** @typedef {(name: string, version: string) => Promise<{ status: number, meta: any }>} RegistryRead */

const sha = (/** @type {string} */ alg, /** @type {Uint8Array} */ b) => createHash(alg).update(b).digest("hex");

/**
 * Packages in an order where each comes after the workspace packages it depends on; ties by name.
 * @template {{ name: string, dependencies?: Record<string, string>, peerDependencies?: Record<string, string> }} P
 * @param {P[]} pkgs
 * @returns {P[]}
 */
export function publishOrder(pkgs) {
  const names = new Set(pkgs.map((p) => p.name));
  /** @type {P[]} */
  const out = [];
  const left = [...pkgs].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  while (left.length) {
    const i = left.findIndex((p) => Object.keys({ ...p.dependencies, ...p.peerDependencies })
      .every((d) => !names.has(d) || out.some((o) => o.name === d)));
    if (i < 0) throw new Error(`dependency cycle among ${left.map((p) => p.name).join(", ")}`);
    out.push(...left.splice(i, 1));
  }
  return out;
}

/**
 * The token, read from a regular file of mode 600 (no group or other bits) owned by this user, or a refusal.
 * @param {string} path
 * @returns {{ ok: true, token: string } | { ok: false, reason: string }}
 */
export function readTokenFile(path) {
  let st;
  try { st = lstatSync(path); } catch { return { ok: false, reason: `token file ${path} not found` }; }
  if (!st.isFile()) return { ok: false, reason: `token file ${path} is not a regular file` };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { ok: false, reason: `token file ${path} is not owned by this user` };
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: `token file ${path} is readable by others (mode ${(st.mode & 0o777).toString(8)}); chmod 600 it` };
  const token = readFileSync(path, "utf8").trim();
  if (!/^\S+$/.test(token)) return { ok: false, reason: `token file ${path} does not hold one token` };
  return { ok: true, token };
}

/**
 * Publish checked tarballs with a one-time token and compare each registry entry with the tarball. Every step after
 * the confirmation is logged; a publish failure stops the rest. The userconfig is removed on every exit path.
 * @param {{ tarballs: Tarball[], tokenFile: string, confirm: (question: string) => Promise<string>,
 *   log: (line: string) => void, npm?: string, registry?: RegistryRead, waitMs?: number, pollMs?: number }} o
 * @returns {Promise<{ ok: boolean, published: string[], failures: string[] }>}
 */
export async function publishWindow(o) {
  const { tarballs, log } = o;
  const npm = o.npm ?? "npm";
  const registry = o.registry ?? registryVersion;
  /** @type {string[]} */
  const published = [], failures = [];
  const t = readTokenFile(o.tokenFile);
  if (!t.ok) return { ok: false, published, failures: [t.reason] };
  const redact = (/** @type {string} */ s) => s.split(t.token).join("[token]").replace(/npm_[A-Za-z0-9]{8,}/g, "npm_[redacted]");
  const answer = await o.confirm(`Type "publish" to publish these ${tarballs.length} tarballs to npm: `);
  if (answer.trim() !== "publish") return { ok: false, published, failures: ["stopped by the operator before publishing"] };

  const dir = mkdtempSync(join(tmpdir(), "csd-npm-window-"));
  const rc = join(dir, "npmrc");
  // npm reads npm_config_* from the environment (pnpm sets several when it runs a script); none may steer this run
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)));
  const run = (/** @type {string[]} */ args) => {
    const r = spawnSync(npm, [...args, "--userconfig", rc], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: r.status === 0, text: redact(`${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`).trim() };
  };
  const scrub = () => {
    if (existsSync(rc)) writeFileSync(rc, "\0".repeat(256));
    rmSync(dir, { recursive: true, force: true });
  };
  const onSignal = () => { scrub(); process.exit(130); };
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);
  try {
    writeFileSync(rc, `registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=${t.token}\n`, { mode: 0o600 });
    const who = run(["whoami"]);
    log(`npm whoami: ${who.text}`);
    if (!who.ok) return { ok: false, published, failures: ["npm whoami failed; nothing was published"] };
    for (const tb of tarballs) {
      const r = run(["publish", tb.path, "--access", "public", "--ignore-scripts"]);
      log(`${new Date().toISOString()} publish ${tb.name}@${tb.version} exit ${r.ok ? 0 : 1} ${r.text.split("\n").at(-1) ?? ""}`);
      if (!r.ok) { failures.push(`npm publish ${tb.name}@${tb.version} failed: ${r.text}`); break; }
      published.push(`${tb.name}@${tb.version}`);
    }
  } finally {
    scrub();
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
  }
  const unpublished = tarballs.slice(published.length).map((tb) => `${tb.name}@${tb.version}`);
  if (unpublished.length) failures.push(`not published: ${unpublished.join(", ")}`);

  const waitMs = o.waitMs ?? 600_000, pollMs = o.pollMs ?? 15_000;
  for (const tb of tarballs.slice(0, published.length)) {
    const bytes = new Uint8Array(readFileSync(tb.path));
    const local = sha("sha1", bytes);
    const end = Date.now() + waitMs;
    let got = await registry(tb.name, tb.version);
    while (got.status !== 200 && Date.now() < end) { await new Promise((r) => setTimeout(r, pollMs)); got = await registry(tb.name, tb.version); }
    if (got.status !== 200) { failures.push(`${tb.name}@${tb.version}: not on the registry after ${waitMs / 1000} s (HTTP ${got.status})`); continue; }
    const match = got.meta?.dist?.shasum === local && integrityOk(bytes, got.meta?.dist?.integrity);
    log(`${tb.name}@${tb.version} registry ${got.meta?.dist?.shasum} local ${local} ${match ? "MATCH" : "MISMATCH"}`);
    if (!match) failures.push(`${tb.name}@${tb.version}: the registry entry is not the packed tarball`);
  }
  return { ok: failures.length === 0, published, failures };
}

/** @typedef {(cmd: string, args: string[], cwd: string) => { ok: boolean, out: string }} Sh */

/** @type {Sh} */
const sh = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};

/**
 * Whether HEAD is reachable from origin/master as last fetched: the release ships merged code only, so a pushed topic
 * branch does not qualify.
 * @param {string} root
 * @param {Sh} [run]
 */
export function headOnOriginMaster(root, run = sh) {
  return run("git", ["merge-base", "--is-ancestor", "HEAD", "origin/master"], root).ok;
}

/**
 * Every check of a window, logged, in order: the tree and HEAD, the plan, then per package pack, publish guard and
 * verify-tarball on the packed bytes. A failed check is logged and returned in `fails`; the caller refuses on any.
 * `sh`, `registry`, `verify` and `env` default to the real ones; a test stands in for them.
 * @param {{ root: string, out: string, run: boolean, log: (line: string) => void, sh?: Sh, registry?: RegistryRead,
 *   verify?: typeof verifyTarball, env?: Record<string, string | undefined> }} o
 * @returns {Promise<{ fails: string[], order: any[], tarballs: Tarball[] }>}
 */
export async function checkWindow(o) {
  const { root, out, log } = o;
  const exec = o.sh ?? sh;
  const registry = o.registry ?? registryVersion;
  const verify = o.verify ?? verifyTarball;
  /** @type {string[]} */
  const fails = [];
  /** @type {Tarball[]} */
  const tarballs = [];
  const chk = (/** @type {string} */ what, /** @type {boolean} */ c, detail = "") => {
    log(`  ${c ? "pass" : "FAIL"}: ${what}`); if (!c) { fails.push(what); if (detail) log(detail.trimEnd().split("\n").slice(-20).map((l) => `    ${l}`).join("\n")); }
  };
  log(`== npm window ${o.run ? "run" : "check"} at ${exec("git", ["rev-parse", "--short", "HEAD"], root).out.trim()} (${new Date().toISOString()})`);
  chk("the tree has no local change", exec("git", ["status", "--porcelain"], root).out.trim() === "");
  chk("HEAD is on origin/master", headOnOriginMaster(root, exec));
  chk("CSD_PUBLISH_SKIP_TESTS is not set (the guard runs the suites)", (o.env ?? process.env).CSD_PUBLISH_SKIP_TESTS === undefined);

  log("\n== plan");
  /** @type {any[]} */
  const todo = [];
  for (const p of workspacePackages(root).filter((x) => !x.private)) {
    const { status } = await registry(p.name, p.version);
    if (status === 404) todo.push(p);
    else chk(`${p.name}@${p.version} is already on npm (registry HTTP ${status})`, status === 200);
  }
  const order = publishOrder(todo);
  if (!order.length) { log("  nothing to publish: every workspace version is on npm"); return { fails, order, tarballs }; }
  for (const p of order) log(`  ${p.name}@${p.version}`);

  log("\n== pack, guard, verify");
  const versions = workspaceVersions(root);
  for (const p of order) {
    const dir = join(root, "packages", p.__dir);
    const file = join(out, `${p.name.replace("@", "").replace("/", "-")}-${p.version}.tgz`);
    const packed = exec("pnpm", ["pack", "--pack-destination", out], dir);
    chk(`${p.name}: pnpm pack`, packed.ok && existsSync(file), packed.out);
    tarballs.push({ name: p.name, version: p.version, path: file });
  }
  for (const p of order) {
    const g = exec("pnpm", ["run", "prepublishOnly"], join(root, "packages", p.__dir));
    chk(`${p.name}: publish guard (lockstep, tests${p.name.endsWith("/cairnx-core") ? ", test:crosslang" : ""})`, g.ok, g.out);
  }
  for (const [i, p] of order.entries()) {
    const tb = tarballs[i];
    if (!tb || !existsSync(tb.path)) continue;
    const v = verify(new Uint8Array(readFileSync(tb.path)), join(root, "packages", p.__dir), versions);
    chk(`${p.name}: verify-tarball`, v.length === 0, v.join("\n"));
  }
  const sums = (/** @type {string} */ alg) => tarballs.filter((tb) => existsSync(tb.path))
    .map((tb) => `${sha(alg, new Uint8Array(readFileSync(tb.path)))}  ${tb.path.slice(out.length + 1)}\n`).join("");
  writeFileSync(join(out, "SHA1SUMS"), sums("sha1")); writeFileSync(join(out, "SHA256SUMS"), sums("sha256"));
  return { fails, order, tarballs };
}

async function main() {
  const a = process.argv.slice(2);
  let out = "", run = false, tokenFile = "";
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--run") run = true;
    else if (a[i] === "--out" && a[i + 1]) out = resolve(String(a[++i]));
    else if (a[i] === "--token-file" && a[i + 1]) tokenFile = resolve(String(a[++i]));
    else { console.error(USAGE); process.exit(2); }
  }
  if (run !== !!tokenFile || (run && !out)) { console.error(USAGE); process.exit(2); }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const keep = !!out;
  if (out) {
    if (existsSync(out) && readdirSync(out).length) { console.error(`STOP: ${out} is not empty`); process.exit(1); }
    mkdirSync(out, { recursive: true });
  } else out = mkdtempSync(join(tmpdir(), "csd-npm-window-check-"));
  const logFile = join(out, "window.log");
  const log = (/** @type {string} */ s) => { console.log(s); if (keep) appendFileSync(logFile, `${s}\n`); };
  try {
    const { fails, order, tarballs } = await checkWindow({ root, out, run, log });
    if (!order.length) return fails.length ? 1 : 0;

    if (!run || fails.length) {
      log(`\n${fails.length ? `REFUSED: ${fails.length} check(s) failed: ${fails.join("; ")}` : "check: every step passed"}${run ? "; nothing was published" : " (check mode, nothing published)"}`);
      return fails.length ? 1 : 0;
    }
    log("\n== publish");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const result = await publishWindow({
      tarballs, tokenFile, log: (s) => { log(`  ${s}`); appendFileSync(join(out, "publish.log"), `${s}\n`); },
      confirm: async (q) => { try { return await rl.question(q); } catch { return ""; } finally { rl.close(); } },
    });
    for (const f of result.failures) log(`  FAIL: ${f}`);
    log(result.ok ? `\npublished and verified: ${result.published.join(", ")}` : "\nSTOP: the window did not complete; see the FAIL lines");
    return result.ok ? 0 : 1;
  } finally {
    if (!keep) rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(await main());
