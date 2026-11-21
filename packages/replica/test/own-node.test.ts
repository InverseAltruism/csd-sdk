// ownNode (server.ts): what open() takes for a server's replica of its own node on disk. Its refusals, each beside the
// honest call; a held lock and a disk error, which are not refusals; no host asked that the caller did not name, and
// the witness it names asked; the step budget, counted in steps over the recorded node.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FINAL_DEPTH, resolve, stateHash } from "@inversealtruism/cairnx-core";
import { diskStore, local, open, ownNode, ReplicaConfigError, type Pin } from "../src/server.js";
import { derivePin } from "../src/derive-pin.js";
import type { BlockFixture } from "../src/testing.js";
import { done, ok, thrown } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { branchFrom, cap, NODE, node } from "./node-harness.js";
import { hashAt, timeAt, witnessOn } from "./reader-harness.js";
import { FEED, key } from "./store-suite.js";

const root = mkdtempSync(join(tmpdir(), "cairnx-replica-own-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `s${n++}`);
const P = 30_000, TIP = cap.to, DEEP = TIP - FINAL_DEPTH, clock = () => timeAt(TIP) * 1000 + 60_000;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const truth = stateHash(resolve(corpus.events.filter((e) => e.height <= DEEP), DEEP));
const upTo: BlockFixture = { ...fx, to: P, toHash: hashAt(P), blocks: fx.blocks.filter((b) => b.height <= P) };
const d = await derivePin(upTo), pin: Pin = { ...d.pin, log: async () => d.log };

// Every request this file makes goes through a fetch it hands over; one through the global fetch is recorded and refused.
const hosts = new Set<string>(), realFetch = globalThis.fetch;
globalThis.fetch = (async (input: unknown) => { hosts.add(new URL(String(input)).host); throw new Error("no request leaves this test"); }) as typeof fetch;
const served = () => { const s = node({ answers: cap.answers }); return { ...s, f: (async (i, init) => { hosts.add(new URL(String(i)).host); return s.f(i, init); }) as typeof fetch }; };

console.log("the honest call and its refusals:");
const n0 = served(), dir0 = join(fresh(), "made", "on", "open"), r0 = await open({ ...ownNode({ node: NODE, dir: dir0, pin, fetch: n0.f }), clock });
const s0 = await r0.advance(), st0 = await r0.state();
ok("open(ownNode({ node, dir, pin })) over a dir that does not exist: created, verified at 30,300, the deep state resolve()'s over the corpus",
  s0.verified && s0.cursor?.height === TIP && st0.verified && stateHash(st0.value) === truth && s0.vouch.kind === "pinned", codes(s0));
await r0.close();
ok("a node outside the server's rule: ReplicaConfigError", thrown(() => ownNode({ node: "https://node.example", dir: fresh() })) instanceof ReplicaConfigError);
ok("a relative dir: ReplicaConfigError", thrown(() => ownNode({ node: NODE, dir: "store/replica" })) instanceof ReplicaConfigError);
const file = join(root, "a-file");
writeFileSync(file, "x");
const asFile = await open({ ...ownNode({ node: NODE, dir: file, fetch: served().f }), clock }).catch((e: unknown) => e);
ok("a dir that is a file: open throws ReplicaConfigError", asFile instanceof ReplicaConfigError, String(asFile));
const underFile = await open({ ...ownNode({ node: NODE, dir: join(file, "store"), fetch: served().f }), clock }).catch((e: unknown) => e);
ok("a dir that cannot be created (its parent is a file): open throws ReplicaConfigError", underFile instanceof ReplicaConfigError, String(underFile));

console.log("not refusals:");
const H = fresh(), holder = diskStore({ dir: H });
await holder.open(key(FEED));
const rh = await open({ ...ownNode({ node: NODE, dir: H, pin, fetch: served().f }), clock }), sh = await rh.advance();
ok("a lock another store holds: open resolves, NOT_SYNCED with STORE_UNAVAILABLE", !sh.verified && codes(sh).includes("NOT_SYNCED") && sh.notes.some((x) => x.code === "STORE_UNAVAILABLE"), codes(sh));
holder.close();
const sh2 = await rh.advance();
ok("released, the next advance opens and fills it: verified", sh2.verified, codes(sh2));
await rh.close();
const E = fresh();
mkdirSync(join(E, "meta.json"), { recursive: true });
const re = await open({ ...ownNode({ node: NODE, dir: E, pin, fetch: served().f }), clock }), se = await re.advance();
ok("a disk error at open (meta.json is a directory): open resolves, NOT_SYNCED with STORE_UNAVAILABLE", !se.verified && se.notes.some((x) => x.code === "STORE_UNAVAILABLE"), codes(se));
await re.close();

console.log("witnesses:");
ok("no request went to a host the caller did not name: only the node's", [...hosts].join() === new URL(NODE).host, [...hosts].join());
const ahead = witnessOn(cap.answers, TIP), nb = node({ answers: cap.answers, tip: 30_290 });
const rw = await open({ ...ownNode({ node: NODE, dir: fresh(), pin, fetch: nb.f, witness: ahead.witness }), clock }), sw = await rw.advance();
ok("the witness named is asked: a higher valid tip than the node's makes the answer TIP_BEHIND_PEER", codes(sw).split(",").includes("TIP_BEHIND_PEER") && !sw.verified, codes(sw));
await rw.close();
const other = witnessOn(branchFrom(30_295), TIP), ro = await open({ ...ownNode({ node: NODE, dir: fresh(), pin, fetch: node({ answers: cap.answers }).f, witness: other.witness }), clock });
const so = await ro.advance();
ok("a witness holding another block at the height compared adds the note SOURCES_DISAGREE", so.notes.some((x) => x.code === "SOURCES_DISAGREE"), JSON.stringify(so.notes));
await ro.close();
globalThis.fetch = realFetch;

console.log("the step budget, steps counted by the node's /tip reads:");
async function steps(make: (f: typeof fetch, dir: string) => Parameters<typeof open>[0]) {
  const nn = node({ answers: cap.answers }), r = await open({ ...make(nn.f, fresh()), clock }), s = await r.advance();
  await r.close();
  return { steps: nn.reads(/^\/tip$/), verified: s.verified && s.cursor?.height === TIP };
}
const own = await steps((f, dir) => ownNode({ node: NODE, dir, pin, fetch: f })), dflt = await steps((f, dir) => ({ ...local({ node: NODE, pin, fetch: f }), store: diskStore({ dir }) }));
ok(`from the pin to 30,300 (300 blocks): ownNode in ${own.steps} step(s), local over the same disk store in ${dflt.steps}`,
  own.verified && dflt.verified && own.steps <= 2 && dflt.steps >= 20, JSON.stringify({ own, dflt }));

done("cairnx-replica ownNode");
