// pinned: a release's log of one rule's events at or below its pin, then complete blocks above it (design section 2).
// The first step checks, before anything is committed, in order: the pin's rule against the store's, the log's sha256,
// that the log is the canonical JSON of an event list keeping the loop's contract (contract.ts) at or below the pin,
// its events hash, the gate table cut at the pin, and its state hash. It then takes `then`'s step from the pin, whose
// root checks the pin's block hash: one's own node links the block above to it, an anchor root's seed must end at it,
// a caller's headers must hold it; a root whose tip is below the pin cannot, and the step is SOURCE_UNAVAILABLE. The
// log's rows and that step are one step, so one commit. A reorg below the pin or to its height with another hash, and
// a chain that does not hold the pin's block, are PIN_OFF_CHAIN. A store that already holds the pin's rows is bound to
// the descriptor once per source instead, without reading the log: the block hash, events hash and state hash its rows
// give at the pin, and the gate table. A refusal of the pin (PIN_MISMATCH, PIN_OFF_CHAIN, RULES_DIFFER) is the answer
// to every later step of this source: none clears it.
import * as loaded from "@inversealtruism/cairnx-core";
import { EVENTS_HASH_START, canonicalJson, resolve, stateHash, type ChainEvent, type EventRule, type EventsSoFar } from "@inversealtruism/cairnx-core";
import { verifyContentBytes } from "@inversealtruism/csd-codec";
import { checkBasis, checkPin } from "./basis.js";
import { checkBlocks, sameRule } from "./contract.js";
import { messageOf } from "./errors.js";
import { gatesDiffer, gatesOf } from "./gates.js";
import { ROWS_HASH_START } from "./rowshash.js";
import { stepSofar } from "./sofar.js";
import type { BlockEvents, BlocksSource, Cursor, Pin, Source, SourceCode, Step } from "./types.js";

type Logged = { readonly blocks: BlockEvents[]; readonly sofar: EventsSoFar };
const cannot = (code: SourceCode, reason: string): Extract<Step, { kind: "cannot" }> => ({ kind: "cannot", code, reason, retryAfterMs: null });

// The log's events grouped into blocks in ascending height, the pin's block last with its hash.
function blocksOf(events: readonly ChainEvent[], pin: Cursor): BlockEvents[] {
  const out: BlockEvents[] = [];
  for (const e of events) {
    if (!(e.height <= pin.height)) throw new Error(`an event at ${String(e.height)} lies above the pin ${pin.height}`);
    const last = out.at(-1);
    if (last?.height === e.height) last.events.push(e); else out.push({ height: e.height, hash: null, events: [e] });
  }
  const top = out.at(-1);
  if (top?.height === pin.height) out[out.length - 1] = { ...top, hash: pin.hash }; else out.push({ height: pin.height, hash: pin.hash, events: [] });
  return out;
}

/** A source of `pin`'s log, then `then`'s complete blocks above the pin. Throws ReplicaConfigError for a pin out of
 *  form or a `then` whose basis cannot sit above it. */
