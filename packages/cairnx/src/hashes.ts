// CONVENTION §34: the state hash and the events hash two replicas compare at one block. Values cross the boundary as
// `0x` and lowercase hex only, the forms of §33.4, so that equal strings are equal bytes; any other form is refused,
// since resolve() compares ids as text and two lists that differ only in case can resolve differently.
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@inversealtruism/csd-codec";
// csd-codec exports no single sha256; this is the noble release codec itself pins.
import { sha256 } from "@noble/hashes/sha256";
import { canonicalState } from "./resolve.js";
import { ADDR_RE, HASH_RE, type AttestEvent, type CairnXState, type ProposeEvent } from "./types.js";

/** The fields of an event the events hash reads; a ChainEvent is one. */
export type HashedEvent =
  | Pick<ProposeEvent, "kind" | "id" | "proposer" | "height" | "pos">
  | Pick<AttestEvent, "kind" | "txid" | "attester" | "height" | "pos">;

/** The events hash before the first block that holds an event: 32 zero bytes. */
export const EVENTS_HASH_START = "0x" + "00".repeat(32);

/** How far below its tip a replica holds an epoch boundary before it publishes or compares the tuple there (§38). It
 *  is the depth replicas compare at, not a bound on how deep a reorganisation can reach. */
export const FINAL_DEPTH = 12;

const fail = (what: string): never => { throw new Error(`events hash: ${what}`); };
const hex = (b: Uint8Array): string => "0x" + bytesToHex(b);

function bytesOf(v: unknown, re: RegExp, what: string): Uint8Array {
  return typeof v === "string" && re.test(v) ? hexToBytes(v.slice(2)) : fail(`${what} is not 0x and lowercase hex of its length`);
}

/** sha256 of the UTF-8 bytes of canonicalState(state), `0x` and lowercase hex (§34.1). */
export function stateHash(state: CairnXState): string {
  return hex(sha256(utf8ToBytes(canonicalState(state))));
}

// One row of §34.2: position (4 bytes big endian), transaction id (32 bytes), author (20 bytes).
function rowOf(e: HashedEvent, height: number): { pos: number; row: Uint8Array } {
  const kind: unknown = (e as { kind?: unknown } | null)?.kind;
  if (kind !== "propose" && kind !== "attest") return fail("an event's kind is neither propose nor attest");
  if (e.height !== height) fail(`an event at height ${String(e.height)} is in the block at ${height}`);
  if (!Number.isInteger(e.pos) || e.pos < 0 || e.pos > 0xffff_ffff) fail("an event's position is not an integer in [0, 2^32 - 1]");
  const p = e as Pick<ProposeEvent, "id" | "proposer">, a = e as Pick<AttestEvent, "txid" | "attester">;
  const id = bytesOf(kind === "propose" ? p.id : a.txid, HASH_RE, "an event's transaction id");
  const author = bytesOf(kind === "propose" ? p.proposer : a.attester, ADDR_RE, "an event's author");
  const row = new Uint8Array(56);
  new DataView(row.buffer).setUint32(0, e.pos);
  row.set(id, 4);
  row.set(author, 36);
  return { pos: e.pos, row };
}

/** The events hash after one block (§34.2) from the value `prev`: `events` are that block's, in any order, hashed in
 *  ascending position. A block without events leaves `prev`. The previous block's height is not an input, so a caller
 *  that steps block by block keeps the blocks in ascending height itself. */
export function eventsHashStep(prev: string, height: number, events: readonly HashedEvent[]): string {
  const e = bytesOf(prev, HASH_RE, "the previous value");
  if (!Number.isSafeInteger(height) || height < 0) fail("height is not an integer in [0, 2^53 - 1]");
  if (!Array.isArray(events)) fail("events is not a list");
  if (events.length === 0) return prev;
  const rows = events.map((x) => rowOf(x, height)).sort((x, y) => x.pos - y.pos);
  for (let i = 1; i < rows.length; i++) if (rows[i]!.pos === rows[i - 1]!.pos) fail(`position ${rows[i]!.pos} is repeated in the block`);
  const head = new Uint8Array(8);
  new DataView(head.buffer).setBigUint64(0, BigInt(height));
  const b = sha256(concatBytes(head, ...rows.map((r) => r.row)));
  return hex(sha256(concatBytes(e, b)));
}

/** The events hash over a list from the start value (§34.2): the list is in the order of §33.3, or in one that differs
 *  from it only within a block, so each height forms one run. A height below the run before it is refused, never
 *  sorted: resolve() sorts its input, this function does not. */
export function eventsHash(events: readonly HashedEvent[]): string {
  if (!Array.isArray(events)) fail("events is not a list");
  let value = EVENTS_HASH_START, last = -1;
  for (let i = 0; i < events.length;) {
    const height = (events[i] as { height?: unknown } | null)?.height as number;
    let j = i + 1;
    while (j < events.length && (events[j] as { height?: unknown } | null)?.height === height) j++;
    value = eventsHashStep(value, height, events.slice(i, j));
    if (height < last) fail(`height ${height} follows height ${last}`);
    last = height;
    i = j;
  }
  return value;
}
