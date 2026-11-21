// A basis, its level and proof, and the name of the store kept under it. Every function here checks its basis first,
// so a value that bypassed the types (a pin over a feed) is refused at run time instead of answering level 3.
import { EPOCH_LEN, HASH_RE, canonicalJson, type EventRule } from "@inversealtruism/cairnx-core";
import { ReplicaConfigError } from "./errors.js";
import type { Basis, BlocksBasis, Cursor, HeaderRoot, Pin, RecordProof } from "./types.js";

const refuse = (what: string): never => { throw new ReplicaConfigError(`basis: ${what}`); };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const text = (v: unknown, what: string): string => (typeof v === "string" && v !== "" ? v : refuse(`${what} is not a non-empty string`));
const height = (v: unknown, what: string): number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : refuse(`${what} is not a safe integer >= 0`);
const hash = (v: unknown, what: string): string => (typeof v === "string" && HASH_RE.test(v) ? v : refuse(`${what} is not 0x and 64 lowercase hex`));
const cursor = (v: unknown, what: string): Cursor =>
  isObject(v) ? { height: height(v.height, `${what}.height`), hash: hash(v.hash, `${what}.hash`) } : refuse(`${what} is not a cursor`);

function rootOf(v: unknown): HeaderRoot {
  if (!isObject(v)) return refuse("root is not an object");
  if (v.kind === "own-node") return { kind: "own-node", node: text(v.node, "root.node") };
  if (v.kind === "anchor") return { kind: "anchor", anchor: cursor(v.anchor, "root.anchor") };
  if (v.kind === "caller") return { kind: "caller", floor: height(v.floor, "root.floor"), origin: text(v.origin, "root.origin") };
  return refuse(`root kind ${String(v.kind)} is unknown`);
}
const blocksOf = (v: Record<string, unknown>): BlocksBasis => ({ kind: "blocks", root: rootOf(v.root), bodies: text(v.bodies, "bodies") });

/** `v` as a basis holding only its own fields, or a ReplicaConfigError naming the rule it breaks. Only blocks sit above
 *  a pin, and an anchor root under a pin is the pin. */
export function checkBasis(v: unknown): Basis {
  if (!isObject(v)) return refuse("not an object");
  if (v.kind === "display") return { kind: "display", origin: text(v.origin, "origin") };
  if (v.kind === "feed") {
    return { kind: "feed", feed: text(v.feed, "feed"), inclusion: typeof v.inclusion === "boolean" ? v.inclusion : refuse("inclusion is not a boolean") };
  }
  if (v.kind === "blocks") return blocksOf(v);
  if (v.kind !== "pinned") return refuse(`kind ${String(v.kind)} is unknown`);
  const pin = cursor(v.pin, "pin"), above = v.above;
  if (!isObject(above) || above.kind !== "blocks") return refuse(`only blocks sit above a pin, not ${isObject(above) ? String(above.kind) : String(above)}`);
  const blocks = blocksOf(above), r = blocks.root;
  if (r.kind === "anchor" && (r.anchor.height !== pin.height || r.anchor.hash !== pin.hash)) refuse("an anchor root under a pin is the pin");
  return { kind: "pinned", pin, logSha256: hash(v.logSha256, "logSha256"), above: blocks };
}

/** The level of every answer read under `b` (CONVENTION section 37): a display 1; a feed 1, or 2 with inclusion
 *  proofs; blocks 3; a pin 3, since only blocks sit above it. */
export function levelOf(b: Basis): 1 | 2 | 3 {
  const c = checkBasis(b);
  return c.kind === "display" ? 1 : c.kind === "feed" ? (c.inclusion ? 2 : 1) : 3;
}

/** The proof of the records read under `b`; under a pin, the release's log is the weakest. */
export function proofOf(b: Basis): RecordProof {
  const c = checkBasis(b);
  if (c.kind === "display") return "served";
  if (c.kind === "feed") return c.inclusion ? "inclusion" : "served";
  return c.kind === "blocks" ? "inclusion" : "pinned";
}

/** The name of the store kept under `b`: its canonical JSON without the pin (the pin's cursor, its log hash, and an
 *  anchor root, which under a pin is the pin), so a newer pin over the same root and bodies names the same store. */
