// The ./testing entry. fixtureSource over cairnx-core's recorded blocks (29,860 to 117,000) must give the pinned
// corpus's events, compared as cairnx-core's test/events.test.ts compares the rule's output: the corpus sorted into
// the order of CONVENTION section 33.3, canonicalJson of each event, then of the list. The steps are driven by hand
// here, with the two sets of section 33.2 kept as the loop keeps them: grown only after a step; a source that stops
// advancing ends the drive after one step per fixture block.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { CAIRNX_EVENT_RULE, DEPLOY_FEE, TREASURY_ADDR, canonicalJson, resolve, type ChainEvent } from "@inversealtruism/cairnx-core";
import { levelOf, proofOf, type Cursor, type Source, type Step } from "../src/index.js";
import { fixtureSource, fixtures, type BlockFixture } from "../src/testing.js";
import { done, ok } from "./check.js";

// cairnx-core's package root, found through its resolved entry; its test files are read from the workspace.
const core = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..");
const fx = JSON.parse(readFileSync(join(core, "test/fixtures/events-blocks.json"), "utf8")) as BlockFixture;
const corpus = JSON.parse(readFileSync(join(core, "test/vectors/replay-corpus.json"), "utf8")) as { tipHeight: number; events: ChainEvent[] };

async function drain(src: Source, maxBlocks: number) {
  const eventIds = new Set<string>(), proposeIds = new Set<string>(), events: ChainEvent[] = [], cursors: (Cursor | null)[] = [];
  let cursor: Cursor | null = null, step: Step | null = null, steps = 0;
  const signal = new AbortController().signal;
  while (steps <= fx.blocks.length && (step = await src.next({
    rule: CAIRNX_EVENT_RULE, cursor, sofar: { eventIds, proposeIds }, hashAt: () => null, eventsHashAt: () => null,
    budget: { deadlineAt: Number.POSITIVE_INFINITY, maxRequests: 1, maxBlocks }, signal, now: () => 0,
  })).kind === "blocks") {
    steps++;
    for (const b of step.blocks) for (const e of b.events) {
      events.push(e);
      eventIds.add(e.kind === "propose" ? e.id : e.txid);
      if (e.kind === "propose") proposeIds.add(e.id);
    }
    cursor = { height: step.cursor.height, hash: step.cursor.hash ?? "" };
    cursors.push(cursor);
  }
  return { events, cursor, cursors, steps, last: step };
}

console.log("fixtureSource:");
const src = fixtureSource(fx);
ok("a fixture is a feed without inclusion proofs: level 1, records as served",
  levelOf(src.basis) === 1 && proofOf(src.basis) === "served" && src.floor === null);
const key = (e: ChainEvent) => [e.height, e.kind === "propose" ? 0 : 1, e.pos] as const;
const want = [...corpus.events].sort((a, b) => {
  const x = key(a), y = key(b);
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
});
const got = await drain(src, 64);
let equal = 0, first = -1;
for (let i = 0; i < Math.max(want.length, got.events.length); i++) {
  if (canonicalJson(got.events[i] ?? null) === canonicalJson(want[i] ?? null)) equal++;
  else if (first < 0) first = i;
}
ok(`the fixture's blocks give the ${want.length} corpus events, each equal (${equal} equal, first difference ${first})`,
  first === -1 && equal === 1133 && got.events.length === 1133);
ok("the event lists are the same bytes (section 33.6)", canonicalJson(got.events) === canonicalJson(want));
ok(`in steps of 64 blocks (${got.steps}), the cursor ascends to the fixture's end and the source then idles`,
  got.steps === Math.ceil(fx.blocks.length / 64) && got.cursors.every((c, i) => i === 0 || c!.height > got.cursors[i - 1]!.height) &&
  got.cursor?.height === fx.to && got.cursor.hash === fx.toHash && got.last?.kind === "idle" && got.last.tip.height === fx.to);
const bytes = canonicalJson(got.events);
for (const n of [0, 1, fx.blocks.length]) {
  const other = await drain(fixtureSource(fx), n);
  ok(`with a budget of ${n} block${n === 1 ? "" : "s"} (${other.steps} step${other.steps === 1 ? "" : "s"}) the events are the same bytes`,
    canonicalJson(other.events) === bytes && other.cursor?.hash === fx.toHash && other.last?.kind === "idle");
}

console.log("factories:");
const AL = `0x${"A1".repeat(20)}`, f = fixtures({ attConfidence: 100, lower: true });
const deploy = f.prop({ v: 1, t: "deploy", ticker: "AAA", decimals: 0, supply: "1000", mint: "issuer" },
  { proposer: AL, height: 40_000, paidTo: { [TREASURY_ADDR]: String(DEPLOY_FEE) } });
const att = f.att({ proposalId: deploy.id, attester: AL, score: 1, height: 40_001 });
ok("ids count up from 1 and lower writes the authors in lower case",
  deploy.id === `0x${"0".repeat(63)}1` && att.txid === `0x${"0".repeat(63)}2` && deploy.proposer === AL.toLowerCase() && att.attester === AL.toLowerCase());
ok("the defaults: position 1 and 50, expiry 1000 epochs on, the suite's confidence", deploy.pos === 1 && att.pos === 50 &&
  deploy.expiresEpoch === 2_333 && att.confidence === 100);
ok("without attConfidence an Attest has no confidence field", !("confidence" in fixtures().att({ proposalId: deploy.id, attester: AL, score: 1, height: 1 })));
ok("a factory's Propose carries a record resolve() applies", resolve([deploy], 40_010).tokens.AAA?.deployer === AL.toLowerCase());

done("cairnx-replica testing");
