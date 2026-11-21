// The generator (scripts/generate-anchors.mjs) offline, against stub sources served from the replica's recorded blocks
// 29,815 to 30,300 (real headers, so the light client's checks run on real work): a headers source and a second RPC
// that are two stub hosts, and a table on a 64-block grid so the range holds several entries (the grid is a
// parameter, the shipped 4,096 is pinned by anchors.test.ts). The honest runs come first, then each refusal alone.
// No request leaves the process: the global fetch is replaced by one that fails the test.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headerHash } from "@inversealtruism/csd-codec";
import { done, ok } from "../../replica/test/check.js";
import { gen, tableMod, type Io, type Table } from "./scripts.js";

globalThis.fetch = (() => { throw new Error("a test reached the network"); }) as typeof fetch;
const here = (p: string) => new URL(p, import.meta.url);
type Block = { height: number; hash: string; header: { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number } };
const answers = ["29815-29859", "29860-30300"].reduce((all, r) =>
  ({ ...all, ...(JSON.parse(readFileSync(here(`../../replica/test/fixtures/node-blocks-${r}.json`), "utf8")) as { answers: Record<string, string> }).answers }), {} as Record<string, string>);
const block = (h: number): Block | null => { const a = answers[`/block/height/${h}`]; return a === undefined ? null : JSON.parse(a) as Block; };
const hashAt = (h: number) => block(h)!.hash;
type Row = { height: number; hash: string; header: Block["header"] };
const rowAt = (h: number): Row => ({ height: h, hash: hashAt(h), header: block(h)!.header });

const HEADERS = "https://headers.example", RPC = "https://rpc.example";
type Served = { rows?: (from: number, rows: Row[]) => Row[]; rpcHash?: (h: number) => string; rpcHeight?: (h: number) => number | undefined; rpcOk?: (h: number) => boolean; tip?: number | null; status?: (path: string) => number | undefined };
function stub(o: Served = {}) {
  const log: { url: string; redirect: RequestRedirect | undefined }[] = [];
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const f: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    log.push({ url: String(input), redirect: init?.redirect });
    const forced = o.status?.(u.pathname);
    if (forced !== undefined) return json({ ok: false }, forced);
    const page = /^\/api\/headers\/(\d+)\/(\d+)$/.exec(u.pathname);
    if (u.origin === HEADERS && page) {
      const from = Number(page[1]), n = Number(page[2]);
      const rows = Array.from({ length: n }, (_, i) => block(from + i) === null ? null : rowAt(from + i));
      return rows.includes(null) ? json({ ok: false }, 404) : json({ ok: true, headers: (o.rows ?? ((_, r) => r))(from, rows as Row[]) });
    }
    const at = /^\/block\/height\/(\d+)$/.exec(u.pathname);
    if (u.origin === RPC && at && block(Number(at[1])) !== null) return json({ ok: (o.rpcOk ?? (() => true))(Number(at[1])), height: (o.rpcHeight ?? ((h) => h))(Number(at[1])), hash: (o.rpcHash ?? hashAt)(Number(at[1])) });
    if (u.origin === RPC && u.pathname === "/tip") return json(o.tip === null ? {} : { height: o.tip ?? 31_500 });
    return json({ ok: false }, 404);
  };
  const io: Io = { fetch: f, sleep: () => Promise.resolve() };
  return { log, io };
}

