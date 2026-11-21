// The reader's name(): cairnx-core's nameView at the deep view, through the verified rule every read shares
// (reader.test.ts asserts each condition of that rule on name() beside balance()). The honest path at three heights,
// every name the corpus holds there equal to nameView over resolve() of the pinned corpus; cairnx-core's own forward
// cases (held, pending, lapsed, free, reserved, a prototype key) through a level 3 source; SHALLOW; INPUT_INVALID.
import { FINAL_DEPTH, applyOrder, canonicalJson, nameView, resolve, type CairnXState } from "@inversealtruism/cairnx-core";
import { open, type Answer, type BlockEvents, type NameValue } from "../src/index.js";
import { done, ok } from "./check.js";
import { corpus, forward } from "./core-files.js";
import { all } from "./hosted-harness.js";
import { callerReader, scripted, synth, timeAt, witnessOn } from "./reader-harness.js";

const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const truth = (h: number): CairnXState => resolve(corpus.events.filter((e) => e.height <= h), h);
const MIN = 60_000;
let now = 0;
const clock = () => now;

console.log("the honest path: caller root, a live witness, depth 12, every name at three heights:");
let verifiedSeen = 0, shallowSeen = 0;
for (const T of [30_250, 30_280, 30_300]) {
  now = timeAt(T) * 1000 + MIN;
  const x = await callerReader(T, { witnesses: [witnessOn(all, T).witness], clock });
  await x.r.advance();
  const top = truth(T).names, deep = truth(T - FINAL_DEPTH).names;
  const asked = [...new Set([...Object.keys(top), ...Object.keys(deep), "constructor", "csd", "nobody"])];
  const wrong: string[] = [];
  for (const n of asked) {
    const a = await x.r.name(n), d = nameView(deep, n), t = nameView(top, n);
    const right = same(d, t) ? a.verified && codes(a) === "" && same(a.value, d) && a.at?.deepHeight === T - FINAL_DEPTH
      : !a.verified && codes(a) === "SHALLOW" && same(a.shown, t);
    if (same(d, t)) verifiedSeen++; else shallowSeen++;
    if (!right) wrong.push(n);
  }
  ok(`tip ${T}: ${asked.length} names, each verified and equal to nameView at ${T - FINAL_DEPTH}, or SHALLOW alone with the tip's view where the two differ`,
    wrong.length === 0, wrong.join(" "));
  await x.r.close();
}
ok(`both outcomes occur on the corpus: ${verifiedSeen} verified, ${shallowSeen} SHALLOW`, verifiedSeen > 0 && shallowSeen > 0);

console.log("cairnx-core's forward cases through a level 3 source (one's own node, no witness needed):");
const blocksOf = (events: typeof corpus.events): BlockEvents[] =>
  [...new Set(events.map((e) => e.height))].sort((a, b) => a - b).map((h) => ({ height: h, hash: synth(h), events: events.filter((e) => e.height === h).sort(applyOrder) }));
const states = new Set<string>();
for (const c of forward.cases) {
  now = Date.UTC(2026, 10, 21);
  const r = await open({ source: scripted(blocksOf(c.events), { height: c.tipHeight, hash: synth(c.tipHeight), time: now / 1000 }), clock });
  await r.advance();
  const wrong: string[] = [];
  for (const q of c.asks) {
    const a = await r.name(q.query, { minDepth: 0 });
    const right = q.nameView === null ? codes(a) === "INPUT_INVALID" && !a.verified && a.shown === null : a.verified && same(a.value, q.nameView);
    if (q.nameView !== null) states.add((q.nameView as NameValue).state);
    if (!right) wrong.push(`${q.query}: ${codes(a)} ${canonicalJson(a.verified ? a.value : a.shown)}`);
  }
  ok(`${c.name} at ${c.tipHeight}: ${c.asks.length} asked, each the case's nameView, verified (or INPUT_INVALID where the case gives null)`, wrong.length === 0, wrong.join("; "));
  if (c.name === "held-nset") {
    // nset at 100,011: at depth 2 the deep view (100,010) is held and pays the owner, the tip view pays the nset address.
    const a2 = await r.name("alice", { minDepth: 2 }), q = c.asks[0]!.nameView as NameValue;
    ok("held-nset at depth 2: the same class, another address at the tip: SHALLOW alone, the tip's address in shown",
      codes(a2) === "SHALLOW" && !a2.verified && a2.shown?.state === "held" && a2.shown.addr === q.addr && q.addr !== q.owner);
  }
  if (c.name === "pending" || c.name === "lapsed") {
    const a12 = await r.name(c.asks[0]!.query);
    ok(`${c.name}: at the default depth the deep view is not yet ${c.name}: SHALLOW alone, ${c.name} in shown`,
      codes(a12) === "SHALLOW" && (a12 as Answer<NameValue> & { verified: false }).shown?.state === c.name);
  }
  await r.close();
}
ok(`the cases cover every class of nameView: ${[...states].sort().join(", ")}`, ["free", "held", "lapsed", "pending", "reserved"].every((s) => states.has(s)));

console.log("INPUT_INVALID:");
now = timeAt(30_300) * 1000 + MIN;
const own = await callerReader(30_300, { witnesses: [witnessOn(all, 30_300).witness], clock });
await own.r.advance();
const bad = await Promise.all(["Cairn", "cairn.csd", "__proto__", "", "-a", "a".repeat(33), 5 as unknown as string].map((n) => own.r.name(n)));
ok("an upper-case name, a .csd suffix, __proto__, an empty string, a leading hyphen, 33 characters, a number: INPUT_INVALID alone, nothing shown",
  bad.every((a) => codes(a) === "INPUT_INVALID" && !a.verified && a.shown === null));
const proto = await own.r.name("constructor"), held = await own.r.name("cairn");
ok("constructor, a prototype key and a valid name, is free and verified; cairn, asked as names writes it, is held",
  proto.verified && proto.value.state === "free" && proto.value.owner === null && held.verified && held.value.state === "held");
await own.r.close();

done("cairnx-replica name");
