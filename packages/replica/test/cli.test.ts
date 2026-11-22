// The command `cairnx-replica check` (src/cli.ts) over the recorded captures: each source the command names reaches the
// tuple at the newest final boundary, equal to the one cairnx-core's corpus gives there; a reference or an expected
// tuple that differs exits 1 with its kind, one that cannot be compared 3; usage errors exit 2; a sticky refusal ends
// the run at once; every string from a source reaches the terminal escaped and cut; only named hosts are asked.
import { readFileSync } from "node:fs";
import { applyOrder, eventsHash, resolve, stateHash, type ChainEvent } from "@inversealtruism/cairnx-core";
import { derivePin } from "../src/server.js";
import { runCheck } from "../src/cli.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { all, ANCHOR, front, ORIGIN } from "./hosted-harness.js";
import { captureIndexer } from "./indexer-capture.js";
import { blockAt, cap, NODE, node } from "./node-harness.js";
import { hashAt } from "./reader-harness.js";

const truth = (height: number, blockHash: string) => {
  const ev = corpus.events.filter((e: ChainEvent) => e.height <= height).sort(applyOrder);
  return { height, blockHash, eventsHash: eventsHash(ev), stateHash: stateHash(resolve(ev, height)) };
};
const str = (t: { height: number; blockHash: string; eventsHash: string; stateHash: string }) => `${t.height}:${t.blockHash}:${t.eventsHash}:${t.stateHash}`;
const T30 = truth(30_270, blockAt(cap.answers, 30_270).hash);
const REF = "https://reference.example/trade/api";
/** One fetch for a source and a reference: the reference's host answers `answer` for every tuple read. */
const withRef = (f: typeof fetch, answer: (path: string) => { status: number; body: unknown }): typeof fetch => async (input, init) => {
  const u = new URL(String(input));
  if (u.origin !== new URL(REF).origin) return f(input, init);
  const a = answer(u.pathname);
  return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
};
const run = async (args: string[], f: typeof globalThis.fetch, extra: { loadPin?: () => Promise<unknown>; sleep?: (ms: number) => Promise<void> } = {}) => {
  const lines: string[] = [], err: string[] = [];
  const code = await runCheck(["check", ...args], { out: (l) => lines.push(l), err: (l) => err.push(l), fetch: f, ...extra });
  const last = lines.at(-1) ?? "";
  let report: { tuple: unknown; result: string; level: number; proof: string; lastError: { code: string } | null } | null = null;
  try { report = JSON.parse(last); } catch { report = null; }
  return { code, lines, err, report };
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("each source reaches the corpus's tuple at its newest final boundary:");
{
  const r = await run(["--node", NODE, "--expect", str(T30), "--json"], node({ answers: cap.answers }).f);
  ok("--node: level 3, proof inclusion, the tuple at 30,270 equal to the corpus's, exit 0",
    r.code === 0 && r.report?.result === "equal" && r.report.level === 3 && r.report.proof === "inclusion" && same(r.report.tuple, T30), r.lines.join("\n"));
  const h = await run(["--hosted", ORIGIN, "--anchor", `${ANCHOR.height}:${ANCHOR.hash}`, "--expect", str(T30), "--json"], front({ answers: all }).f);
  ok("--hosted with --anchor at the activation root: the same tuple, exit 0", h.code === 0 && h.report?.result === "equal" && same(h.report.tuple, T30), h.lines.join("\n"));
  const upTo = (to: number): BlockFixture => ({ ...fx, to, toHash: hashAt(to), blocks: fx.blocks.filter((b) => b.height <= to) });
  const d = await derivePin(upTo(30_000)), loadPin = async () => ({ PIN: { ...d.pin, log: async () => d.log } });
  const np = await run(["--node", NODE, "--pin", "--expect", str(T30), "--json"], node({ answers: cap.answers }).f, { loadPin });
  ok("--node --pin (a pin at 30,000): level 3, proof pinned, the same tuple, exit 0",
    np.code === 0 && np.report?.result === "equal" && np.report.proof === "pinned" && same(np.report.tuple, T30), np.lines.join("\n"));
  const hp = await run(["--hosted", ORIGIN, "--pin", "--expect", str(T30), "--json"], front({ answers: all }).f, { loadPin });
  ok("--hosted --pin: the headers from the pin, the same tuple, exit 0", hp.code === 0 && hp.report?.result === "equal" && same(hp.report.tuple, T30), hp.lines.join("\n"));
  const idx = captureIndexer(fx);
  const stand = String(await (await idx("http://idx/block-height/116970")).json());
  const T117 = truth(116_970, stand);
  const f = await run(["--feed", "http://idx", "--expect", str(T117), "--json"], idx);
  ok("--feed over the recorded indexer to 117,000: level 1, the tuple at 116,970 equal to the corpus's, exit 0",
    f.code === 0 && f.report?.result === "equal" && f.report.level === 1 && same(f.report.tuple, T117), f.lines.join("\n"));
  // The exit check's reference (scripts/exit-check.ts) is these tuples, and the shipped pin's own at 143,340.
  const ref = JSON.parse(readFileSync(new URL("../scripts/exit-reference.json", import.meta.url), "utf8"));
  const pin = JSON.parse(readFileSync(new URL("../../pin/pin.json", import.meta.url), "utf8"));
  ok("scripts/exit-reference.json holds the corpus's tuples at 116,970 and 30,270 and the shipped pin's",
    same(ref, { feed: T117, blocks: T30, pin: { height: pin.height, blockHash: pin.blockHash, eventsHash: pin.eventsHash, stateHash: pin.stateHash } }), JSON.stringify(ref));
  const held = await run(["--node", NODE], node({ answers: cap.answers }).f);
  ok("with no reference: the tuple printed, result held, exit 0",
    held.code === 0 && held.lines.includes(`tuple 30270 block ${T30.blockHash} events ${T30.eventsHash} state ${T30.stateHash}`) && held.lines.at(-1) === "result: held, exit 0", held.lines.join("\n"));
}

console.log("an expected tuple or a reference that differs exits 1 with its kind:");
{
  const other = "0x" + "ab".repeat(32);
  const cases: [string, typeof T30, string][] = [
    ["another state hash", { ...T30, stateHash: other }, "rules"],
    ["another events hash", { ...T30, eventsHash: other }, "records"],
    ["another block hash", { ...T30, blockHash: other }, "branch"],
    ["another boundary", { ...T30, height: 30_240 }, "missing"],
  ];
  for (const [what, want, kind] of cases) {
    const r = await run(["--node", NODE, "--expect", str(want), "--json"], node({ answers: cap.answers }).f);
    const code = kind === "missing" ? 3 : 1;
    ok(`--expect with ${what}: result ${kind}, exit ${code}`, r.code === code && r.report?.result === kind && same(r.report.tuple, T30), r.lines.join("\n"));
  }
  const tupleBody = (t: typeof T30) => ({ ok: true, height: t.height, blockHash: t.blockHash, eventsHash: t.eventsHash, stateHash: t.stateHash });
  const eq = await run(["--node", NODE, "--reference", REF, "--json"], withRef(node({ answers: cap.answers }).f, () => ({ status: 200, body: tupleBody(T30) })));
  ok("--reference answering the same tuple: result equal, exit 0", eq.code === 0 && eq.report?.result === "equal", eq.lines.join("\n"));
  const ne = await run(["--node", NODE, "--reference", REF, "--json"], withRef(node({ answers: cap.answers }).f, () => ({ status: 200, body: tupleBody({ ...T30, stateHash: other }) })));
  ok("--reference answering another state hash: result rules, exit 1", ne.code === 1 && ne.report?.result === "rules", ne.lines.join("\n"));
  const gone = await run(["--node", NODE, "--reference", REF, "--json"], withRef(node({ answers: cap.answers }).f, (p) => ({ status: 404, body: { ok: false, error: "not a kept boundary", height: Number(p.split("/").at(-1)!.split(":")[0]) } })));
  ok("--reference that keeps no such boundary: result missing, exit 3", gone.code === 3 && gone.report?.result === "missing", gone.lines.join("\n"));
}

console.log("usage and configuration errors exit 2; a sticky refusal ends the run:");
{
  const f = node({ answers: cap.answers }).f;
  for (const [args, why] of [
    [[], "name one source"], [["--node", NODE, "--feed", "http://idx"], "name one source"], [["--feed", "http://idx", "--pin"], "a feed takes no pin"],
    [["--hosted", ORIGIN], "--hosted takes --anchor or --pin"], [["--node", NODE, "--expect", "30270:0x1"], "--expect is"],
    [["--node", NODE, "--reference", REF, "--expect", str(T30)], "not both"], [["--node", "https://node.example"], "one's own"],
  ] as [string[], string][]) {
    const r = await run(args, f);
    ok(`check ${args.join(" ") || "(no source)"}: exit 2 naming "${why}"`, r.code === 2 && r.lines.some((l) => l.includes(why)), r.lines.join("\n"));
  }
  const notCheck = await runCheck(["verify", "--node", NODE], { out: () => undefined, fetch: f });
  ok("a command other than check: exit 2", notCheck === 2);
  const upTo = (to: number): BlockFixture => ({ ...fx, to, toHash: hashAt(to), blocks: fx.blocks.filter((b) => b.height <= to) });
  const d = await derivePin(upTo(30_000));
  let slept = 0;
  const t0 = Date.now();
  // The bound only keeps a run that does not stop short: the honest one ends at its first advance.
  const bad = await run(["--node", NODE, "--pin", "--json", "--timeout-ms", "5000"], f, { loadPin: async () => ({ PIN: { ...d.pin, log: async () => d.log, eventsHash: "0x" + "cd".repeat(32) } }), sleep: async () => { slept++; } });
  ok("a pin whose events hash is not its log's: PIN_MISMATCH ends the run at once, no tuple, exit 3",
    bad.code === 3 && bad.report?.result === "no-tuple" && bad.report.lastError?.code === "PIN_MISMATCH" && slept === 0 && Date.now() - t0 < 5_000, bad.lines.join("\n"));
}

console.log("a run that cannot finish says so while it waits and at its deadline:");
{
  // A node that takes every request and never answers, as a stalled connection does: only the request's abort ends it.
  const silent: typeof fetch = (_input, init) => new Promise((_, no) => init?.signal?.addEventListener("abort", () => no(init.signal!.reason), { once: true }));
  let t0 = Date.now();
  const s = await run(["--node", NODE, "--json", "--timeout-ms", "3000"], silent);
  ok("a source that never answers: the run ends at its deadline, exit 3, result timeout, the message naming the first step it waited for",
    s.code === 3 && s.report?.result === "timeout" && Date.now() - t0 < 8_000 && s.err.some((l) => /^deadline: 3000 ms passed waiting for the source's first step/.test(l)), [...s.err, ...s.lines].join("\n"));
  const busy: typeof fetch = async () => new Response('{"ok":false,"error":"unavailable"}', { status: 503, headers: { "content-type": "application/json" } });
  t0 = Date.now();
  const e = await run(["--node", NODE, "--json", "--timeout-ms", "3000"], busy, { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 200))) });
  ok("a source that answers an error forever: each error printed as it comes, then the deadline naming it, exit 3",
    e.code === 3 && e.report?.result === "timeout" && Date.now() - t0 < 8_000 && e.err.some((l) => /^source error SOURCE_UNAVAILABLE: /.test(l))
      && e.err.some((l) => /^deadline: 3000 ms passed waiting for the source's first step \(last error SOURCE_UNAVAILABLE: /.test(l)), [...e.err, ...e.lines].join("\n"));
  // A front door that refuses a page with a 429 part way, twice, as ours does past its rate limit: the step that keeps
  // the blocks before it settles with the cursor at the window's verified tip, which is not the server's, and the next
  // step meets the 429 again.
  let refused = 0;
  const limited = front({ answers: all, fail: (path) => {
    if (refused >= 2 || !/^\/api\/blocks\/30080\//.test(path)) return null;
    refused++;
    return new Response("{}", { status: 429, headers: { "retry-after": "1" } });
  } }).f;
  const rl = await run(["--hosted", ORIGIN, "--anchor", `${ANCHOR.height}:${ANCHOR.hash}`, "--expect", str(T30), "--json", "--timeout-ms", "60000"], limited);
  ok("a 429 part way through hosted blocks: the run waits and reads on to the server's tip, the tuple at 30,270 equal, exit 0",
    refused === 2 && rl.code === 0 && rl.report?.result === "equal" && rl.err.some((l) => /^source error SOURCE_RATE_LIMITED: /.test(l)), [...rl.err, ...rl.lines].join("\n"));
  const h = await run(["--node", NODE, "--json"], node({ answers: cap.answers }).f);
  ok("the honest run prints its progress, the cursor against the tip with the level and the codes, and no deadline line",
    h.code === 0 && h.err.some((l) => /^syncing: cursor 30300 of tip 30300, level 3, proof inclusion, why /.test(l)) && !h.err.some((l) => /^deadline/.test(l)), h.err.join("\n"));
}

console.log("frozen with 0.1.0: the arguments, the hosts asked, the text shown, the deadline:");
{
  const f = node({ answers: cap.answers }).f, H = `0x${"ab".repeat(32)}`;
  for (const [args, why] of [
    [["--node", NODE, "--node", NODE], "--node is given twice"], [["--node", NODE, "--pin", "--pin"], "--pin is given twice"],
    [["--node", NODE, "--timeout-ms", "100", "--timeout-ms", "200"], "--timeout-ms is given twice"],
    [["--node", NODE, "--expect", `-1:${H}:${H}:${H}`], "--expect is"], [["--node", NODE, "--expect", `:${H}:${H}:${H}`], "--expect is"],
    [["--node", NODE, "--expect", `01:${H}:${H}:${H}`], "--expect is"], [["--node", NODE, "--expect", `1e3:${H}:${H}:${H}`], "--expect is"],
    [["--hosted", ORIGIN, "--anchor", `:${H}`], "--anchor is"], [["--hosted", ORIGIN, "--anchor", `-5:${H}`], "--anchor is"],
    [["--hosted", ORIGIN, "--anchor", ` 29859:${H}`], "--anchor is"],
    [["--node", NODE, "--timeout-ms", "0"], "--timeout-ms is a whole number from 1 to 2147483647"],
    [["--node", NODE, "--timeout-ms", "2147483648"], "--timeout-ms is a whole number from 1 to 2147483647"],
    [["--feed", "ftp://idx.example"], "--feed is an http or https URL"], [["--feed", "file:///etc/passwd"], "--feed is an http or https URL"],
    [["--node", NODE, "--reference", "ftp://x"], "--reference is an http or https URL"],
  ] as [string[], string][]) {
    let asked = 0;
    const r = await run(args, async (i, init) => { asked++; return f(i, init); });
    ok(`check ${args.join(" ")}: exit 2 naming "${why}", nothing asked`, r.code === 2 && asked === 0 && r.lines.some((l) => l.includes(why)), r.lines.join("\n"));
  }
  const noPin = await run(["--node", NODE, "--pin"], f, { loadPin: async () => { throw Object.assign(new Error("Cannot find package '@inversealtruism/cairnx-pin' imported from x"), { code: "ERR_MODULE_NOT_FOUND" }); } });
  ok("--pin without @inversealtruism/cairnx-pin installed: exit 2, the line naming the package to install",
    noPin.code === 2 && noPin.lines.some((l) => /install @inversealtruism\/cairnx-pin/.test(l)), noPin.lines.join("\n"));
  const H30 = (await run(["--node", NODE, "--json"], f)).report;
  ok("the honest node leg still passes after the argument rules (exit 0, held)", H30?.result === "held");

  // A source whose bytes carry terminal controls: an answer that is not JSON, and a feed row whose height is text.
  const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
  const poison = "\u001b]0;pwn\u0007\u001b[31mred\u009b\u202ehidden\u2028" + "x".repeat(5_000);
  const notJson: typeof fetch = async () => new Response(poison, { status: 200, headers: { "content-type": "application/json" } });
  const idx = captureIndexer(fx);
  const rowText: typeof fetch = async (i, init) => {
    const r = await idx(i, init);
    if (!String(i).includes("/domain/")) return r;
    const rows = (await r.json()) as Record<string, unknown>[];
    return Response.json(rows.map((x, n) => (n === 0 ? { ...x, height: poison } : x)));
  };
  for (const [what, args, src] of [["a node answering text that is not JSON", ["--node", NODE, "--timeout-ms", "2500"], notJson],
    ["a feed row whose height is text", ["--feed", "http://idx", "--timeout-ms", "2500"], rowText]] as [string, string[], typeof fetch][]) {
    for (const json of [false, true]) {
      const r = await run(json ? [...args, "--json"] : args, src, { sleep: (ms) => new Promise((x) => setTimeout(x, Math.min(ms, 100))) });
      const all = [...r.lines, ...r.err], raw = all.filter((l) => CONTROL.test(l)), long = all.filter((l) => l.length > 2_000);
      const parsed = !json || (() => { try { JSON.parse(r.lines.at(-1) ?? ""); return true; } catch { return false; } })();
      ok(`${what}${json ? ", --json" : ""}: no control or bidi character reaches the terminal, each shown escaped, no line past 2,000 characters${json ? ", the report valid JSON" : ""}`,
        raw.length === 0 && long.length === 0 && parsed && all.some((l) => l.includes("\\u001b")) && r.code === 3, [...raw, ...long].map((l) => l.slice(0, 200)).join("\n") || all.join("\n").slice(0, 600));
    }
  }

  // A feed that redirects: the second host must receive nothing.
  const { createServer } = await import("node:http");
  let second = 0;
  const b = createServer((_q, res) => { second++; res.end("[]"); });
  await new Promise<void>((x) => b.listen(0, "127.0.0.1", x));
  const bPort = (b.address() as { port: number }).port;
  const a = createServer((q, res) => { res.writeHead(302, { location: `http://127.0.0.1:${bPort}${q.url}` }); res.end(); });
  await new Promise<void>((x) => a.listen(0, "127.0.0.1", x));
  const aPort = (a.address() as { port: number }).port;
  const red = await run(["--feed", `http://127.0.0.1:${aPort}`, "--timeout-ms", "2500"], globalThis.fetch, { sleep: (ms) => new Promise((x) => setTimeout(x, Math.min(ms, 100))) });
  a.close(); b.close();
  ok("a feed answering 302 to another host: a failed step, the second host asked nothing, exit 3", second === 0 && red.code === 3, `second host asked ${second} times; exit ${red.code}`);

  // A feed whose every request never settles, even past its abort: the command exits within its grace after the deadline.
  const stuck: typeof fetch = () => new Promise(() => undefined);
  const t0 = Date.now();
  const st = await run(["--feed", "http://idx", "--json", "--timeout-ms", "1000"], stuck);
  const took = Date.now() - t0;
  ok("a feed that never answers: the deadline at 1 s, the command back within its 5 s grace, exit 3, the line saying the source did not stop",
    st.code === 3 && st.report?.result === "timeout" && took < 1_000 + 5_000 + 1_500 && st.err.some((l) => /did not stop within 5000 ms of the deadline/.test(l)), `took ${took} ms\n${st.err.join("\n")}`);

  // A pinned gate mismatch is sticky, as pinned.ts keeps it: the run ends at once, result rules, exit 1.
  const upTo = (to: number): BlockFixture => ({ ...fx, to, toHash: hashAt(to), blocks: fx.blocks.filter((x) => x.height <= to) });
  const d = await derivePin(upTo(30_000));
  let slept = 0;
  const t1 = Date.now();
  const rd = await run(["--node", NODE, "--pin", "--json", "--timeout-ms", "5000"], f,
    { loadPin: async () => ({ PIN: { ...d.pin, log: async () => d.log, gates: { ...d.pin.gates, V11_HEIGHT: 29_961 } } }), sleep: async () => { slept++; } });
  ok("a pin whose gate table differs from the loaded core's: RULES_DIFFER ends the run at once, result rules, exit 1",
    rd.code === 1 && rd.report?.result === "rules" && rd.report.lastError?.code === "RULES_DIFFER" && slept === 0 && Date.now() - t1 < 5_000, [...rd.err, ...rd.lines].join("\n"));
}

done("cli");
