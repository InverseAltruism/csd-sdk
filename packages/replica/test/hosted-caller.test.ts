// hostedBlocks under a caller root (roots.ts) over the recorded node answers (hosted-harness.ts): the caller's
// verified headers decide which blocks bind, the step reads only to the caller's tip, a caller reorg rolls back to a
// held hash, a caller with no header at the cursor below its tip is refused rather than rolled back, and every step
// the source emits is checked against the contract's own functions.
import type { VerifiedHeaders } from "../src/index.js";
import { done, ok } from "./check.js";
import { all, driveHosted } from "./hosted-harness.js";
import { blockAt, branchFrom, cap, hashesOk, refused, type Answers } from "./node-harness.js";

const branch = (fork: number): Answers => ({ ...all, ...branchFrom(fork) });

/** A caller's verified headers over `answers` from 29,859 up to `tip` (null: the tip unknown), holding only the heights
 *  `holds` accepts (default all), counting its calls. */
function callerHeaders(c: { answers: Answers; tip: number | null; holds?: (h: number) => boolean }) {
  const n = { syncs: 0, offers: 0 };
  const held = (h: number) => (c.tip !== null && h >= 29_859 && h <= c.tip && (c.holds?.(h) ?? true) ? blockAt(c.answers, h) : null);
  const headers: VerifiedHeaders = {
    floor: 29_859, origin: "https://headers.example",
    async sync(to) { n.syncs++; if (c.tip === null) return null; const b = blockAt(c.answers, Math.min(to ?? c.tip, c.tip)); return { height: b.height, hash: b.hash, time: Number(b.header.time) }; },
    async at(h) { const b = held(h); return b === null ? null : { hash: b.hash, merkle: String(b.header.merkle) }; },
    async offer() { n.offers++; return true; },
  };
  return { c, n, headers };
}

console.log("the caller root:");
const ch = callerHeaders({ answers: all, tip: cap.to }), cl = driveHosted({ answers: all }, { kind: "caller", headers: ch.headers }), cls = await cl.run();
ok("the caller's headers to 30,300: the pinned hashes, its basis the caller's floor and origin, each page offered to it",
  cls.cursor?.hash === blockAt(all, cap.to).hash && cls.lastError === null && hashesOk(cl.loop) && ch.n.offers === 8 && ch.n.syncs >= 1 &&
  cl.inner.basis.kind === "blocks" && cl.inner.basis.root.kind === "caller" && cl.inner.basis.root.floor === 29_859 && cl.bad.length === 0);
const mv = callerHeaders({ answers: all, tip: cap.to }), moved = { answers: all }, cm = driveHosted(moved, { kind: "caller", headers: mv.headers });
await cm.run();
mv.c.answers = moved.answers = branch(30_200);
const cms = await cm.run();
ok("the caller reorganises from 30,200: rolled back to 30,180, a held hash, then the branch read to its tip with the pinned hashes",
  cms.lastReorg?.to.height === 30_180 && cms.cursor?.hash === blockAt(branch(30_200), cap.to).hash && cms.lastError === null && hashesOk(cm.loop) && cm.bad.length === 0);
const lag = callerHeaders({ answers: all, tip: cap.to }), lg = driveHosted({ answers: all }, { kind: "caller", headers: lag.headers });
await lg.run();
lag.c.tip = 30_250;
const lgs = await lg.run();
ok("the caller's tip below the cursor on the same chain: SOURCE_UNAVAILABLE, nothing rolled back", refused(lgs, "SOURCE_UNAVAILABLE", cap.to) && lgs.lastReorg === null);
const unknown = callerHeaders({ answers: all, tip: null }), uk = await driveHosted({ answers: all }, { kind: "caller", headers: unknown.headers }).run();
ok("the caller's tip unknown (sync null): SOURCE_UNAVAILABLE, nothing read", uk.lastError?.code === "SOURCE_UNAVAILABLE" && /do not know the tip/.test(uk.lastError.reason) && uk.cursor === null);
// A caller whose own headers do not link at 30,101: it holds a block mined again at 30,100, which the server serves too.
const mixed: Answers = { ...all, [`/block/height/30100`]: branchFrom(30_100)["/block/height/30100"]! }, mixedCaller = callerHeaders({ answers: mixed, tip: cap.to });
const mx = await driveHosted({ answers: mixed }, { kind: "caller", headers: mixedCaller.headers }).run();
ok("caller headers that do not link: the binding's own link check refuses BRANCH_MOVED at 30,101", refused(mx, "BRANCH_MOVED", 30_100));
const other = callerHeaders({ answers: all, tip: cap.to }), ot = await driveHosted({ answers: branch(29_900) }, { kind: "caller", headers: other.headers }).run();
ok("pages from a branch the caller does not hold: HEADER_INVALID after a fresh read, the cursor below the fork", refused(ot, "HEADER_INVALID", 29_899));
const high = { ...callerHeaders({ answers: all, tip: cap.to }).headers, floor: 29_960 }, hi = await driveHosted({ answers: all }, { kind: "caller", headers: high }).run();
ok("caller headers from 29,960, above the activation height less one: BELOW_FLOOR", hi.lastError?.code === "BELOW_FLOOR" && hi.cursor === null);

console.log("what the caller holds:");
const short = callerHeaders({ answers: all, tip: 30_250 }), sh = await driveHosted({ answers: all }, { kind: "caller", headers: short.headers }).run();
ok("the caller's tip at 30,250, the server's at 30,300: the step reads to 30,250 and reports the caller's tip", sh.cursor?.height === 30_250 && sh.lastError === null &&
  sh.tip?.height === 30_250 && sh.tip.hash === blockAt(all, 30_250).hash);
const sparse = callerHeaders({ answers: all, tip: 30_200 }), sp = driveHosted({ answers: all }, { kind: "caller", headers: sparse.headers });
await sp.run();
Object.assign(sparse.c, { tip: cap.to, holds: (h: number) => h === 29_859 || h >= 30_250 });
const sps = await sp.run();
ok("a caller that keeps 29,859 and 30,250 to 30,300, its tip 30,300, the store at 30,200: SOURCE_UNAVAILABLE, nothing rolled back",
  refused(sps, "SOURCE_UNAVAILABLE", 30_200) && sps.lastReorg === null && /no header at the cursor/.test(sps.lastError?.reason ?? ""));

done("cairnx-replica hosted caller");
