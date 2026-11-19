// Readers over the recorded captures for the reader's tests: hostedBlocks under a caller root over our front door
// (hosted-harness.ts), nodeBlocks over the node (node-harness.ts), and a scripted level 3 source of synthetic blocks;
// witnesses over the same recorded answers. Every clock is the test's.
import { rpcHeaderToHeader } from "@inversealtruism/csd-client";
import { hostedBlocks, nodeBlocks } from "../src/browser.js";
import { open, type BlockEvents, type BlocksBasis, type OpenOptions, type Source, type Step, type TipView, type Witness, type WitnessTip } from "../src/index.js";
import { all, callerHeaders, front, ORIGIN } from "./hosted-harness.js";
import { blockAt, cap, NODE, node, type Answers } from "./node-harness.js";

/** The header time of the recorded block at `h`, in seconds. */
export const timeAt = (h: number, a: Answers = all): number => Number(blockAt(a, h).header.time);
export const hashAt = (h: number, a: Answers = all): string => blockAt(a, h).hash;

/** A witness over `answers` at `tip` that names its tip as `claim` maps it; silent while `silent` is set. */
export function witnessOn(answers: Answers, tip: number, o: { origin?: string; id?: string; claim?: (t: WitnessTip) => WitnessTip; rules?: Record<string, number> } = {}) {
  const w = { answers, tip, silent: false, hashReads: 0 };
  const witness: Witness = {
    id: o.id ?? "witness", origin: o.origin ?? "https://witness.example",
    async tip() {
      if (w.silent) return null;
      const b = blockAt(w.answers, w.tip), t: WitnessTip = { height: b.height, hash: b.hash, time: Number(b.header.time), header: rpcHeaderToHeader(b.header as never) };
      return o.claim ? o.claim(t) : t;
    },
    async hashAt(h) { w.hashReads++; return w.silent || w.answers[`/block/height/${h}`] === undefined || h > w.tip ? null : blockAt(w.answers, h).hash; },
    ...(o.rules ? { rules: async () => ({ gates: o.rules! }) } : {}),
  };
  return { w, witness };
}

/** A reader over hostedBlocks under a caller root whose headers reach `tip`, with the options given; `served` and
 *  `ch.c` hold the answers of the front door and of the caller's headers, which a test may replace. */
export async function callerReader(tip: number, o: Omit<OpenOptions, "source"> = {}) {
  const ch = callerHeaders({ answers: all, tip }), served = { answers: all }, fr = front(served);
  const source = hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: ch.headers }, fetch: fr.f });
  return { ch, served, fr, source, r: await open({ source, ...o }) };
}

/** nodeBlocks over the recorded node, each step's tip passed through `tip` when given. */
export function nodeSource(tip?: (t: TipView) => TipView): Source {
  const s = nodeBlocks({ node: NODE, fetch: node({ answers: cap.answers }).f });
  if (tip === undefined) return s;
  return { ...s, async next(ctx) {
    const st: Step = await s.next(ctx);
    return st.kind === "cannot" ? st : { ...st, tip: tip(st.tip) } as Step;
  } };
}

export const OWN: BlocksBasis = { kind: "blocks", root: { kind: "own-node", node: NODE }, bodies: NODE };
/** A level 3 source of `blocks` whose first step reaches `tip` and later steps idle. */
export function scripted(blocks: BlockEvents[], tip: TipView, basis: BlocksBasis = OWN): Source {
  return {
    basis, floor: null, tip: async () => tip,
    async next(ctx) {
      if ((ctx.cursor?.height ?? -1) >= tip.height) return { kind: "idle", tip };
      return { kind: "blocks", blocks: blocks.filter((b) => b.height > (ctx.cursor?.height ?? -1)), cursor: { height: tip.height, hash: tip.hash }, tip };
    },
  };
}
export const synth = (h: number): string => `0x${"c".repeat(58)}${h.toString(16).padStart(6, "0")}`;
