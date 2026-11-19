// The witnesses of a reader (design section 4). Each advance asks every witness for its tip while the loop steps,
// then checks the replica's chain against them: a witness with tip height W confirms the replica's branch when it
// gives, at the highest height h the loop holds a hash for with W - FINAL_DEPTH <= h <= min(W, cursor), the hash the
// loop holds there (from its tip's hash when h is W, else by hashAt, one more request in series). A confirmation far
// below a witness's tip is never taken, so a store catching up from a low cursor earns none. A rollback below the
// confirmed block clears it. A witness's higher tip counts against the replica (TIP_BEHIND_PEER) only when its header
// hashes to the hash it named, meets its own bits and is plausible against the replica's tip (csd-light route.ts).
// A witness that throws or answers out of form is silent for that round.
import { FINAL_DEPTH, HASH_RE } from "@inversealtruism/cairnx-core";
import { TARGET_BLOCK_SECS } from "@inversealtruism/csd-codec";
import { contenderPlausible, tipHeaderPowOk } from "@inversealtruism/csd-light";
import type { Witness, WitnessTip } from "./answer.js";
import { gatesDiffer, type Gates } from "./gates.js";
import type { Cursor, TipView } from "./types.js";

export type Witnessed = { readonly height: number; readonly hash: string; readonly by: string; readonly at: number };
type Chain = { cursor: Cursor | null; hashAt(height: number): string | null };

const tipOk = (t: WitnessTip | null): t is WitnessTip =>
  t !== null && typeof t === "object" && Number.isSafeInteger(t.height) && t.height >= 0 && typeof t.hash === "string" && HASH_RE.test(t.hash.toLowerCase());

export function witnessBoard(witnesses: readonly Witness[], clock: () => number) {
  const last = new Map<Witness, WitnessTip | null>(), rules = new Map<Witness, Gates>();
  let witnessed: Witnessed | null = null, disagree = false;

  async function ask(w: Witness, signal: AbortSignal): Promise<void> {
    let t: WitnessTip | null;
    try { t = await w.tip(signal); } catch { t = null; }   // a witness that fails is silent this round
    last.set(w, tipOk(t) ? t : null);
    if (w.rules === undefined || rules.has(w)) return;
    try { const r = await w.rules(signal); if (r !== null && typeof r === "object") rules.set(w, r.gates); } catch { rules.delete(w); }
  }

  async function confirm(w: Witness, chain: Chain, signal: AbortSignal): Promise<void> {
    const t = last.get(w), c = chain.cursor;
    if (t == null || c === null) return;
    for (let h = Math.min(t.height, c.height); h >= t.height - FINAL_DEPTH && h >= 0; h--) {
      const mine = chain.hashAt(h);
      if (mine === null) continue;
      let theirs: string | null;
      try { theirs = h === t.height ? t.hash : await w.hashAt(h, signal); } catch { theirs = null; }
      if (typeof theirs !== "string") return;
      if (theirs.toLowerCase() !== mine) { disagree = true; return; }
      witnessed = { height: h, hash: mine, by: w.id, at: clock() };
      return;
    }
  }

  return {
    /** Every witness's tip, and its gate table the first time it gives one. */
    tips: (signal: AbortSignal) => Promise.all(witnesses.map((w) => ask(w, signal))).then(() => undefined),
    /** The confirmations of this round against the chain the loop holds after its step. */
    async confirm(chain: Chain, signal: AbortSignal): Promise<void> {
      disagree = false;
      for (const w of witnesses) await confirm(w, chain, signal);
    },
    rolledBack(to: Cursor): void { if (witnessed !== null && to.height < witnessed.height) witnessed = null; },
    witnessed: (): Witnessed | null => witnessed,
    disagree: (): boolean => disagree,
    rulesDiffer: (own: Gates, tip: number): boolean => [...rules.values()].some((g) => gatesDiffer(g, own, tip)),
    peerAhead(tip: TipView): boolean {
      return [...last.values()].some((t) => t != null && t.height > tip.height && tipHeaderPowOk(t.header, t.hash) && contenderPlausible({
        enabled: true, claimedHeight: t.height, contenderBits: t.header.bits, localHeight: tip.height, localTime: tip.time,
        nowSecs: clock() / 1000, blockSecs: TARGET_BLOCK_SECS, expectedLocalBits: null, maxAhead: FINAL_DEPTH, maxEase: 1,
      }));
    },
  };
}
