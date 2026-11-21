// The generator (scripts/generate-pin.mjs) offline, against a node served from the replica's recorded capture of
// 29,815 to 30,300: a base fixture cut at 30,000 from cairnx-core's, and the anchor 30,259, so the pin is 30,240 (events at 30,224 and 30,228 lie in the new range). The
// honest run must give the pin derivePin gives over cairnx-core's own recording to 30,240, and --check must pass on
// it; then each refusal is caused alone. A live node cannot be made to serve another block below a committed pin, a
// recording that drops a record, or another gate table, so those refusals are shown here only.
import { derivePin, BUILT_GATES } from "@inversealtruism/cairnx-replica/server";
import type { BlockFixture } from "@inversealtruism/cairnx-replica/testing";
import { done, ok } from "../../replica/test/check.js";
import { fx } from "../../replica/test/core-files.js";
import { all } from "../../replica/test/hosted-harness.js";
import { NODE, blockAt, node } from "../../replica/test/node-harness.js";
import { gen, type Descriptor } from "./shipped.js";

const hashAt = (h: number) => blockAt(all, h).hash;
const upTo = (h: number): BlockFixture => ({ ...fx, to: h, toHash: hashAt(h), blocks: fx.blocks.filter((b) => b.height <= h) });
const base = upTo(30_000), anchor = { height: 30_259, hash: hashAt(30_259) }, fetch = node({ answers: all }).f;
const run = (o: Partial<Parameters<typeof gen.generate>[0]>) =>
  gen.generate({ rpc: NODE, anchor, fetch, base, deltas: [], pin: null, ...o }).then((r) => ({ r, e: "" }), (e: unknown) => ({ r: null, e: e instanceof Error ? e.message : String(e) }));
const refusedWith = (x: { r: unknown; e: string }, re: RegExp) => x.r === null && re.test(x.e);

console.log("the honest run and --check:");
const honest = await run({}), want = (await derivePin(upTo(30_240))).pin;
ok("the pin at 30,240 equals the one derivePin gives over cairnx-core's recording to 30,240, in every field",
  honest.r !== null && JSON.stringify(honest.r.pin) === JSON.stringify(want) && honest.r.file === "delta-30001-30240.json", honest.e);
const wantLog = JSON.parse(new TextDecoder().decode((await derivePin(upTo(30_240))).log)) as { height: number }[];
const evH = [...new Set(wantLog.filter((e) => e.height > 30_000).map((e) => e.height))];
ok(`its delta holds exactly the blocks of the range that hold an event (${evH.join(", ")}), not every block with a payload (30,048 has one)`,
  honest.r !== null && JSON.stringify(honest.r.delta.blocks.map((b) => b.height)) === JSON.stringify(evH) && evH.length > 0);
const checked = await run({ check: true, deltas: honest.r ? [honest.r.delta] : [], pin: honest.r?.pin ?? null });
ok("--check over the committed delta and pin passes", checked.r !== null, checked.e);
const edited: Descriptor | null = honest.r ? { ...honest.r.pin, stateHash: want.eventsHash } : null;
ok("--check over a pin.json edited by hand refuses", refusedWith(await run({ check: true, deltas: honest.r ? [honest.r.delta] : [], pin: edited }), /--check: .*stateHash/));

console.log("each refusal alone:");
ok("an anchor the node's chain does not hold (30,258's hash at 30,259)", refusedWith(await run({ anchor: { ...anchor, hash: hashAt(30_258) } }), /does not hold the anchor/));
ok("an anchor less than FINAL_DEPTH below the tip (the node's tip at 30,265)",
  refusedWith(await run({ fetch: node({ answers: all, tip: 30_265 }).f }), /less than 12 below the node's tip 30265/));
ok("a previous pin whose block hash is not the node's block at from - 1", refusedWith(await run({ base: { ...base, toHash: hashAt(29_999) } }), /previous pin 30000 .* is not the node's block/));
const at = base.blocks.findIndex((b) => b.txs.some((t) => t.app.type === "Propose" && t.app.domain === "cairnx:v1") && b.height > 29_960);
const dropped = { ...base, blocks: base.blocks.map((b, i) => (i === at ? { ...b, txs: b.txs.filter((t) => t.app.domain !== "cairnx:v1") } : b)).filter((b) => b.txs.length > 0) };
ok(`a recording that lost a record (block ${base.blocks[at]?.height}): the two derivations differ`, at >= 0 && refusedWith(await run({ base: dropped }), /two derivations differ/));
ok("a gate table that differs from the replica's built one at or below the pin", refusedWith(await run({ built: { ...BUILT_GATES, V12_HEIGHT: 30_001 } }), /built one at or below 30240/));
const prior = (await derivePin(base)).pin;
ok("a gate table that differs from the committed pin's at or below its height",
  refusedWith(await run({ pin: { ...prior, gates: { ...prior.gates, V11_HEIGHT: 29_961 } } }), /committed pin's at or below 30000/));
ok("a new log that does not extend the committed pin's", refusedWith(await run({ pin: { ...prior, logSha256: want.logSha256 } }), /does not extend the committed pin at 30000/));
ok("the honest run over the committed pin at 30,000 passes", (await run({ pin: prior })).r !== null);
done("cairnx-pin generator");