const dir = mkdtempSync(join(tmpdir(), "anchors-generate-"));
let seq = 0;
const put = (name: string, body: string) => { const p = join(dir, `${seq++}-${name}`); writeFileSync(p, body); return p; };
const committed = tableMod.parseTable(readFileSync(here("../anchors.json"), "utf8"));
const CH = 64, TOPS = [30_015, 30_079, 30_143, 30_207, 30_271];
const tableOf = (n: number): Table => ({ format: 1, chunk: CH, floor: committed.floor, activationRoot: committed.activationRoot, anchors: TOPS.slice(0, n).map((height) => ({ height, hash: hashAt(height) })) });
const putTable = (t: Table) => put("table.json", tableMod.renderJson(t));
const sources = (miner = "yes") => [{ role: "node", answer: "yes" }, { role: "miner", answer: miner }, { role: "third", answer: "yes", routing: "primary" }];
const c1 = (o: Record<string, unknown> = {}) => JSON.stringify({ v: 1, height: 30_143, hash: hashAt(30_143), tip: 31_500, margin: 1_357, sources: sources(), ...o });
type Res<T> = { r: T | null; e: string };
const settle = <T>(p: Promise<T>): Promise<Res<T>> => p.then((r) => ({ r, e: "" }), (e: unknown) => ({ r: null, e: e instanceof Error ? e.message : String(e) }));
const refusedWith = (x: Res<unknown>, re: RegExp) => { const good = x.r === null && re.test(x.e); if (!good) console.log(`       got: ${x.r === null ? x.e : "no refusal"}`); return good; };
const walk = { base: HEADERS, chunk: CH, pageSize: 5, paceMs: 0 };
const run = (o: { c1Text?: string; table?: Table; tablePath?: string; served?: Served; write?: boolean; chunk?: number } = {}) => {
  const s = stub(o.served);
  const tablePath = o.tablePath ?? putTable(o.table ?? tableOf(2));
  return settle(gen.generate({ ...walk, ...(o.chunk === undefined ? {} : { chunk: o.chunk }), c1Text: o.c1Text ?? c1(), tablePath, write: o.write ?? false, io: s.io })).then((x) => ({ ...x, s, tablePath }));
};
const checkRun = (o: { table?: Table; served?: Served; headers?: string } = {}) => {
  const s = stub(o.served);
  return settle(gen.check({ headers: o.headers ?? HEADERS, rpc: RPC, tablePath: putTable(o.table ?? tableOf(5)), chunk: CH, pageSize: 5, paceMs: 0, io: s.io })).then((x) => ({ ...x, s }));
};
const swapRow = (h: number, make: (r: Row) => Row): Served["rows"] => (from, rows) => rows.map((r, i) => (from + i === h ? make(r) : r));

console.log("the honest run:");
const honest = await run();
ok("the table with the next entry (30,143) on the 64 grid, the old entries and the floor carried, as the canonical text",
  honest.r !== null && JSON.stringify(honest.r.table) === JSON.stringify(tableOf(3)) && honest.r.text === tableMod.renderJson(tableOf(3)) && honest.r.entries === 3 && honest.r.newest === 30_143, honest.e);
ok("without --write the committed file is left as it was", readFileSync(honest.tablePath, "utf8") === tableMod.renderJson(tableOf(2)));
const urls = honest.s.log.map((l) => l.url);
ok(`every request went to the one headers source, as a page-aligned /api/headers range with redirects refused (${urls.length} requests, the first ${urls[0]?.slice(HEADERS.length)})`,
  urls.length > 40 && urls.every((u) => u.startsWith(`${HEADERS}/api/headers/`) && Number(u.split("/")[5]) % 5 === 0) && honest.s.log.every((l) => l.redirect === "error") && urls[0] === `${HEADERS}/api/headers/29915/5`);
const written = await run({ write: true });
ok("with write the file holds that text, and parses on the grid with the old entries as its prefix",
  written.r !== null && readFileSync(written.tablePath, "utf8") === tableMod.renderJson(tableOf(3)) && tableMod.extensionFault(tableOf(2), tableMod.parseTable(readFileSync(written.tablePath, "utf8"), CH)) === null, written.e);
const several = await run({ table: tableOf(1), c1Text: c1({ height: 30_271, hash: hashAt(30_271) }) });
ok("a target several entries above the committed table adds each of them (30,079 to 30,271)", several.r !== null && JSON.stringify(several.r.table) === JSON.stringify(tableOf(5)), several.e);

console.log("--check, honest:");
const checked = await checkRun();
ok("the committed 5-entry table passes: the walk reaches each entry, the second RPC holds the floor, the root and each entry, the newest is 1,229 below its tip",
  checked.r !== null && checked.r.entries === 5 && checked.r.newest === 30_271 && checked.r.tip === 31_500, checked.e);
ok("the newest entry exactly 1,000 below the tip passes", (await checkRun({ served: { tip: 31_271 } })).r !== null);
ok("a tip far above the newest entry (the age of a table is a release rule, not this check's) passes", (await checkRun({ served: { tip: 90_000 } })).r !== null);
const rpcUrls = checked.s.log.map((l) => l.url).filter((u) => u.startsWith(RPC));
ok(`the second RPC was asked for the floor, the root and the 5 entries, then the tip (${rpcUrls.length} requests)`, rpcUrls.length === 8 && rpcUrls.at(-1) === `${RPC}/tip` && rpcUrls[0] === `${RPC}/block/height/29960` && rpcUrls[1] === `${RPC}/block/height/29859`);

