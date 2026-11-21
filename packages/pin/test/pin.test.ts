// The shipped pin: the build's log regenerated from cairnx-core's committed fixture and the deltas, byte for byte,
// with all three hashes; the deltas hold exactly the blocks above the base that hold an event; and the honest path
// on the production call shape, local({ node, pin: PIN }) and hosted({ origin, pin: PIN, witness }), over a capture
// of the standby node from 143,296 to 143,356 (bodies kept from 143,341; below, the headers the anchor root seeds from).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { FINAL_DEPTH, resolve, stateHash, type ChainEvent } from "@inversealtruism/cairnx-core";
import { memoryStore, nodeBlocks, pinned, replicaLoop } from "@inversealtruism/cairnx-replica/server";
import { hosted, local, open } from "@inversealtruism/cairnx-replica/browser";
import { PIN } from "../dist/index.js";
import { done, ok } from "../../replica/test/check.js";
import { front } from "../../replica/test/hosted-harness.js";
import { NODE, node, blockAt } from "../../replica/test/node-harness.js";
import { witnessOn } from "../../replica/test/reader-harness.js";
import { chainRead, shipped, type Descriptor } from "./shipped.js";

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
const pinJson = JSON.parse(readFileSync(shipped.PIN_FILE, "utf8")) as Descriptor;
const base = shipped.baseFixture(), deltas = shipped.readDeltas(), d = await shipped.derive(), shippedLog = await PIN.log();
const events = JSON.parse(new TextDecoder().decode(d.log)) as ChainEvent[];

console.log("the log, regenerated:");
ok(`cairnx-core's fixture is the committed one (sha256 ${sha(readFileSync(new URL("../../cairnx/test/fixtures/events-blocks.json", import.meta.url))).slice(0, 8)})`,
  sha(readFileSync(new URL("../../cairnx/test/fixtures/events-blocks.json", import.meta.url))) === "46f02644c048078d0da2f3623f251e3e6acd6d3d39b5ce38f40672369ed7c58c" && base.to === 117_000);
ok(`the fixture and the ${deltas.length} delta(s) give the shipped log byte for byte (${d.log.length} bytes)`,
  d.log.length === shippedLog.length && d.log.every((x, i) => x === shippedLog[i]));
ok("the derived pin repeats pin.json in every field but core, and its logSha256, eventsHash and stateHash are the log's own",
  shipped.differing(d.pin, pinJson).length === 0 && `0x${sha(shippedLog)}` === pinJson.logSha256 && d.pin.eventsHash === pinJson.eventsHash &&
  stateHash(resolve(events, pinJson.height)) === pinJson.stateHash);
ok("PIN is pin.json with log()", JSON.stringify({ ...PIN, log: undefined }) === JSON.stringify({ ...pinJson, log: undefined }) && typeof PIN.log === "function");
const deltaText = deltas.map((x) => readFileSync(new URL(`../fixtures/delta-${x.from}-${x.to}.json`, import.meta.url), "utf8"));
ok("each delta file is the recorder's byte form of what it holds", deltas.every((x, i) => chainRead.renderFixture(x) === deltaText[i]));
const evH = new Set(events.filter((e) => e.height > base.to).map((e) => e.height)), held = deltas.flatMap((x) => x.blocks.map((b) => b.height));
ok(`the deltas hold exactly the ${evH.size} blocks above ${base.to} that hold an event`, held.length === evH.size && held.every((h) => evH.has(h)));

console.log("the honest path with the shipped pin:");
const cap = JSON.parse(readFileSync(new URL("./fixtures/node-blocks-143296-143356.json", import.meta.url), "utf8")) as { to: number; answers: Record<string, string> };
const TIP = cap.to, DEEP = TIP - FINAL_DEPTH, P = PIN.height, timeAt = (h: number) => Number(blockAt(cap.answers, h).header.time);
const now = timeAt(TIP) * 1000 + 60_000, clock = () => now, truth = stateHash(resolve(events, DEEP));
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
ok(`the capture holds no payload transaction above the pin, so the deep state is the log's at ${DEEP}`,
  Object.entries(cap.answers).every(([k, v]) => Number(k.split("/")[3]) <= P || !(JSON.parse(v) as { txs: { app?: { type: string } }[] }).txs.some((t) => t.app !== undefined && t.app.type !== "None")));
const n = node({ answers: cap.answers, tip: TIP }), r0 = await open({ ...local({ node: NODE, pin: PIN, fetch: n.f }), clock }), s0 = await r0.advance(), st0 = await r0.state();
const below = n.log.filter((l) => /^\/block\/height\/[0-9]+$/.test(l.path) && Number(l.path.split("/")[3]) <= P).length;
ok("local({ node, pin: PIN }): verified at level 3, proof pinned, the deep state the log's, no block at or below the pin read",
  s0.verified && s0.level === 3 && s0.proof === "pinned" && s0.cursor?.height === TIP && st0.verified && stateHash(st0.value) === truth && below === 0, `${codes(s0)} below=${below}`);
await r0.close();
const hostedOf = (witness?: ReturnType<typeof witnessOn>["witness"]) =>
  hosted({ origin: "https://front.example", pin: PIN, fetch: front({ answers: cap.answers, tip: TIP }).f, ...(witness ? { witness } : {}) });
const h0 = await open({ ...hostedOf(witnessOn(cap.answers, TIP).witness), clock }), hs0 = await h0.advance(), hst = await h0.state();
ok("hosted({ origin, pin: PIN, witness }): verified, the deep state the log's", hs0.verified && hst.verified && stateHash(hst.value) === truth, codes(hs0));
const h1 = await open({ ...hostedOf(), clock }), hs1 = await h1.advance();
ok("hosted with no witness: NOT_WITNESSED alone", codes(hs1) === "NOT_WITNESSED" && !hs1.verified);
await h0.close(); await h1.close();
const bl = replicaLoop({ source: pinned({ pin: PIN, then: nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers, tip: TIP }).f }) }), store: memoryStore() });
await bl.advance();
const pb = bl.boundary(P);
ok("the pin's boundary is held with pin.json's block hash, events hash and state hash", pb?.hash === pinJson.blockHash && pb.eventsHash === pinJson.eventsHash && pb.stateHash === pinJson.stateHash);
await bl.close();
done("cairnx-pin shipped");
