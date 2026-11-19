// The witnesses of a reader (design section 4). Each advance asks every witness for its tip while the loop steps,
// then compares the replica's chain with each at one height: h = min(witness tip W, cursor C), and only when the higher
// of the two is at most FINAL_DEPTH above h. The hash compared is the witness's tip hash when h is W, else its hashAt(h)
// (one more request in series), against the hash the loop holds at h; when the loop holds none there, the witness
// cannot compare and confirms nothing. A confirmation is stamped with the time the witness's tip answer arrived and
// bound to the loop's generation, so a rollback, a reload or a reset of the chain voids it. A witness that answers
// another hash at h voids the confirmation for every witness (one witness can withhold "verified", none can grant it
// alone against another's word); so does a clock read earlier than the one before it, since the real time elapsed is
// then unknown. A witness's higher tip denies (TIP_BEHIND_PEER) when its header hashes to the hash it named and meets
// its own bits; no plausibility cap applies. A witness that throws is silent for the round; one that answers out of
// form (its tip or its gate table) is silent too and noted.
import { FINAL_DEPTH, HASH_RE } from "@inversealtruism/cairnx-core";
import { tipHeaderPowOk } from "@inversealtruism/csd-light";
import type { Witness, WitnessTip } from "./answer.js";
import { gatesDiffer, type Gates } from "./gates.js";
import type { Cursor, TipView } from "./types.js";

export type Witnessed = { readonly height: number; readonly hash: string; readonly by: string; readonly at: number; readonly generation: number };
type Chain = { readonly cursor: Cursor | null; hashAt(height: number): string | null; generation(): number };
type Heard = { readonly tip: WitnessTip | null; readonly at: number; readonly malformed: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const tipOk = (t: unknown): t is WitnessTip => isObject(t) && Number.isSafeInteger(t.height) && (t.height as number) >= 0 &&
  typeof t.hash === "string" && HASH_RE.test(t.hash.toLowerCase());
/** A gate table: an object of safe integer heights >= 0. */
const tableOk = (g: unknown): g is Gates => isObject(g) && Object.values(g).every((h) => Number.isSafeInteger(h) && (h as number) >= 0);

export function witnessBoard(witnesses: readonly Witness[], clock: () => number) {
  const heard = new Map<Witness, Heard>(), rules = new Map<Witness, Gates>();
  let witnessed: Witnessed | null = null, disagree = false, lastRead = Number.NEGATIVE_INFINITY;

  /** The clock, read through the board: a read earlier than the one before voids the confirmation. */
  function now(): number {
    const t = clock();
    if (t < lastRead) witnessed = null;
    lastRead = t;
    return t;
  }

  async function ask(w: Witness, signal: AbortSignal): Promise<void> {
    let t: unknown = null, bad = false;
    try { t = await w.tip(signal); } catch { t = null; }   // a witness that fails is silent this round
    const at = now();
    if (t !== null && !tipOk(t)) bad = true;
    if (!bad && w.rules !== undefined && !rules.has(w)) {
      let r: unknown = null;
      try { r = await w.rules(signal); } catch { r = null; }   // no table this round; asked again
      if (r !== null && !(isObject(r) && tableOk(r.gates))) bad = true;
      else if (r !== null) rules.set(w, (r as { gates: Gates }).gates);
    }
    heard.set(w, { tip: bad ? null : (t as WitnessTip | null), at, malformed: bad });
  }

  return {
    now,
    /** Every witness's tip, and its gate table until it gives one in form. */
    tips: (signal: AbortSignal) => Promise.all(witnesses.map((w) => ask(w, signal))).then(() => undefined),
    /** This round's comparisons against the chain the loop holds after its step. */
    async confirm(chain: Chain, signal: AbortSignal): Promise<void> {
      const gen = chain.generation();
      let agreed = null as Witnessed | null, against = false;
      for (const w of witnesses) {
        const a = heard.get(w), t = a?.tip, c = chain.cursor;
        if (a === undefined || t == null || c === null) continue;
        const h = Math.min(t.height, c.height), mine = chain.hashAt(h);
        if (Math.max(t.height, c.height) - h > FINAL_DEPTH || mine === null) continue;
        let theirs: unknown;
        try { theirs = h === t.height ? t.hash : await w.hashAt(h, signal); } catch { theirs = null; }
        if (chain.generation() !== gen) return;   // the chain was replaced while the witness was asked
        if (typeof theirs !== "string") continue;
        if (theirs.toLowerCase() !== mine) against = true;
        else agreed = { height: h, hash: mine, by: w.id, at: Math.min(a.at, agreed?.at ?? a.at), generation: gen };
      }
      disagree = against;
      if (against) witnessed = null;
      else if (agreed !== null) witnessed = agreed;
    },
    /** The confirmation held, if it is of the chain the loop holds now. */
    witnessed: (generation: number): Witnessed | null => (witnessed !== null && witnessed.generation === generation ? witnessed : null),
    disagree: (): boolean => disagree,
    malformed: (): boolean => [...heard.values()].some((a) => a.malformed),
    rulesDiffer: (own: Gates, tip: number): boolean => [...rules.values()].some((g) => gatesDiffer(g, own, tip)),
    peerAhead: (tip: TipView): boolean => [...heard.values()].some((a) => a.tip != null && a.tip.height > tip.height && tipHeaderPowOk(a.tip.header, a.tip.hash)),
  };
}
