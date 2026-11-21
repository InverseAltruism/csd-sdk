// The loop's contract with a source for the blocks of one step (design section 4): heights strictly ascending above
// the cursor and at or above the activation height; every event at its block's height, in the order of CONVENTION
// section 33.3; no event id held already (section 33.2); every Attest on a held Propose or a Propose of its block;
// the cursor at or above the last block. The block checks also run over a store's rows when they are read back
// (held.ts).
import { EPOCH_LEN, HASH_RE, eventsHashStep, type EventRule, type EventsSoFar } from "@inversealtruism/cairnx-core";
import { applyOrder, eventId } from "./order.js";
import { rowsHashStep } from "./rowshash.js";
import { stepSofar } from "./sofar.js";
import type { BlockEvents, BlockRow, Cursor, Step, StepContext } from "./types.js";

type Refused = { ok: false; reason: string };

/** The lowest height a step may roll back to (StepContext.floor): the pin, else the activation height less one. */
export const floorOf = (ctx: Pick<StepContext, "floor" | "rule">): number => ctx.floor ?? ctx.rule.activationHeight - 1;
type From = { after: number; eventsHash: string; rowsHash: string; sofar: EventsSoFar; rule: EventRule };

function blockBreak(b: BlockEvents, after: number, seen: ReturnType<typeof stepSofar>, rule: EventRule): string | null {
  if (!Number.isSafeInteger(b.height) || b.height <= after) return `it is not above ${after}`;
  if (b.height < rule.activationHeight) return `it lies below the activation height ${rule.activationHeight}`;
  if (b.hash !== null && !HASH_RE.test(b.hash)) return "its hash is not 0x and 64 lowercase hex";
  for (let i = 0; i < b.events.length; i++) {
    const e = b.events[i]!, id = eventId(e);
    if (i > 0 && applyOrder(b.events[i - 1]!, e) >= 0) return `event ${id} is out of the order of section 33.3`;
    if (seen.view.eventIds.has(id)) return `event ${id} is held already`;
    // Proposes precede Attests in the order just checked, so the Proposes of this block are in `seen` by now.
    if (e.kind === "attest" && !seen.view.proposeIds.has(e.proposalId)) return `attest ${id} is on ${e.proposalId}, which is no held Propose`;
    seen.add([e]);
  }
  return null;
}

/** The rows a step's `blocks` commit, with the events hash stepped from `eventsHash` after each block and the rows hash
 *  from `rowsHash` after each row, or the first rule they break. A row is kept for each block that holds an event or
 *  lies at an epoch boundary, so that the boundary's block hash is held until the boundary is deep enough to add.
 *  Throws where eventsHashStep does (an event at another height than its block's, a position repeated in a block, an
 *  id or author out of form), where rowsHashStep does, and on a value outside the types; the loop refuses a step that
 *  throws as one that breaks a rule. */
export function checkBlocks(blocks: readonly BlockEvents[], o: From): { ok: true; rows: BlockRow[]; eventsHash: string; rowsHash: string } | Refused {
  const seen = stepSofar(o.sofar), rows: BlockRow[] = [];
  let after = o.after, eventsHash = o.eventsHash, rowsHash = o.rowsHash;
  for (const b of blocks) {
    const why = blockBreak(b, after, seen, o.rule);
    if (why !== null) return { ok: false, reason: `block ${b.height}: ${why}` };
    eventsHash = eventsHashStep(eventsHash, b.height, b.events);
    if (b.events.length > 0 || b.height % EPOCH_LEN === 0) {
      rowsHash = rowsHashStep(rowsHash, b);
      rows.push({ height: b.height, hash: b.hash, events: b.events, eventsHash, rowsHash });
    }
    after = b.height;
  }
  return { ok: true, rows, eventsHash, rowsHash };
}

/** checkBlocks over a `blocks` step, then its cursor: above `after` and at or above the last block. A store's cursor
 *  carries a hash, so a cursor without one cannot be committed and is refused. */
export function checkStep(s: Extract<Step, { kind: "blocks" }>, o: From): { ok: true; rows: BlockRow[]; cursor: Cursor } | Refused {
  const c = checkBlocks(s.blocks, o);
  if (!c.ok) return c;
  const { height, hash } = s.cursor, last = s.blocks.at(-1)?.height ?? o.after;
  if (!Number.isSafeInteger(height) || height <= o.after || height < last) {
    return { ok: false, reason: `the cursor ${height} is not above ${o.after} and at or above its last block ${last}` };
  }
  if (hash === null || !HASH_RE.test(hash)) return { ok: false, reason: "the cursor's hash is not 0x and 64 lowercase hex" };
  return { ok: true, rows: c.rows, cursor: { height, hash } };
}

/** Why a reorg to `to` is refused, or null: it must land below the cursor, at or above the floor, and on the hash the
 *  loop holds at that height when it holds one. */
export function reorgBreak(to: Cursor, at: Cursor | null, floor: number, hashAt: (height: number) => string | null): string | null {
  if (at === null) return "there is no cursor to roll back";
  if (!Number.isSafeInteger(to.height) || to.height >= at.height || to.height < floor) {
    return `a reorg to ${to.height} is not below the cursor ${at.height} and at or above the floor ${floor}`;
  }
  return HASH_RE.test(to.hash) && (hashAt(to.height) ?? to.hash) === to.hash ? null : `a reorg to ${to.height} is not to the hash held there`;
}
