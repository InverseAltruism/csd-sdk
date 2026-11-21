// The sequence of commits the kill test cuts (disk-kill.test.ts, disk-kill-child.ts): a pin at 30,000 derived from
// cairnx-core's fixture, then synthetic blocks above it on branch A to T1, a reorg to R, and branch B to T2, 16 blocks
// a step, with an event every 7th block. Every commit kind is in it: the pin's load, extends, extends that make
// boundaries deep, a rollback, and the extend that cuts the rolled-back tail. Every extend carries a header window
// that names the cursor it was committed at, its `work` that cursor's height, so a store opened at any point can show
// that its window and its meta are of one commit.
import { createHash } from "node:crypto";
import { derivePin } from "../src/derive-pin.js";
import { diskStoreWith, type DiskHooks } from "../src/disk-store.js";
import { pinned, replicaLoop, type BlocksSource, type HeldWindow, type Pin, type StepContext } from "../src/index.js";
import { fixtures, type BlockFixture } from "../src/testing.js";
import { fx } from "./core-files.js";
import { hashAt as capHash } from "./reader-harness.js";

const P = 30_000, T1 = P + 200, R = P + 170, T2 = P + 260;
const sha = (s: string) => "0x" + createHash("sha256").update(s).digest("hex");
const upTo: BlockFixture = { ...fx, to: P, toHash: capHash(P), blocks: fx.blocks.filter((b) => b.height <= P) };
const d = await derivePin(upTo);
export const PIN: Pin = { ...d.pin, log: async () => d.log };

// Branch A below R and on A; branch B above R once B is the chain.
const hashOf = (branch: "A" | "B", h: number) => (h === P ? PIN.blockHash : sha(`${h <= R ? "A" : branch}${h}`));
function then(given: { w: HeldWindow | null }): BlocksSource {
  const f = fixtures();
  let onB = false;
  const tip = () => (onB ? { height: T2, hash: hashOf("B", T2), time: 2e9 } : { height: T1, hash: hashOf("A", T1), time: 2e9 });
  const events = (b: "A" | "B", h: number) =>
    h % 7 === 0 ? [f.prop({ v: 1, t: "nrenew", name: "alice" }, { proposer: `0x${"a1".repeat(20)}`, height: h, pos: 1, id: sha(`${h <= R ? "A" : b}e${h}`) })] : [];
  return {
    basis: { kind: "blocks", root: { kind: "own-node", node: "http://127.0.0.1:8789" }, bodies: "http://127.0.0.1:8789" }, floor: null,
    tip: async () => tip(), block: async () => { throw new Error("not read"); },
    windowAt: (c) => ({ bytes: new TextEncoder().encode(`${c.height}:${c.hash}`), work: String(c.height), workRoot: { height: P, hash: PIN.blockHash } }),
    restoreWindow: (w) => { given.w = w; },
    async next(ctx: StepContext) {
      const at = ctx.cursor!.height;
      if (at >= T1 || (at > R && ctx.cursor!.hash === hashOf("B", at))) onB = true;
      if (onB && at > R && ctx.cursor!.hash !== hashOf("B", at)) return { kind: "reorg", to: { height: R, hash: hashOf("A", R) }, tip: tip() };
      const top = tip().height, branch = onB ? "B" : "A";
      if (at >= top) return { kind: "idle", tip: tip() };
      const blocks = [];
      for (let h = at + 1; h <= Math.min(top, at + ctx.budget.maxBlocks); h++) blocks.push({ height: h, hash: hashOf(branch, h), events: events(branch, h) });
      const last = blocks.at(-1)!;
      return { kind: "blocks", blocks, cursor: { height: last.height, hash: last.hash! }, tip: tip() };
    },
  };
}

/** Runs the sequence on the store in `dir` from whatever it holds, to the end. */
export async function runSequence(dir: string, hooks: DiskHooks) {
  const given: { w: HeldWindow | null } = { w: null };
  const loop = replicaLoop({ source: pinned({ pin: PIN, then: then(given) }), store: diskStoreWith({ dir }, hooks), maxBlocks: 16 });
  const opened = await loop.open();
  let s = loop.status();
  const openedAt = s.cursor, w = given.w;
  // The window the open handed the source, as "<height>:<hash>", when its meta's work is that height; else "unpaired".
  const window = w === null ? null : new TextDecoder().decode(w.bytes).split(":")[0] === w.work ? new TextDecoder().decode(w.bytes) : "unpaired";
  for (let i = 0; i < 100 && s.cursor?.hash !== hashOf("B", T2); i++) s = await loop.advance();
  await loop.close();
  return { opened, openedAt, window, cursor: s.cursor, eventsHash: s.eventsHash, lastError: s.lastError };
}
