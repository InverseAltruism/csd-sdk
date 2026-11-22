// The running comparison with a reference (design section 6, CONVENTION section 34.3): after an advance, the newest
// boundary whose tuple the loop holds is read from the reference twice at most, by height and block hash, then by
// height. Another block hash there is a branch, never a difference; a 404 to both is missing. The same block hash with
// another tuple is a difference: a binary search over the held boundaries finds the first that differs, and the
// difference is `records` when its events hash differs there, else `rules`. A pinned store's pin is read once: the
// pin's block hash with another events hash is PIN_DISPUTED. A reference is hostile input: each run is bounded in
// requests and time, each answer in bytes, and an answer that is not the documented shape ends the run as
// `unavailable`. Nothing here raises a level or counts as a witness's confirmation. A difference is acted on only when
// its first differing boundary stays the same over STREAK runs and the caller's recount from blocks settles it.
import { HASH_RE } from "@inversealtruism/cairnx-core";
import type { Gates } from "./gates.js";
import { cappedJson, either } from "./http.js";
import type { Tuple } from "./tuple.js";

/** `base`: the reference's prefix, under which `/cairnx/tuple/<height>[:<blockHash>]` answers (our front door's is
 *  `https://cairn-substrate.com/trade/api`); `timeoutMs` per request (default 5 s); `maxRequests` per run (default 16). */
export interface TupleReference { readonly base: string; readonly fetch?: typeof fetch; readonly timeoutMs?: number; readonly maxRequests?: number }
export type CompareKind = "equal" | "branch" | "records" | "rules" | "missing" | "unavailable";
/** The last comparison. `height`: the boundary compared, or for a difference the first boundary found to differ;
 *  `lastAgreeing`: the highest boundary below it found equal; `streak`: the runs in a row whose difference starts at
 *  that boundary; `sameOrigin`: the reference is on an origin the store is filled from, so it is no second source;
 *  `gates`: for `rules`, this package's gate table (the reference serves none); `recount`: what the recount from blocks
 *  gave at that boundary, when one ran. */
export interface CompareReport {
  readonly kind: CompareKind; readonly height: number; readonly lastAgreeing: number | null; readonly streak: number;
  readonly sameOrigin: boolean; readonly detail: string | null; readonly gates: Gates | null;
  readonly recount: "ours" | "reference" | "neither" | null;
}
/** Runs in a row with one first differing boundary before a recount may act (CONVENTION section 34.3). */
export const STREAK = 3;
/** The largest tuple answer read: the documented one is under 300 bytes. */
export const ANSWER_BYTES = 4096;
const RUN_MS = 20_000;

type Read = { kind: "tuple"; tuple: Tuple } | { kind: "absent" };
class RefusedAnswer extends Error {}
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const TUPLE_KEYS = "blockHash,eventsHash,height,ok,stateHash";

/** A reference's answer for `height` (and `hash`), or RefusedAnswer: 200 with exactly the documented tuple, at that
 *  height and that block hash when one was asked; 404 with the resolver's own `{ ok: false, error, height }`. */
function parseAnswer(status: number, body: unknown, height: number, hash: string | null): Read {
  if (status === 200 && isObject(body) && Object.keys(body).sort().join(",") === TUPLE_KEYS && body.ok === true && body.height === height &&
    [body.blockHash, body.eventsHash, body.stateHash].every((h) => typeof h === "string" && HASH_RE.test(h)) && (hash === null || body.blockHash === hash)) {
    return { kind: "tuple", tuple: { height, blockHash: body.blockHash as string, eventsHash: body.eventsHash as string, stateHash: body.stateHash as string } };
  }
  if (status === 404 && isObject(body) && body.ok === false && typeof body.error === "string" && body.height === height) return { kind: "absent" };
  throw new RefusedAnswer(`the reference's answer for ${height}${hash === null ? "" : `:${hash}`} is not a tuple or the resolver's 404 (status ${status})`);
}

/** What a run reads from the replica: held boundaries and their tuples (`tupleAt` may replay), the block hash held at a
 *  height, and the newest boundary with a known tuple (`newest`, no replay). */
export interface CompareView {
  heights(): number[]; tupleAt(height: number): Tuple | null; hashAt(height: number): string | null; newest(): Tuple | null;
  readonly pin: { readonly height: number; readonly blockHash: string; readonly eventsHash: string; readonly stateHash: string } | null;
}

