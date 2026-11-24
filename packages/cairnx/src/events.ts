// CONVENTION §33: the rule that turns the chain's blocks into the events resolve() replays. The author of an event is
// an input the caller binds (csd-crypto authorOf over the coin the first input spends): this module holds no signature
// code and reads no chain. Whether a sparse list holds every transaction with an app payload is the caller's to know.
import { isWellFormedUtf16, type App, type TxOutput } from "@inversealtruism/csd-codec";
import { paidToFromOutputs } from "./paidto.js";
import { ACTIVATION_HEIGHT, DOMAIN, type ChainEvent } from "./types.js";

/** The domain and the activation height the rule selects for. */
export interface EventRule { readonly domain: string; readonly activationHeight: number }
/** CairnX: `cairnx:v1` from height 29,860. */
export const CAIRNX_EVENT_RULE: EventRule = Object.freeze({ domain: DOMAIN, activationHeight: ACTIVATION_HEIGHT });

/** One mined transaction: its position in the block (the coinbase is 0), its txid, and its body decoded with u64
 *  values exact (a bigint, or a number up to 2^53). csd-light's BoundTx is one. */
export interface EventRuleTx {
  readonly pos: number;
  readonly txid: string;
  readonly tx: { readonly app: App; readonly outputs: readonly TxOutput[] };
}

/** The caller's record of the events below the block it reads, rolled back with them on a reorganisation: every event
 *  id (a Propose's id, an Attest's txid, `0x` and lowercase hex) and the Propose ids among them. */
export interface EventsSoFar {
  readonly eventIds: { has(id: string): boolean };
  readonly proposeIds: { has(id: string): boolean };
}

/** A transaction of a block that is an event, so its author must be bound. */
export interface EventMember<T extends EventRuleTx> { readonly kind: "propose" | "attest"; readonly item: T }

type ProposeApp = Extract<App, { type: "Propose" }>;
type AttestApp = Extract<App, { type: "Attest" }>;

const fail = (what: string): never => { throw new Error(`events rule: ${what}`); };
/** A position or height the rule takes: a safe integer >= 0. A held replay context and a reader of served positions
 *  (the replica's Scanner) check an event's position with it. */
export const isIndex = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

function hexOf(v: unknown, bytes: number, what: string): string {
  const h = typeof v === "string" && v.startsWith("0x") ? v.slice(2) : v;
  if (typeof h !== "string" || h.length !== bytes * 2 || !/^[0-9a-fA-F]*$/.test(h)) return fail(`${what} is not ${bytes}-byte hex`);
  return "0x" + h.toLowerCase();
}

// A number is accepted up to 2^53 only: 2^53 is the rule's own form of a clamped expiry, and above it a double no longer
// identifies one u64.
function u64Of(v: unknown, what: string): bigint | number {
  if (typeof v === "bigint" && v >= 0n && v < 1n << 64n) return v;
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 2 ** 53) return v;
  if (typeof v === "number" && Number.isInteger(v) && v > 2 ** 53) return fail(`${what} above 2^53 must be passed as a bigint`);
  return fail(`${what} is not a u64`);
}

function u32Of(v: unknown, what: string): number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffff_ffff ? v : fail(`${what} is not a u32`);
}

function checkRule(rule: EventRule): void {
  const d: unknown = rule?.domain;
  if (typeof d !== "string" || d === "" || !isWellFormedUtf16(d) || d.includes("\u0000") || d.includes("\u0001"))
    fail("the rule's domain must be non-empty, well-formed text without U+0000 or U+0001");
  if (!isIndex(rule.activationHeight)) fail("the rule's activation height must be a safe integer >= 0");
}
const kindOf = (app: unknown): "none" | "propose" | "attest" => {
  const t: unknown = (app as { type?: unknown } | null | undefined)?.type;
  return t === "None" ? "none" : t === "Propose" ? "propose" : t === "Attest" ? "attest" : fail(`unknown app type ${String(t)}`);
};
const domainOf = (app: ProposeApp): string => (typeof app.domain === "string" ? app.domain : fail("a Propose domain is not text"));

function paidToOf(outputs: readonly TxOutput[]): Record<string, string> {
  if (!Array.isArray(outputs)) fail("outputs is not a list");
  const counted: { addr: string; value: number }[] = [];
  for (const o of outputs) {
    const addr = hexOf(o?.scriptPubkey, 20, "script_pubkey"), value = u64Of(o?.value, "output value");
    if (value <= Number.MAX_SAFE_INTEGER) counted.push({ addr, value: Number(value) });
  }
  return paidToFromOutputs(counted);
}

/** The event of one transaction at `height`, or null when it carries no app payload, lies below the activation height
 *  or is a Propose in another domain. Attest membership needs the block and is not decided here: an Attest maps to an
 *  event whatever its proposal, and a per-transaction caller decides membership itself (resolve() ignores an Attest on
 *  a proposal it does not hold). Throws on a field out of its consensus type, a payload at position 0, or an event's
 *  author that is not an address. */
