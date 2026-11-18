// @inversealtruism/cairnx-replica/testing: sources and factories for tests of a replica and of what reads one.
import { blockEvents, blockMembers, type EventRuleTx } from "@inversealtruism/cairnx-core";
import { stepSofar } from "./sofar.js";
import type { Source, TipView } from "./types.js";

export { fixtures, type AttOpts, type PropOpts } from "./factories.js";

/** One transaction of a recorded block fixture: u64 values as decimal strings, the author bound when it was recorded. */
export interface FixtureTx {
  readonly pos: number; readonly txid: string; readonly app: { readonly type: string; readonly [field: string]: unknown };
  readonly outputs: readonly { readonly scriptPubkey: string; readonly value: string }[]; readonly author: string;
}
/** A recorded block fixture, cairnx-core's test/fixtures/events-blocks.json: every transaction with an app payload of
 *  every block from `from` to `to`, in ascending height. */
export interface BlockFixture {
  readonly format: 1; readonly from: number; readonly to: number; readonly toHash: string;
  readonly blocks: readonly { readonly height: number; readonly hash: string; readonly txs: readonly FixtureTx[] }[];
}

type App = EventRuleTx["tx"]["app"];
type TxOutput = EventRuleTx["tx"]["outputs"][number];
const u64 = (v: unknown): unknown => (typeof v === "string" && /^[0-9]+$/.test(v) ? BigInt(v) : v);
const decode = (t: FixtureTx): EventRuleTx & { author: string } => ({
  pos: t.pos, txid: t.txid, author: t.author,
  tx: {
    app: (t.app.type === "Propose" ? { ...t.app, expiresEpoch: u64(t.app.expiresEpoch) } : t.app) as App,
    outputs: t.outputs.map((o) => ({ scriptPubkey: o.scriptPubkey, value: u64(o.value) }) as TxOutput),
  },
});

/** A source over a recorded block fixture. Each step maps up to `ctx.budget.maxBlocks` of its blocks above the cursor
 *  (at least one) by the rule of CONVENTION section 33 with the recorded authors; the step that reaches its last block
 *  moves the cursor to `to`. A fixture is complete only on its recorder's word, so its basis is a feed without
 *  inclusion proofs: level 1. It records no header time, so the tip's is `tipTime` (default 0). */
export function fixtureSource(fx: BlockFixture, o: { feed?: string; tipTime?: number } = {}): Source {
  const tip: TipView = { height: fx.to, hash: fx.toHash, time: o.tipTime ?? 0 };
  return {
    basis: { kind: "feed", feed: o.feed ?? "fixture", inclusion: false },
    floor: null,
    tip: async () => tip,
    async next(ctx) {
      const after = ctx.cursor?.height ?? ctx.rule.activationHeight - 1;
      if (after >= fx.to) return { kind: "idle", tip };
      const rest = fx.blocks.filter((b) => b.height > after), todo = rest.slice(0, Math.max(1, ctx.budget.maxBlocks));
      const sofar = stepSofar(ctx.sofar);
      const blocks = todo.map((b) => {
        const txs = b.txs.map(decode);
        const authors = blockMembers(b.height, txs, sofar.view, ctx.rule).map((m) => m.item.author);
        const events = blockEvents(b.height, txs, sofar.view, authors, ctx.rule);
        sofar.add(events);
        return { height: b.height, hash: b.hash, events };
      });
      const last = todo.at(-1);
      const cursor = todo.length === rest.length || last === undefined ? { height: fx.to, hash: fx.toHash } : { height: last.height, hash: last.hash };
      return { kind: "blocks", blocks, cursor, tip };
    },
  };
}
