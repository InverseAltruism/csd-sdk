// The rows hash: a running digest over the full content of a store's rows, so that no row read back reaches resolve()
// changed in any field. The events hash (CONVENTION section 34.2) covers each event's height, position, id and author
// only; the rows hash covers every field of every event, in stored order, with the row's height and block hash.
import { payloadHash } from "@inversealtruism/cairnx-core";
import type { BlockRow } from "./types.js";

/** The rows hash before the first row: 32 zero bytes. */
export const ROWS_HASH_START = "0x" + "00".repeat(32);

/** The rows hash after `row` from the value `prev`: sha256 over the UTF-8 bytes of canonicalJson({ prev, height, hash,
 *  events }), which is what payloadHash computes. Rows follow in ascending height. Throws on an event field that is
 *  no JSON data. */
export const rowsHashStep = (prev: string, row: Pick<BlockRow, "height" | "hash" | "events">): string =>
  payloadHash({ prev, height: row.height, hash: row.hash, events: row.events });
