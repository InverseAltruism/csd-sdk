// The exit check of the replica's release: in an empty directory outside this repository, install cairnx-replica,
// cairnx-pin and csd-anchors (the tarballs packed from this tree, or the published versions HEAD's manifests name), then
// from that install alone: import every entry of the three under ESM and require; read every packed file for an em dash
// or a private path; type-check examples/deposits.ts against the installed types; run the worked examples against
// recorded answers; and run `cairnx-replica check` five ways, each to the tuple at its fixture's newest final boundary,
// against the committed reference. Offline: every source is a loopback server over a recorded capture. Live, with
// --live, only the legs whose endpoint is named run, each compared with --reference.
//
//   pnpm exec tsx packages/replica/scripts/exit-check.ts [--from packed|npm] [--keep]
//   pnpm exec tsx packages/replica/scripts/exit-check.ts --from npm --live --reference <base> [--indexer <base>] [--origin <origin>] [--node <url>] [--full] [--timeout-ms <ms>]
//   pnpm exec tsx packages/replica/scripts/exit-check.ts --write-answers     (records the examples' answers again)
// The packed mode needs a built tree (pnpm -r build). --full adds the live legs that read from the activation height.
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { packedOffences } from "../../../scripts/check-dashes-paths.mjs";
import { untar } from "../../../scripts/published-dist.mjs";
import { workspacePackagesAtHead } from "../../../scripts/workspace.mjs";
import { done, ok } from "../test/check.js";
import { fx } from "../test/core-files.js";
import { frontDoor } from "../test/front-door.js";
import { all } from "../test/hosted-harness.js";
import { captureIndexer } from "../test/indexer-capture.js";
import { cap, node } from "../test/node-harness.js";

const PKG = join(dirname(fileURLToPath(import.meta.url)), ".."), ROOT = join(PKG, "..", "..");
const SCOPE = "@inversealtruism/";
/** The packages the check installs by name, their workspace dependencies with them, and the surface each documents:
 *  its exports entries (a removed one is a breaking change) and the files beside dist/ its README names. */
const SURFACE: Record<string, { entries: string[]; files: string[] }> = {
  "cairnx-replica": { entries: [".", "./display", "./browser", "./server", "./testing"], files: ["dist/cli.js", "README.md", "LICENSE", "CHANGELOG.md"] },
  "cairnx-pin": { entries: [".", "./pin.json"], files: ["pin.json", "README.md", "LICENSE", "CHANGELOG.md"] },
  "csd-anchors": { entries: [".", "./anchors.json"], files: ["anchors.json", "scripts/table.mjs", "scripts/render-wallet.mjs", "README.md", "LICENSE", "CHANGELOG.md"] },
};
const NAMES = Object.keys(SURFACE);
const ANSWERS = join(PKG, "examples", "answers.json"), REFERENCE = join(PKG, "scripts", "exit-reference.json");
const PIN_CAPTURE = join(ROOT, "packages", "pin", "test", "fixtures", "node-blocks-143296-143356.json");

const argv = process.argv.slice(2);
const flag = (k: string) => argv.includes(k);
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const from = arg("--from") ?? "packed", live = flag("--live"), write = flag("--write-answers");
if (from !== "packed" && from !== "npm") throw new Error("--from is packed or npm");
if (live && arg("--reference") === undefined) throw new Error("--live needs --reference <base>, the host each leg is compared with");

const heads = workspacePackagesAtHead(ROOT);
const byName = new Map(heads.map((p) => [String(p.name), p]));
/** Each of NAMES with every workspace package it depends on or peers on, transitively. */
function closure(): Record<string, any>[] {
  const out = new Map<string, Record<string, any>>();
  const add = (name: string) => {
    const p = byName.get(name);
    if (p === undefined || out.has(name)) return;
    out.set(name, p);
    for (const d of Object.keys({ ...p.dependencies, ...p.peerDependencies })) add(d);
  };
  for (const n of NAMES) add(SCOPE + n);
  return [...out.values()];
}