export function eventOfTx(t: EventRuleTx, height: number, author: string, rule: EventRule = CAIRNX_EVENT_RULE): ChainEvent | null {
  checkRule(rule);
  if (!isIndex(height)) fail("height is not a safe integer >= 0");
  if (!isIndex(t?.pos)) fail("pos is not a safe integer >= 0");
  const txid = hexOf(t.txid, 32, "txid");
  const app = t.tx?.app;
  const kind = kindOf(app);
  if (kind === "none" || height < rule.activationHeight) return null;
  if (t.pos === 0) fail("position 0 is the coinbase, which carries no app payload");
  if (kind === "propose" && domainOf(app as ProposeApp) !== rule.domain) return null;
  const paidTo = paidToOf(t.tx.outputs), who = hexOf(author, 20, "author");
  if (kind === "propose") {
    const p = app as ProposeApp;
    const uri: unknown = p.uri;
    if (typeof uri !== "string" || !isWellFormedUtf16(uri)) return fail("uri is not well-formed text");
    const e = u64Of(p.expiresEpoch, "expiresEpoch");
    return {
      kind: "propose", id: txid, proposer: who, uri: uri.replaceAll("\u0000", "\u0001"), payloadHash: hexOf(p.payloadHash, 32, "payloadHash"),
      expiresEpoch: e <= Number.MAX_SAFE_INTEGER ? Number(e) : 2 ** 53, height, pos: t.pos, paidTo,
    };
  }
  const a = app as AttestApp;
  return {
    kind: "attest", txid, proposalId: hexOf(a.proposalId, 32, "proposalId"), attester: who,
    score: u32Of(a.score, "score"), confidence: u32Of(a.confidence, "confidence"), height, pos: t.pos, paidTo,
  };
}

/** The members of one block in position order: the transactions whose authors the caller binds. `txs` lists, in
 *  strictly increasing position order, every transaction of the block that carries an app payload (a complete block
 *  is one such list). Throws on a list that is no block of the chain: positions out of order, a txid repeated, a
 *  payload at position 0. Nothing of a block below the activation height is read. */
export function blockMembers<T extends EventRuleTx>(height: number, txs: readonly T[], sofar: EventsSoFar, rule: EventRule = CAIRNX_EVENT_RULE): EventMember<T>[] {
  checkRule(rule);
  if (!isIndex(height)) fail("height is not a safe integer >= 0");
  if (height < rule.activationHeight) return [];
  if (!Array.isArray(txs)) fail("txs is not a list");
  const ids = new Set<string>(), proposals = new Set<string>();
  const read: { item: T; kind: "propose" | "attest"; id: string; proposal?: string }[] = [];
  let last = -1;
  for (const item of txs) {
    if (!isIndex(item?.pos) || item.pos <= last) fail("positions are not safe integers >= 0 in strictly increasing order");
    last = item.pos;
    const id = hexOf(item.txid, 32, "txid");
    if (ids.has(id)) fail(`txid ${id} is repeated in the block`);
    ids.add(id);
    const kind = kindOf(item.tx?.app);
    if (kind === "none") continue;
    if (item.pos === 0) fail("position 0 is the coinbase, which carries no app payload");
    if (kind === "propose") {
      if (domainOf(item.tx.app as ProposeApp) !== rule.domain || sofar.eventIds.has(id)) continue;
      proposals.add(id);
      read.push({ item, kind, id });
    } else read.push({ item, kind, id, proposal: hexOf((item.tx.app as AttestApp).proposalId, 32, "proposalId") });
  }
  // An Attest may precede its Propose in the block: proposals apply first (C5), so membership waits for the whole list.
  return read
    .filter((r) => r.kind === "propose" || (!sofar.eventIds.has(r.id) && (sofar.proposeIds.has(r.proposal!) || proposals.has(r.proposal!))))
    .map((r) => ({ kind: r.kind, item: r.item }));
}

/** The block's events in apply order (Proposes by position, then Attests by position), `authors[i]` being the author
 *  of `blockMembers(...)[i]`. The members are selected again here, so an author list that does not match them throws:
 *  a member whose author cannot be bound leaves the block without events, never without that event. */
export function blockEvents(height: number, txs: readonly EventRuleTx[], sofar: EventsSoFar, authors: readonly string[], rule: EventRule = CAIRNX_EVENT_RULE): ChainEvent[] {
  const members = blockMembers(height, txs, sofar, rule);
  if (!Array.isArray(authors) || authors.length !== members.length) fail(`the block has ${members.length} members, not ${authors?.length} authors`);
  const events = members.map((m, i) => eventOfTx(m.item, height, authors[i]!, rule) ?? fail("a member mapped to no event"));
  return [...events.filter((e) => e.kind === "propose"), ...events.filter((e) => e.kind === "attest")];
}