/** The state of the comparison: `run` after each advance, `report`, `pinDisputed` and `owed` for status(), which reads
 *  no reference. `recount(height, signal)` gives the recount's tuple at a boundary, or null when it cannot; `rebuild`
 *  resets the store. Without `recount` a difference is reported and never acted on. A run reads the reference once for
 *  each new newest boundary: the pin while no answer at it has been equal, then the boundary. `owed` holds while the
 *  recount found the store wrong and its reset failed: the reset is tried again at the next new boundary. */
export function comparer(o: { ref: TupleReference; sameOrigin: boolean; gates: Gates; recount?: (height: number, signal: AbortSignal) => Promise<Tuple | null>; rebuild: () => Promise<void> }) {
  const f = o.ref.fetch ?? globalThis.fetch.bind(globalThis), base = o.ref.base.replace(/\/+$/, "");
  const timeoutMs = o.ref.timeoutMs ?? 5_000, maxRequests = o.ref.maxRequests ?? 16;
  let report: CompareReport | null = null, pinDisputed = false, pinAgreed = false, owed = false, compared: string | null = null;
  // The first differing boundary and the reference's tuple there, kept so the next run probes it alone.
  let first: { height: number; hash: string; theirs: Tuple; recounted: boolean } | null = null, agreed: { height: number; hash: string } | null = null;

  async function run(view: CompareView, signal: AbortSignal): Promise<void> {
    const deadlineAt = Date.now() + RUN_MS;
    let left = maxRequests;
    const read = async (height: number, hash: string | null): Promise<Read> => {
      if (left <= 0 || Date.now() >= deadlineAt) throw new RefusedAnswer("the run's request or time budget is spent");
      left--;
      const ms = Math.max(1, Math.min(timeoutMs, deadlineAt - Date.now())), timer = new AbortController();
      let t: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, no) => { t = setTimeout(() => { timer.abort(); no(new RefusedAnswer(`the reference did not answer within ${ms} ms`)); }, ms); });
      try {
        return await Promise.race([late, (async () => {
          const r = await f(`${base}/cairnx/tuple/${height}${hash === null ? "" : `:${hash}`}`, { signal: either(signal, timer.signal), cache: "no-store", redirect: "error" });
          return parseAnswer(r.status, await cappedJson(r, "a tuple answer", ANSWER_BYTES), height, hash);
        })()]);
      } finally { clearTimeout(t); }
    };
    const set = (r: Omit<CompareReport, "sameOrigin">) => { report = { ...r, sameOrigin: o.sameOrigin }; };
    const equal = (a: Tuple, b: Tuple) => a.blockHash === b.blockHash && a.eventsHash === b.eventsHash && a.stateHash === b.stateHash;
    try {
      const top = view.newest();
      if (top === null) return;
      const key = `${top.height}:${top.blockHash}`;
      if (key === compared) return;
      compared = key;
      if (owed) { await rebuild(); return; }
      // Only an equal answer at the pin is kept for good: one that differs is read again at the next new boundary, so a
      // reference that corrects itself lifts PIN_DISPUTED; a 404 there leaves the last answer's verdict.
      if (view.pin !== null && !pinAgreed) {
        const r = await read(view.pin.height, view.pin.blockHash);
        if (r.kind === "tuple") {
          pinDisputed = r.tuple.eventsHash !== view.pin.eventsHash;
          pinAgreed = !pinDisputed && r.tuple.stateHash === view.pin.stateHash;
        }
      }
      // A held boundary still on the chain the replica holds: one a rollback replaced is forgotten.
      const held = (x: { height: number; hash: string } | null) => (x !== null && view.hashAt(x.height) === x.hash ? x : null);
      agreed = held(agreed);
      if (first !== null && held(first) === null) first = null;
      if (first !== null) {
        const ours = view.tupleAt(first.height), r = ours === null ? null : await read(first.height, ours.blockHash);
        if (ours !== null && r?.kind === "tuple" && !equal(r.tuple, ours)) {
          first.theirs = r.tuple;
          const streak = (report?.streak ?? 0) + 1;
          set({ kind: r.tuple.eventsHash !== ours.eventsHash ? "records" : "rules", height: first.height, lastAgreeing: agreed?.height ?? null, streak,
            detail: null, gates: r.tuple.eventsHash !== ours.eventsHash ? null : o.gates, recount: report?.recount ?? null });
          await act(view, signal);
          return;
        }
        first = null;
      }
      const at = await read(top.height, top.blockHash);
      if (at.kind === "absent") {
        const any = await read(top.height, null);
        if (any.kind === "tuple" && any.tuple.blockHash === top.blockHash) throw new RefusedAnswer(`the reference answers ${top.height} by height with the block hash it refused`);
        set({ kind: any.kind === "tuple" ? "branch" : "missing", height: top.height, lastAgreeing: agreed?.height ?? null, streak: 0, detail: null, gates: null, recount: null });
        return;
      }
      if (equal(at.tuple, top)) {
        agreed = { height: top.height, hash: top.blockHash };
        set({ kind: "equal", height: top.height, lastAgreeing: top.height, streak: 0, detail: null, gates: null, recount: null });
        return;
      }
      // The first differing boundary: held boundaries between the last agreeing one and this, searched while each
      // probe answers; a probe the reference does not answer ends the search where it stands.
      const hs = view.heights().filter((h) => h > (agreed?.height ?? -1) && h < top.height);
      let lo = -1, hi = hs.length, theirs = at.tuple, why: string | null = null;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1, ours = view.tupleAt(hs[mid]!);
        if (ours === null) { why = `no state hash is held at ${hs[mid]}`; break; }
        let r: Read;
        try { r = await read(ours.height, ours.blockHash); } catch (e) { why = (e as Error).message; break; }
        if (r.kind === "absent") { why = `the reference does not hold ${ours.height}`; break; }
        if (equal(r.tuple, ours)) { lo = mid; agreed = { height: ours.height, hash: ours.blockHash }; } else { hi = mid; theirs = r.tuple; }
      }
      const height = hi < hs.length ? hs[hi]! : top.height, ours = height === top.height ? top : view.tupleAt(height)!;
      first = { height, hash: ours.blockHash, theirs, recounted: false };
      set({ kind: theirs.eventsHash !== ours.eventsHash ? "records" : "rules", height, lastAgreeing: agreed?.height ?? null, streak: 1, detail: why,
        gates: theirs.eventsHash !== ours.eventsHash ? null : o.gates, recount: null });
      await act(view, signal);
    } catch (e) {
      compared = null;   // compared again at the next run
      // The caller's abort concludes nothing; anything else thrown is a reference that did not answer as documented.
      if (signal.aborted) return;
      set({ kind: "unavailable", height: report?.height ?? -1, lastAgreeing: agreed?.height ?? null, streak: report?.streak ?? 0,
        detail: e instanceof Error ? e.message : String(e), gates: null, recount: report?.recount ?? null });
    }
  }

  // The store found wrong is reset; a reset that throws stays owed, and STORE_UNCONFIRMED holds until it succeeds.
  async function rebuild(): Promise<void> {
    try { await o.rebuild(); } catch (e) {
      owed = true;
      if (report !== null) report = { ...report, detail: `the store's reset failed (${e instanceof Error ? e.message : String(e)}); tried again at the next boundary` };
      return;
    }
    owed = false; first = null; agreed = null; compared = null;
  }

  // Only a difference whose first boundary held for STREAK runs, recounted once from blocks. Equal to the replica's
  // own tuple, the difference is confirmed and the replica keeps answering; equal to the reference's, the store is
  // rebuilt; neither, nothing changes.
  async function act(view: CompareView, signal: AbortSignal): Promise<void> {
    if (o.recount === undefined || first === null || first.recounted || report === null || report.streak < STREAK) return;
    first.recounted = true;
    const at = first, ours = view.tupleAt(at.height), theirs = at.theirs, got = await o.recount(at.height, signal);
    if (signal.aborted) { at.recounted = false; return; }   // an aborted recount settles nothing
    const same = (a: Tuple | null, b: Tuple | null) => a !== null && b !== null && a.blockHash === b.blockHash && a.eventsHash === b.eventsHash && a.stateHash === b.stateHash;
    const recount = same(got, ours) ? "ours" : same(got, theirs) ? "reference" : "neither";
    report = { ...report, recount };
    if (recount === "reference") await rebuild();
  }

  return { run, report: () => report, pinDisputed: () => pinDisputed, owed: () => owed };
}