console.log("each C1 input rule refused alone, before any read:");
const c1Cases: [string, string, RegExp][] = [
  ["not JSON", "", /empty or not JSON/],
  ["v 2", c1({ v: 2 }), /v must be 1/],
  ["two sources", c1({ sources: sources().slice(0, 2) }), /exactly three sources/],
  ["a source repeated for another's role", c1({ sources: [sources()[0], sources()[0], sources()[2]] }), /exactly three sources/],
  ["the miner answering no", c1({ sources: sources("no") }), /every source must answer yes/],
  ["the miner unreachable", c1({ sources: sources("unreachable") }), /every source must answer yes/],
  ["the third source not on its primary", c1({ sources: [...sources().slice(0, 2), { role: "third", answer: "yes", routing: "fallback" }] }), /primary backend/],
  ["a margin of 999", c1({ margin: 999 }), /margin must be at least 1000/],
  ["a height 757 below the tip", c1({ tip: 30_900 }), /at least 1000 below tip/],
  ["a hash in upper case", c1({ hash: `0x${hashAt(30_143).slice(2).toUpperCase()}` }), /lowercase hex/],
  ["a height that is not a chunk top (30,100)", c1({ height: 30_100, hash: hashAt(30_100) }), /chunk top/],
  ["a chunk top below the floor's first one (29,951)", c1({ height: 29_951, hash: hashAt(29_951) }), /at or above the first chunk top/],
];
for (const [name, text, re] of c1Cases) {
  const x = await run({ c1Text: text });
  ok(`${name}: refused, nothing requested`, refusedWith(x, re) && x.s.log.length === 0, x.e);
}

console.log("each refusal of the walk and of the table alone:");
const tamper = (h: number, make: (r: Row) => Row) => ({ rows: swapRow(h, make) });
const asPrev = (r: Row): Row => ({ ...rowAt(r.height - 1), height: r.height });
ok("a header chain with a bad link (the row at 30,040 is the header of 30,039)", refusedWith(await run({ served: tamper(30_040, asPrev) }), /broken prev link at 30040/));
const regrind = (r: Row): Row => { const header = { ...r.header, nonce: r.header.nonce + 1 }; return { ...r, header, hash: headerHash(header) }; };
ok("a header chain with bad work (the nonce of 30,040 moved, its hash recomputed)", refusedWith(await run({ served: tamper(30_040, regrind) }), /invalid PoW at 30040/));
ok("a header whose bits are not the LWMA's (30,040)", refusedWith(await run({ served: tamper(30_040, (r) => { const header = { ...r.header, bits: r.header.bits - 1 }; return { ...r, header, hash: headerHash(header) }; }) }), /bad bits at 30040/));
ok("a row whose served hash is not its header's", refusedWith(await run({ served: tamper(30_040, (r) => ({ ...r, hash: hashAt(30_041) })) }), /header hash mismatch at 30040/));
ok("a page with a row too few", refusedWith(await run({ served: { rows: (from, rows) => (from === 30_040 ? rows.slice(1) : rows) } }), /4 rows, want 5/));
ok("a page whose rows are at other heights", refusedWith(await run({ served: { rows: (from, rows) => (from === 30_040 ? rows.slice().reverse() : rows) } }), /row 0 is not height 30040/));
ok("a headers source that does not serve a page (404)", refusedWith(await run({ served: { status: (p) => (p === "/api/headers/30040/5" ? 404 : undefined) } }), /api\/headers\/30040\/5 -> 404/));
ok("a target above what the source holds", refusedWith(await run({ c1Text: c1({ height: 30_335, hash: hashAt(30_271), tip: 32_000, margin: 1_665 }) }), /-> 404/));
ok("a walk that reaches another hash than the corroborated one (30,207's for 30,143)", refusedWith(await run({ c1Text: c1({ hash: hashAt(30_207) }) }), /reaches 0x[0-9a-f]{64} at 30143, not the corroborated/));
const drifted = tableOf(2); drifted.anchors[1] = { height: 30_079, hash: hashAt(30_143) };
ok("a table that does not extend the committed one (entry 1 of it is another block)", refusedWith(await run({ table: drifted }), /does not extend the committed one \(first difference at entry 1\); nothing written/));
ok("a target below the committed newest entry (the new table would lose one)", refusedWith(await run({ c1Text: c1({ height: 30_015, hash: hashAt(30_015) }) }), /does not extend the committed one \(first difference at entry 1\)/));
const otherFloor = { ...tableOf(2), floor: { height: 29_960, hash: hashAt(29_961) } };
ok("a committed floor the served headers do not hold: the walk is anchored at it, not at what is served", refusedWith(await run({ table: otherFloor }), /checkpoint mismatch at 29960/));
const handEdited = (await (async () => { const p = putTable(tableOf(2)); writeFileSync(p, readFileSync(p, "utf8").replace('"format": 1', '"format":  1')); return p; })());
ok("a committed file that is not the canonical text of its data", refusedWith(await run({ tablePath: handEdited }), /canonical text/));
ok("a committed table on another grid than the generator's", refusedWith(await run({ chunk: 4096 }), /chunk must be 4096/));
ok("a refused run leaves the committed file as it was",
  (await (async () => { const x = await run({ write: true, c1Text: c1({ hash: hashAt(30_207) }) }); return x.r === null && readFileSync(x.tablePath, "utf8") === tableMod.renderJson(tableOf(2)); })()));

