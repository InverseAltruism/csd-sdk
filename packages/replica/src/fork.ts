// The fork search of nodeBlocks. When the node's chain no longer holds the cursor's block, the target is the highest
// held row (a block whose hash the store keeps, ctx.hashAt) that the node's chain still holds, else the floor. Rows
// are probed one block read each, galloping down from the top (1, 2, 4, ... rows below the lowest row known gone),
// then bisecting the bracket that holds the fork. For n held rows that is at most 2 * ceil(log2(n + 1)) probes, plus
// one read to tell a node behind the cursor from one on another chain and one for the floor's hash; /tip counts as a
// probe of its own height. The position is kept across steps for the same cursor, so a search cut short by a step's
// request budget resumes at the next step instead of starting again.
import type { Session } from "./http.js";
import type { Cursor, Step, StepContext, TipView } from "./types.js";

export type Head = { readonly height: number; readonly hash: string };
/** Why a search starts: /tip moved below the cursor or named another block at its height; or the block above the
 *  cursor does not link to it. */
export type Moved = "tip" | "link" | "resume";
interface State { readonly key: string; readonly held: number[]; lo: number; hi: number; stride: number }
/** `probe` reads the node's block at a height: its hash and its prev. */
type IO = { probe(s: Session, height: number): Promise<{ hash: string; prev: string }>; tipView(s: Session, h: Head): Promise<TipView> };

const keyOf = (c: Cursor) => `${c.height}:${c.hash}`;
const cannot = (code: "SOURCE_MALFORMED" | "SOURCE_UNAVAILABLE" | "SOURCE_RATE_LIMITED" | "BRANCH_MOVED", reason: string, retryAfterMs: number | null = null): Step =>
  ({ kind: "cannot", code, reason, retryAfterMs });

export function forkSearch(io: IO) {
  let st: State | null = null;
  const heldUpTo = (ctx: StepContext, top: number): number[] => {
    const out: number[] = [];
    for (let x = ctx.rule.activationHeight; x <= top; x++) if (ctx.hashAt(x) !== null) out.push(x);
    return out;
  };
  // A new search, or the step it ends in: a node behind the cursor on the chain the store holds is not followed down.
  async function start(s: Session, ctx: StepContext, at: Cursor, h: Head, why: Moved): Promise<State | Step> {
    const key = keyOf(at);
    if (why !== "tip" || at.height === h.height) {
      const held = heldUpTo(ctx, at.height);
      return { key, held, lo: -1, hi: why === "tip" ? held.length - 1 : held.length, stride: 1 };
    }
    let r = h.height;
    while (r >= ctx.rule.activationHeight && ctx.hashAt(r) === null) r--;
    const same = r < ctx.rule.activationHeight || (r === h.height ? ctx.hashAt(r) === h.hash : (await io.probe(s, r)).hash === ctx.hashAt(r));
    if (same) return cannot("SOURCE_UNAVAILABLE", `the node's tip ${h.height} is below the cursor ${at.height} on the chain the store holds`);
    const held = heldUpTo(ctx, r);
    return { key, held, lo: -1, hi: held.length - 1, stride: 1 };
  }

  return {
    /** "resume" when a search for this cursor is under way. */
    pending: (at: Cursor | null): Moved | null => (at !== null && st?.key === keyOf(at) ? "resume" : null),
    async run(s: Session, ctx: StepContext, at: Cursor, h: Head, why: Moved): Promise<Step> {
      if (st?.key !== keyOf(at)) {
        const next = await start(s, ctx, at, h, why);
        if ("kind" in next) return next;
        st = next;
      }
      while (st.hi - st.lo > 1) {
        if (s.requests() >= ctx.budget.maxRequests) {
          return cannot("SOURCE_RATE_LIMITED", `the fork search below ${at.height} used this step's requests; it resumes at the next step`, 0);
        }
        const idx = st.stride > 0 ? Math.max(st.lo + 1, st.hi - st.stride) : (st.lo + st.hi) >> 1, height = st.held[idx]!;
        if ((await io.probe(s, height)).hash === ctx.hashAt(height)) { st.lo = idx; st.stride = 0; } else { st.hi = idx; st.stride *= 2; }
      }
      const { lo, held } = st, floor = ctx.rule.activationHeight - 1, to = lo >= 0 ? held[lo]! : floor;
      st = null;
      if (to >= at.height) {
        return at.height <= floor ? cannot("BRANCH_MOVED", `the node's chain moved below the floor ${floor}`)
          : cannot("SOURCE_MALFORMED", `the node holds the cursor's block ${at.height}, and the block above it does not link to it`);
      }
      // The node's block at the floor is the prev of its block above it, which the next step reads and links to.
      const hash = lo >= 0 ? ctx.hashAt(to) ?? "" : (await io.probe(s, to + 1)).prev;
      return { kind: "reorg", to: { height: to, hash }, tip: await io.tipView(s, h) };
    },
  };
}