const run = (cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 });
/** A child's exit code and output; the child runs while this process serves its sources. With `echo`, its stderr (the
 *  command's progress and errors) is printed as it comes. */
const child = (cmd: string, args: string[], cwd: string, echo = false) => new Promise<{ code: number | null; out: string; err: string }>((done_) => {
  const c = spawn(cmd, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  let out = "", err = "";
  c.stdout.on("data", (b) => { out += b; }); c.stderr.on("data", (b) => { err += b; if (echo) process.stdout.write(String(b).replace(/^(?=.)/gm, "    | ")); });
  c.on("close", (code) => done_({ code, out, err }));
});

/** A loopback server answering through `f`, a fetch-shaped stand-in for one source. */
async function serve(f: typeof fetch): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    void (async () => {
      const r = await f(`http://stand.in${req.url ?? "/"}`);
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      res.writeHead(r.status, headers);
      res.end(Buffer.from(await r.arrayBuffer()));
    })().catch((e: unknown) => { res.writeHead(500); res.end(String(e)); });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const work = mkdtempSync(join(tmpdir(), "cairnx-exit-check-"));
const servers: Server[] = [];
try {
  console.log(`install (${from}) into ${work}:`);
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "cairnx-exit-check", private: true, type: "module" }));
  let specs: string[];
  const tarballs = new Map<string, string>();
  if (from === "packed") {
    const tgz = join(work, "tarballs");
    mkdirSync(tgz);
    for (const p of closure()) {
      const dir = join(ROOT, "packages", p.__dir);
      if (!existsSync(join(dir, "dist"))) throw new Error(`${p.name} has no dist/: run pnpm -r build first`);
      run("pnpm", ["pack", "--pack-destination", tgz], dir, { ...process.env, npm_config_ignore_scripts: "true" });
      tarballs.set(String(p.name), join(tgz, `${String(p.name).replace("@", "").replace("/", "-")}-${p.version}.tgz`));
    }
    specs = [...tarballs.values()];
  } else {
    specs = closure().map((p) => `${p.name}@${p.version}`);
  }
  // our own scope is new on the registry at a window, so the install-age cooldown is lifted for this one command
  const cooldown = from === "npm" ? ["--min-release-age=0"] : [];
  run("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts", "--loglevel=error", ...cooldown, ...specs], work);
  const installed = (n: string) => JSON.parse(readFileSync(join(work, "node_modules", ...(SCOPE + n).split("/"), "package.json"), "utf8"));
  ok(`npm installed ${specs.length} packages, the three at the versions HEAD names`,
    NAMES.every((n) => installed(n).version === byName.get(SCOPE + n)?.version), NAMES.map((n) => `${n}@${installed(n).version}`).join(" "));

  console.log("every entry of the three, from the install:");
  for (const n of NAMES) {
    const m = installed(n), name = SCOPE + n, at = join(work, "node_modules", ...name.split("/"));
    const entries = Object.keys(m.exports as Record<string, unknown>), missing = SURFACE[n]!.files.filter((f) => !existsSync(join(at, f)));
    ok(`${n}: its entries are ${SURFACE[n]!.entries.join(" ")}, and ${SURFACE[n]!.files.join(", ")} are installed`,
      entries.join() === SURFACE[n]!.entries.join() && missing.length === 0, `entries ${entries.join(" ")}; missing ${missing.join(", ")}`);
    for (const [sub, target] of Object.entries(m.exports as Record<string, unknown>)) {
      const spec = sub === "." ? name : name + sub.slice(1), json = sub.endsWith(".json");
      const types = typeof target === "object" && target !== null ? (target as { types?: string }).types : undefined;
      const esm = await child(process.execPath, ["--input-type=module", "-e",
        `const m = await import(${JSON.stringify(spec)}${json ? ', { with: { type: "json" } }' : ""}); if (Object.keys(m).length === 0) process.exit(3);`], work);
      const cjs = await child(process.execPath, ["-e", `const m = require(${JSON.stringify(spec)}); if (Object.keys(m).length === 0) process.exit(3);`], work);
      const typed = types === undefined ? json : existsSync(join(work, "node_modules", ...name.split("/"), types));
      ok(`${spec}: import, require${json ? "" : " and its types"}`, esm.code === 0 && cjs.code === 0 && typed, `${esm.err}${cjs.err}`.trim().split("\n").slice(-3).join(" | "));
    }
  }
  // The pin peers on the replica for a type alone: a range, so a replica release inside it needs no pin release.
  const pinPeer = installed("cairnx-pin").peerDependencies?.[`${SCOPE}cairnx-replica`];
  ok(`cairnx-pin ships its replica peer as the range ^${installed("cairnx-replica").version}, optional`,
    pinPeer === `^${installed("cairnx-replica").version}` && installed("cairnx-pin").peerDependenciesMeta?.[`${SCOPE}cairnx-replica`]?.optional === true, String(pinPeer));
  const bin = join(work, "node_modules", ".bin", "cairnx-replica");
  const usage = await child(bin, [], work);
  ok("the command is installed: cairnx-replica with no arguments prints its usage and exits 2", usage.code === 2 && usage.out.includes("usage: cairnx-replica check"), usage.out + usage.err);

  if (from === "packed") {
    console.log("what the three tarballs ship:");
    for (const n of NAMES) {
      const files = untar(new Uint8Array(readFileSync(tarballs.get(SCOPE + n)!)));
      const bad = packedOffences(files);
      ok(`${n}: none of its ${files.size} files holds an em dash or a private path`, bad.length === 0, bad.join("; "));
    }
  }

  console.log("examples/deposits.ts against the installed types:");
  mkdirSync(join(work, "examples"));
  for (const f of ["deposits.ts", "feed.mjs", "own-node.mjs", "pinned.mjs"]) copyFileSync(join(PKG, "examples", f), join(work, "examples", f));
  const tsc = join(ROOT, "node_modules", "typescript", "bin", "tsc");
  let typeErrors = "";
  try {
    run(process.execPath, [tsc, "--noEmit", "--strict", "--noUncheckedIndexedAccess", "--module", "nodenext", "--moduleResolution", "nodenext",
      "--target", "es2022", "--lib", "es2022,dom", "--skipLibCheck", join(work, "examples", "deposits.ts")], work);
  } catch (e) { typeErrors = String((e as { stdout?: string }).stdout ?? e); }
  ok("tsc (strict, nodenext) finds no error in deposits.ts importing @inversealtruism/cairnx-replica/server", typeErrors === "", typeErrors.slice(0, 2_000));

  const pinCap = JSON.parse(readFileSync(PIN_CAPTURE, "utf8")) as { to: number; answers: Record<string, string> };
  const up = async (f: typeof fetch) => { const s = await serve(f); servers.push(s.server); return s.url; };
  const src = {
    node: await up(node({ answers: cap.answers }).f), nodePin: await up(node({ answers: pinCap.answers, tip: pinCap.to }).f),
    front: await up(frontDoor({ answers: all }, cap.to).f), frontPin: await up(frontDoor({ answers: pinCap.answers }, pinCap.to).f),
    indexer: await up(captureIndexer(fx)),
  };

  if (!live) {
    console.log("the worked examples against recorded answers:");
    const examples: Record<string, string[]> = {
      feed: [src.indexer, "cairn"],
      "own-node": [src.node, "CAIRN", "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016"],
      pinned: [src.frontPin, "m"],
    };
    const recorded = existsSync(ANSWERS) ? JSON.parse(readFileSync(ANSWERS, "utf8")) as Record<string, unknown> : {};
    const got: Record<string, unknown> = {};
    for (const [name, args] of Object.entries(examples)) {
      const r = await child(process.execPath, [join("examples", `${name}.mjs`), ...args], work);
      let answer: unknown = null;
      try { answer = JSON.parse(r.out); } catch { answer = null; }
      got[name] = answer;
      ok(`examples/${name}.mjs: exit 0, its answer the recorded one`, r.code === 0 && JSON.stringify(answer) === JSON.stringify(recorded[name]),
        `exit ${r.code}\n${r.out}${r.err}`.slice(0, 3_000));
    }
    if (write) { writeFileSync(ANSWERS, `${JSON.stringify(got, null, 2)}\n`); console.log(`  wrote ${ANSWERS}`); }
  }

  console.log(`cairnx-replica check, ${live ? "live" : "offline, against the committed reference"}:`);
  const anchors = JSON.parse(readFileSync(join(work, "node_modules", "@inversealtruism", "csd-anchors", "anchors.json"), "utf8"));
  const root = `${anchors.activationRoot.height}:${anchors.activationRoot.hash}`;
  type Ref = { height: number; blockHash: string; eventsHash: string; stateHash: string };
  const ref = JSON.parse(readFileSync(REFERENCE, "utf8")) as Record<string, Ref>;
  const expect = (t: Ref | undefined) => ["--expect", `${t!.height}:${t!.blockHash}:${t!.eventsHash}:${t!.stateHash}`];
  const legs: [string, string[]][] = live ? [
    ...(arg("--indexer") ? [["feed", ["--feed", arg("--indexer")!]] as [string, string[]]] : []),
    ...(arg("--origin") ? [["hosted, above the pin", ["--hosted", arg("--origin")!, "--pin"]] as [string, string[]]] : []),
    ...(arg("--origin") && flag("--full") ? [["hosted, from the activation root", ["--hosted", arg("--origin")!, "--anchor", root]] as [string, string[]]] : []),
    ...(arg("--node") ? [["own node, above the pin", ["--node", arg("--node")!, "--pin"]] as [string, string[]]] : []),
    ...(arg("--node") && flag("--full") ? [["own node, from the activation height", ["--node", arg("--node")!]] as [string, string[]]] : []),
  ].map(([l, a]) => [l, [...a, "--reference", arg("--reference")!, ...(arg("--timeout-ms") ? ["--timeout-ms", arg("--timeout-ms")!] : [])]] as [string, string[]]) : [
    ["feed: a csd-indexer over cairnx-core's recorded blocks to 117,000", ["--feed", src.indexer, ...expect(ref.feed)]],
    ["own node: the recorded node to 30,300", ["--node", src.node, ...expect(ref.blocks)]],
    ["own node above the shipped pin: the recorded node to 143,356", ["--node", src.nodePin, "--pin", ...expect(ref.pin)]],
    ["hosted blocks from csd-anchors' activation root: the recorded front door to 30,300", ["--hosted", src.front, "--anchor", root, ...expect(ref.blocks)]],
    ["hosted blocks above the shipped pin: the recorded front door to 143,356", ["--hosted", src.frontPin, "--pin", ...expect(ref.pin)]],
  ];
  if (live && legs.length === 0) throw new Error("--live names no leg: give --indexer, --origin or --node");
  for (const [label, args] of legs) {
    const r = await child(bin, ["check", ...args, "--json"], work, live);
    let report: { result?: string; level?: number; proof?: string; tuple?: Ref | null; why?: string[]; compare?: unknown } = {};
    try { report = JSON.parse(r.out.trim().split("\n").at(-1) ?? ""); } catch { report = {}; }
    console.log(`  ${label}: level ${report.level}, proof ${report.proof}, tuple ${JSON.stringify(report.tuple)}${live ? `, compare ${JSON.stringify(report.compare)}` : ""}`);
    ok(`${label}: result equal, exit 0`, r.code === 0 && report.result === "equal", `exit ${r.code} ${r.out}${r.err}`.slice(0, 3_000));
  }
} finally {
  for (const s of servers) s.close();
  if (flag("--keep")) console.log(`kept ${work}`); else rmSync(work, { recursive: true, force: true });
}
done("exit check");