console.log("each refusal of --check alone:");
const walked = tableOf(5); walked.anchors[2] = { height: 30_143, hash: hashAt(30_144) };
ok("an entry the walk does not reach (the committed hash of 30,143 is 30,144's)", refusedWith(await checkRun({ table: walked }), /entry 2 \(height 30143\) is 0x[0-9a-f]{64}, the walk from https:\/\/headers\.example reaches/));
ok("a second RPC that disagrees about an entry (30,079)", refusedWith(await checkRun({ served: { rpcHash: (h) => (h === 30_079 ? hashAt(30_080) : hashAt(h)) } }), /answers "no" for entry 1 at height 30079/));
ok("a second RPC that disagrees about the floor", refusedWith(await checkRun({ served: { rpcHash: (h) => (h === 29_960 ? hashAt(29_961) : hashAt(h)) } }), /answers "no" for the floor at height 29960/));
ok("a second RPC that disagrees about the activation root: the root is checked though the walk starts above it", refusedWith(await checkRun({ served: { rpcHash: (h) => (h === 29_859 ? hashAt(29_860) : hashAt(h)) } }), /answers "no" for the activation root at height 29859/));
ok("a second RPC that does not answer for an entry", refusedWith(await checkRun({ served: { status: (p) => (p === "/block/height/30143" ? 404 : undefined) } }), /answers "unreachable" for entry 2 at height 30143/));
ok("a second RPC that answers for another height than the one asked", refusedWith(await checkRun({ served: { rpcHeight: (h) => (h === 30_143 ? 30_144 : h) } }), /answers "no" for entry 2 at height 30143/));
ok("a second RPC whose answer has no height field", refusedWith(await checkRun({ served: { rpcHeight: (h) => (h === 30_143 ? undefined : h) } }), /answers "no" for entry 2 at height 30143/));
ok("a second RPC whose answer carries the right hash but says ok false", refusedWith(await checkRun({ served: { rpcOk: (h) => h !== 30_143 } }), /answers "unreachable" for entry 2 at height 30143/));
ok("a second RPC whose answer is a 200 with no hash", refusedWith(await checkRun({ served: { status: (p) => (p === "/block/height/30143" ? 200 : undefined) } }), /answers "unreachable" for entry 2 at height 30143/));
ok("a newest entry 999 below the second RPC's tip", refusedWith(await checkRun({ served: { tip: 31_270 } }), /less than 1000 below the tip 31270/));
ok("a second RPC that gives no tip", refusedWith(await checkRun({ served: { tip: null } }), /gave no tip height/));
const badLink = await checkRun({ served: tamper(30_040, asPrev) });
ok("a headers source with a bad link", refusedWith(badLink, /broken prev link at 30040/));

console.log("the command line:");
const out: string[] = [], errs: string[] = [];
const sink = { log: (s: string) => out.push(s), err: (s: string) => errs.push(s) };
const cmd = async (argv: string[], env: Record<string, string | undefined>, tablePath: string, served?: Served) => {
  out.length = 0; errs.length = 0;
  const s = stub(served);
  const code = await gen.main(argv, env, { tablePath, chunk: CH, pageSize: 5, paceMs: 0, io: s.io, ...sink });
  return { code, requests: s.log.length };
};
const c1File = put("c1.json", c1());
const t2 = putTable(tableOf(2));
const g1 = await cmd([c1File, "--headers", `${HEADERS}/`, "--write"], {}, t2);
ok("generate <anchor.json> --headers <base> --write: exit 0, the table written, the base's trailing slash dropped",
  g1.code === 0 && readFileSync(t2, "utf8") === tableMod.renderJson(tableOf(3)) && /^wrote .*: 3 entries, newest 30143; run pnpm build/.test(out[0] ?? ""), `${out} ${errs}`);
