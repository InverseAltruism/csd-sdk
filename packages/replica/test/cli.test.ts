// The command `cairnx-replica check` (src/cli.ts) over the recorded captures: each source the command names reaches the
// tuple at the newest final boundary, equal to the one cairnx-core's corpus gives there; a reference or an expected
// tuple that differs in each field exits 1 with its kind; usage errors exit 2; a sticky refusal ends the run at once.
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
  const lines: string[] = [];
  const code = await runCheck(["check", ...args], { out: (l) => lines.push(l), fetch: f, ...extra });
  const last = lines.at(-1) ?? "";
  let report: { tuple: unknown; result: string; level: number; proof: string; lastError: { code: string } | null } | null = null;
  try { report = JSON.parse(last); } catch { report = null; }
  return { code, lines, report };
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
  const held = await run(["--node", NODE], node({ answers: cap.answers }).f);
  ok("with no reference: the tuple printed, result held, exit 0",
    held.code === 0 && held.lines.includes(`tuple 30270 block ${T30.blockHash} events ${T30.eventsHash} state ${T30.stateHash}`) && held.lines.at(-1) === "result: held", held.lines.join("\n"));
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
    ok(`--expect with ${what}: result ${kind}, exit 1`, r.code === 1 && r.report?.result === kind && same(r.report.tuple, T30), r.lines.join("\n"));
  }
  const tupleBody = (t: typeof T30) => ({ ok: true, height: t.height, blockHash: t.blockHash, eventsHash: t.eventsHash, stateHash: t.stateHash });
  const eq = await run(["--node", NODE, "--reference", REF, "--json"], withRef(node({ answers: cap.answers }).f, () => ({ status: 200, body: tupleBody(T30) })));
  ok("--reference answering the same tuple: result equal, exit 0", eq.code === 0 && eq.report?.result === "equal", eq.lines.join("\n"));
  const ne = await run(["--node", NODE, "--reference", REF, "--json"], withRef(node({ answers: cap.answers }).f, () => ({ status: 200, body: tupleBody({ ...T30, stateHash: other }) })));
  ok("--reference answering another state hash: result rules, exit 1", ne.code === 1 && ne.report?.result === "rules", ne.lines.join("\n"));
  const gone = await run(["--node", NODE, "--reference", REF, "--json"], withRef(node({ answers: cap.answers }).f, (p) => ({ status: 404, body: { ok: false, error: "not a kept boundary", height: Number(p.split("/").at(-1)!.split(":")[0]) } })));
  ok("--reference that keeps no such boundary: result missing, exit 1", gone.code === 1 && gone.report?.result === "missing", gone.lines.join("\n"));
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
  const bad = await run(["--node", NODE, "--pin", "--json"], f, { loadPin: async () => ({ PIN: { ...d.pin, log: async () => d.log, eventsHash: "0x" + "cd".repeat(32) } }), sleep: async () => { slept++; } });
  ok("a pin whose events hash is not its log's: PIN_MISMATCH ends the run at once, no tuple, exit 1",
    bad.code === 1 && bad.report?.result === "no-tuple" && bad.report.lastError?.code === "PIN_MISMATCH" && slept === 0 && Date.now() - t0 < 30_000, bad.lines.join("\n"));
}

done("cli");
