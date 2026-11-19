// Forward resolution (CONVENTION §35.4): resolveNameIn and nameView over resolve() results. Three layers: the shipped
// vectors (test/vectors/forward.json, written by hand in conformance/gen-forward-vectors.mjs); the call shape the
// service and the replica send, resolveNameIn(state.names, name), over every name of the replay corpus at every pinned
// height, against an oracle written apart from the code; and the keys a plain object inherits.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ADDR_RE, V15_HEIGHT, nameView, resolve, resolveNameIn, type ChainEvent, type NameView, type ResolvedName,
} from "../src/index.js";

// Each check runs to the end and is counted, so a mutation reports every check it turns red.
let pass = 0, fail = 0;
const t = (name: string, fn: () => void) => {
  try {
    const r = fn() as unknown;
    if (r !== undefined) throw new Error(`test "${name}" returned a value - use assert`);
    pass++; console.log("  ok", name);
  } catch (e) { fail++; console.log(`  FAIL ${name}: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`); }
};
const read = (f: string) => JSON.parse(readFileSync(new URL(`./vectors/${f}`, import.meta.url), "utf8"));

type Ask = { query: string; resolveNameIn: ResolvedName | null; nameView: NameView | null };
type Case = { name: string; tipHeight: number; events: ChainEvent[]; asks: Ask[] };
const vectors = read("forward.json") as { format: number; cases: Case[] };

t("forward.json is format 1 with every class of §35.4", () => {
  assert.equal(vectors.format, 1);
  const states = new Set(vectors.cases.flatMap((c) => c.asks.map((a) => a.nameView?.state ?? "not a name")));
  assert.deepEqual([...states].sort(), ["free", "held", "lapsed", "not a name", "pending", "reserved"]);
});
let asked = 0;
for (const c of vectors.cases) {
  const names = resolve(c.events, c.tipHeight).names;
  for (const a of c.asks) {
    t(`vector ${c.name}: resolveNameIn(${a.query})`, () => assert.deepEqual(resolveNameIn(names, a.query), a.resolveNameIn));
    t(`vector ${c.name}: nameView(${a.query})`, () => assert.deepEqual(nameView(names, a.query), a.nameView));
    asked++;
  }
}

// The oracle: a pending reservation gives nothing, every other name its address if it has one, else its owner.
const oracle = (names: ReturnType<typeof resolve>["names"], name: string): ResolvedName | null => {
  const n = names[name]!;
  if (n.pending === true) return null;
  const hasAddr = typeof n.addr === "string";
  return { name, addr: hasAddr ? n.addr! : n.owner, via: hasAddr ? "nset" : "owner", lapsed: n.expired === true, owner: n.owner };
};
const corpus = read("replay-corpus.json") as { tipHeight: number; events: ChainEvent[] };
const heights = [...Object.keys((read("replay-hashes.json") as { hashes: Record<string, string> }).hashes).map(Number), corpus.tipHeight];
let corpusNames = 0, belowV15 = 0;
t(`the service's call shape over every corpus name at ${heights.length} heights equals the oracle; nameView agrees`, () => {
  for (const h of heights) {
    const names = resolve(corpus.events.filter((e) => e.height <= h), h).names;
    for (const name of Object.keys(names)) {
      const r = resolveNameIn(names, name);
      assert.deepEqual(r, oracle(names, name), `${name} at ${h}`);
      if (r) assert.ok(ADDR_RE.test(r.addr), `${name} at ${h}: the address is 0x and 40 lowercase hex`);
      const v = nameView(names, name)!;
      assert.equal(v.state, r === null ? "pending" : r.lapsed ? "lapsed" : "held", `${name} at ${h}: nameView's class`);
      assert.equal(v.addr, v.state === "held" ? r!.addr : null, `${name} at ${h}: nameView's address is resolveNameIn's, held only`);
      assert.equal(v.paidThroughEpoch, v.state === "pending" ? null : names[name]!.paidThroughEpoch ?? null, `${name} at ${h}: nameView's paidThroughEpoch`);
      if (h < V15_HEIGHT) { assert.equal(v.paidThroughEpoch, null, `${name} at ${h}: no lease below V15`); belowV15++; }
      corpusNames++;
    }
  }
  assert.ok(corpusNames > 0 && belowV15 > 0, "the corpus has names, some at tips below V15");
});

t("no key a plain object inherits resolves, on a resolve() result", () => {
  const names = resolve([], 100_000).names;
  for (const k of Object.getOwnPropertyNames(Object.prototype)) {
    assert.equal(resolveNameIn(names, k), null, k);
    const v = nameView(names, k);
    assert.ok(v === null || v.state === "free", `${k}: nameView is null or free`);
  }
});

t("nameView refuses a non-string and copies the profile it returns", () => {
  const c = vectors.cases.find((x) => x.name === "profile-not-target")!;
  const names = resolve(c.events, c.tipHeight).names;
  assert.equal(nameView(names, 5 as unknown as string), null);
  const v = nameView(names, "prof1")!;
  v.profile.wallet = "changed";
  assert.notEqual(names.prof1!.profile!.wallet, "changed", "the state's profile is not the view's object");
});

console.log(`forward resolution: ${pass} passed, ${fail} failed (${vectors.cases.length} vectors, ${asked} asks; ${corpusNames} corpus name reads at ${heights.length} heights, ${belowV15} below V15)`);
if (fail) process.exit(1);