const t2b = putTable(tableOf(2));
const g2 = await cmd([c1File], { ANCHORS_HEADERS_BASE: HEADERS }, t2b);
ok("the headers base from ANCHORS_HEADERS_BASE: exit 0, and without --write the file is left as it was",
  g2.code === 0 && readFileSync(t2b, "utf8") === tableMod.renderJson(tableOf(2)) && /^would write \(run with --write\)/.test(out[0] ?? ""), `${out} ${errs}`);
const g3 = await cmd(["--check", "--headers", HEADERS, "--rpc", RPC], {}, putTable(tableOf(5)));
ok("--check --headers <base> --rpc <base>: exit 0 and the counts", g3.code === 0 && /anchors check passed: 5 entries, newest 30271, tip 31500/.test(out[0] ?? ""), `${out} ${errs}`);
const usage: [string, string[], Record<string, string | undefined>, RegExp][] = [
  ["an unknown option", [c1File, "--headers", HEADERS, "--chek"], {}, /unknown or incomplete option --chek/],
  ["no headers source and no ANCHORS_HEADERS_BASE", [c1File], {}, /no headers source named/],
  ["a headers source that is not an http(s) URL", [c1File, "--headers", "/var/headers"], {}, /no headers source named/],
  ["an empty ANCHORS_HEADERS_BASE", [c1File], { ANCHORS_HEADERS_BASE: "" }, /no headers source named/],
  ["--check without --rpc", ["--check", "--headers", HEADERS], {}, /no rpc source named/],
  ["--check with the headers base only in the environment", ["--check", "--rpc", RPC], { ANCHORS_HEADERS_BASE: HEADERS }, /no headers source named/],
  ["--check with an anchor file", ["--check", c1File, "--headers", HEADERS, "--rpc", RPC], {}, /--check takes only/],
  ["generate with --rpc", [c1File, "--headers", HEADERS, "--rpc", RPC], {}, /generate takes one/],
  ["generate without an anchor file", ["--headers", HEADERS], {}, /generate takes one/],
];
for (const [name, argv, env, re] of usage) {
  const r = await cmd(argv, env, putTable(tableOf(2)));
  ok(`${name}: exit 2, nothing requested`, r.code === 2 && r.requests === 0 && re.test(errs[0] ?? "") && /nothing read or written/.test(errs[0] ?? ""), errs.join());
}
const refused = await cmd([put("c1-bad.json", c1({ v: 2 })), "--headers", HEADERS, "--write"], {}, putTable(tableOf(2)));
ok("a refused input: exit 1 naming the rule, nothing requested", refused.code === 1 && refused.requests === 0 && /FAIL: anchor JSON refused: v must be 1/.test(errs[0] ?? ""), errs.join());
const script = new URL("../scripts/generate-anchors.mjs", import.meta.url).pathname;
const spawned = (argv: string[]) => { const env = { ...process.env }; delete env.ANCHORS_HEADERS_BASE; return spawnSync(process.execPath, [script, ...argv], { encoding: "utf8", env }); };
const s1 = spawned(["--chek"]), s2 = spawned([c1File]);
ok("the script run as a file: a mistyped option and a missing headers source each exit 2 before any read", s1.status === 2 && /unknown or incomplete option --chek/.test(s1.stderr) && s2.status === 2 && /there is no default host/.test(s2.stderr), `${s1.stderr}${s2.stderr}`);

console.log("run through a symlinked path:");
// A source that answers 404 to everything, on a loopback port the OS picks. The script runs as a child, so the server
// answers while the test awaits it.
const server = createServer((_, res) => { res.statusCode = 404; res.end("{}"); });
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
symlinkSync(new URL("..", import.meta.url).pathname.replace(/\/$/, ""), join(dir, "pkg"));
const viaLink = await new Promise<{ status: number | null; stdout: string; stderr: string }>((done2) => {
  const child = spawn(process.execPath, [join(dir, "pkg/scripts/generate-anchors.mjs"), "--check", "--headers", base, "--rpc", base]);
  let stdout = "", stderr = "";
  child.stdout.on("data", (d: Buffer) => { stdout += d; });
  child.stderr.on("data", (d: Buffer) => { stderr += d; });
  child.on("close", (status) => done2({ status, stdout, stderr }));
});
server.close();
ok("--check through a symlinked package directory against a source that refuses: exit 1 with the refusal printed, not a silent exit 0",
  viaLink.status === 1 && viaLink.stdout === "" && /FAIL: http:\/\/127\.0\.0\.1:\d+\/api\/headers\/\d+\/512 -> 404/.test(viaLink.stderr), `exit ${viaLink.status}: ${viaLink.stdout}${viaLink.stderr}`);

rmSync(dir, { recursive: true, force: true });
done("csd-anchors generator");