export function basisKey(b: Basis): string {
  const c = checkBasis(b);
  if (c.kind !== "pinned") return canonicalJson(c);
  const { root, bodies } = c.above;
  return canonicalJson({ kind: "pinned", above: { kind: "blocks", root: root.kind === "anchor" ? { kind: "anchor" } : root, bodies } });
}

/** Why headers from `root` cannot give every event above `floor`, the pin or the activation height less one, or null
 *  (design section 2): an anchor must lie at or below it (under a pin an anchor root is the pin itself), and so must
 *  a caller's floor. One's own node is read from the activation height. */
export function floorBreak(root: HeaderRoot, floor: number, rule: EventRule): string | null {
  const what = floor === rule.activationHeight - 1 ? "the activation height less one" : `the pin ${floor}`;
  if (root.kind === "anchor" && root.anchor.height > floor) return `the anchor ${root.anchor.height} lies above ${what}`;
  if (root.kind === "caller" && root.floor > floor) return `the caller's headers start at ${root.floor}, above ${what}`;
  return null;
}

/** Whether two bases are the same value, the pin included. */
export const sameBasis = (a: Basis, b: Basis): boolean => canonicalJson(checkBasis(a)) === canonicalJson(checkBasis(b));

/** What a store's rows give at a height, each null above its cursor. */
export interface RowsAt {
  readonly cursor: Cursor | null;
  hashAt(height: number): string | null; eventsHashAt(height: number): string | null; logSha256At(height: number): string | null;
}

/** Whether a store filled under `stored` is kept under `wanted`, the one exception to the rule that another basis resets
 *  it (design section 5): both are pinned with one key, `wanted`'s pin lies above `stored`'s, the store's cursor is at
 *  or above it, and the rows give its block hash, its events hash (`eventsHash`, the wanted pin's) and its log's
 *  sha256. The state at the pin is replayed at the bind, as for every reopen under a pin (pinned.ts). */
export function keepsStore(stored: Basis, wanted: Basis, eventsHash: string | null, rows: RowsAt): boolean {
  const s = checkBasis(stored), w = checkBasis(wanted);
  if (s.kind !== "pinned" || w.kind !== "pinned" || basisKey(s) !== basisKey(w) || !(w.pin.height > s.pin.height)) return false;
  const h = w.pin.height;
  return rows.cursor !== null && rows.cursor.height >= h && rows.hashAt(h) === w.pin.hash && eventsHash !== null && rows.eventsHashAt(h) === eventsHash &&
    rows.logSha256At(h) === w.logSha256;
}

/** `v` as a pin holding only its own fields, or a ReplicaConfigError naming the rule it breaks: format 1, a rule, a
 *  height at an epoch boundary at or above the rule's activation, four hashes in form, a gate table, a core version
 *  and a log function. It checks the form only; pinned() checks the log against it. */
export function checkPin(v: unknown): Pin {
  if (!isObject(v) || v.format !== 1) return refuse("the pin's format is not 1");
  const r = isObject(v.rule) ? v.rule : refuse("pin.rule is not an object");
  const rule = { domain: text(r.domain, "pin.rule.domain"), activationHeight: height(r.activationHeight, "pin.rule.activationHeight") };
  const h = height(v.height, "pin.height");
  if (h % EPOCH_LEN !== 0 || h < rule.activationHeight) refuse(`pin.height ${h} is not an epoch boundary at or above the activation height`);
  const g = isObject(v.gates) ? v.gates : refuse("pin.gates is not an object"), gates: Record<string, number> = {};
  for (const [k, x] of Object.entries(g)) gates[k] = height(x, `pin.gates.${k}`);
  const log = typeof v.log === "function" ? (v.log as Pin["log"]) : refuse("pin.log is not a function");
  return Object.freeze({
    format: 1, rule: Object.freeze(rule), height: h, blockHash: hash(v.blockHash, "pin.blockHash"), logSha256: hash(v.logSha256, "pin.logSha256"),
    eventsHash: hash(v.eventsHash, "pin.eventsHash"), stateHash: hash(v.stateHash, "pin.stateHash"), gates: Object.freeze(gates),
    core: text(v.core, "pin.core"), log,
  });
}