export function pinned(o: { readonly pin: Pin; readonly then: BlocksSource }): Source {
  const pin = checkPin(o.pin), at: Cursor = { height: pin.height, hash: pin.blockHash }, then = o.then;
  const basis = checkBasis({ kind: "pinned", pin: at, logSha256: pin.logSha256, above: then.basis });
  let refused: Step | null = null, logged: Promise<Logged | Step> | null = null, bound = false;
  const refuse = (code: SourceCode, reason: string): Step => (refused = cannot(code, reason));

  async function load(rule: EventRule): Promise<Logged | Step> {
    if (!sameRule(pin.rule, rule)) return refuse("PIN_MISMATCH", `the pin is of ${pin.rule.domain} from ${pin.rule.activationHeight}, the store's rule is not`);
    let bytes: unknown;
    try { bytes = await pin.log(); } catch (e) { return cannot("SOURCE_UNAVAILABLE", `the pin's log: ${messageOf(e)}`); }
    if (!(bytes instanceof Uint8Array) || !verifyContentBytes(bytes, pin.logSha256)) return refuse("PIN_MISMATCH", "the log's sha256 is not the pin's");
    let events: ChainEvent[], blocks: BlockEvents[], c: ReturnType<typeof checkBlocks>;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes), v: unknown = JSON.parse(text);
      if (!Array.isArray(v) || canonicalJson(v) !== text) return refuse("PIN_MISMATCH", "the log is not the canonical JSON of an event list");
      events = v as ChainEvent[];
      blocks = blocksOf(events, at);
      c = checkBlocks(blocks, { after: rule.activationHeight - 1, eventsHash: EVENTS_HASH_START, rowsHash: ROWS_HASH_START, sofar: stepSofar({ eventIds: new Set(), proposeIds: new Set() }).view, rule });
    } catch (e) {
      return refuse("PIN_MISMATCH", `the log: ${messageOf(e)}`);
    }
    if (!c.ok) return refuse("PIN_MISMATCH", `the log: ${c.reason}`);
    if (c.eventsHash !== pin.eventsHash) return refuse("PIN_MISMATCH", "the log's events hash is not the pin's");
    if (gatesDiffer(pin.gates, gatesOf(loaded), pin.height)) return refuse("RULES_DIFFER", `the pin's gate table differs from the loaded core's at or below ${pin.height}`);
    let state: string;
    try { state = stateHash(resolve(events, pin.height)); } catch (e) { return refuse("PIN_MISMATCH", `the log does not resolve: ${messageOf(e)}`); }
    if (state !== pin.stateHash) return refuse("PIN_MISMATCH", "the log's state hash is not the pin's");
    const sofar = stepSofar({ eventIds: new Set(), proposeIds: new Set() });
    sofar.add(events);
    return { blocks, sofar: sofar.view };
  }

  // `then`'s step asked from a cursor at `from`, as the pin's refusal when it shows the chain does not hold the pin.
  function offChain(s: Step, from: number): Step | null {
    const off = s.kind === "reorg" ? s.to.height < at.height || (s.to.height === at.height && s.to.hash !== at.hash)
      : s.kind === "cannot" && (s.code === "PIN_OFF_CHAIN" || (s.code === "BRANCH_MOVED" && from === at.height));
    return off ? refuse("PIN_OFF_CHAIN", `the chain does not hold the pin's block ${at.height} ${at.hash}${s.kind === "cannot" ? ` (${s.reason})` : ""}`) : null;
  }

  return {
    basis, floor: at, rule: pin.rule,
    tip: (signal) => then.tip(signal),
    async next(ctx) {
      if (refused !== null) return refused;
      if (ctx.cursor !== null) {
        if (ctx.cursor.height < at.height) return cannot("SOURCE_MALFORMED", `the store's cursor ${ctx.cursor.height} lies below the pin ${at.height}`);
        if (!bound) {
          const wrong = [ctx.hashAt(at.height) === at.hash ? "" : "block hash", ctx.eventsHashAt(at.height) === pin.eventsHash ? "" : "events hash",
            ctx.stateHashAt?.(at.height) === pin.stateHash ? "" : "state hash"].filter((x) => x !== "");
          if (wrong.length > 0) return refuse("PIN_MISMATCH", `the store's rows at the pin give another ${wrong.join(", ")} than the pin`);
          if (gatesDiffer(pin.gates, gatesOf(loaded), at.height)) return refuse("RULES_DIFFER", `the pin's gate table differs from the loaded core's at or below ${at.height}`);
          bound = true;
        }
        const s = await then.next(ctx);
        return offChain(s, ctx.cursor.height) ?? s;
      }
      const l = await (logged ??= load(ctx.rule));
      if ("kind" in l) { if (refused === null) logged = null; return l; }
      const s = await then.next({ ...ctx, cursor: at, sofar: l.sofar, floor: at.height, hashAt: (h) => (h === at.height ? at.hash : null),
        eventsHashAt: (h) => (h === at.height ? pin.eventsHash : null) });
      const off = offChain(s, at.height);
      if (off !== null || s.kind === "cannot" || s.kind === "reorg") return off ?? s;
      if (s.kind === "idle" && s.tip.height < at.height) return cannot("SOURCE_UNAVAILABLE", `the root's tip ${s.tip.height} is below the pin ${at.height}`);
      return s.kind === "idle" ? { kind: "blocks", blocks: l.blocks, cursor: at, tip: s.tip } : { ...s, blocks: [...l.blocks, ...s.blocks] };
    },
  };
}
