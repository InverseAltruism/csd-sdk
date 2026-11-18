// Each row type's exact field set, pinned twice: at compile time each spec below has exactly the type's keys, the same
// optionality and the JSON kind its type implies; at run time every row derived from the replayed corpus has only
// those fields, of those kinds, every required one, and the nested objects the note fixes (give, want, fill, profile)
// one level deeper. The counts and the event rows are checked against the corpus records and the resolver's own
// state, not against the rows this test derived. The fields the corpus never exercises are listed and pinned.
import { REASON_CODES, type BidState, type ChainEvent, type FillEntry, type Give, type OfferState } from "@inversealtruism/cairnx-core";
import type { BidRow, EventRow, HolderRow, NameRow, OfferRow, RowOf, TokenRow } from "../src/index.js";
import { done, ok, show } from "./check.js";
import { events, rows, state } from "./corpus.js";

type Kind = "string" | "number" | "boolean" | "true" | "object" | "array" | "string|null";
type Base<V> = [V] extends [true] ? "true" : [V] extends [boolean] ? "boolean" : [V] extends [string] ? "string" : [V] extends [number] ? "number"
  : [V] extends [readonly unknown[]] ? "array" : [V] extends [object] ? "object" : never;
/** The JSON kind a field's type implies; a spec naming another kind does not compile. */
type KindOf<V> = null extends V ? `${Base<NonNullable<V>>}|null` : Base<NonNullable<V>>;
type Optional<T, K extends keyof T> = Record<never, never> extends Pick<T, K> ? true : false;
type Spec<T> = { readonly [K in keyof T]-?: readonly [KindOf<T[K]>, Optional<T, K>] };
type Loose = Readonly<Record<string, readonly [Kind, boolean]>>;

const NAME: Spec<NameRow> = {
  name: ["string", false], owner: ["string", false], claimId: ["string", false], height: ["number", false],
  effectiveHeight: ["number", false], addr: ["string", true], locked: ["boolean", false], viaFill: ["true", true],
  paidThroughEpoch: ["number", true], expired: ["true", true], pending: ["true", true], finalizeBy: ["number", true],
  profile: ["object", true],
};
const TOKEN: Spec<TokenRow> = {
  ticker: ["string", false], deployId: ["string", false], deployer: ["string", false], name: ["string", true],
  decimals: ["number", false], supply: ["string", false], minted: ["string", false], mint: ["string", false],
  mintLimit: ["string", true], height: ["number", false], tmeta: ["string", true],
};
const OFFER: Spec<OfferRow> = {
  id: ["string", false], seller: ["string", false], give: ["object", false], want: ["object", false], taker: ["string", true],
  status: ["string", false], expiresEpoch: ["number", false], height: ["number", false], feeBps: ["number", false],
  min: ["string", true], paid: ["string", true], delivered: ["string", true], bid: ["string", true],
  claimedBy: ["string", true], claimUntilHeight: ["number", true], claimTxid: ["string", true], fill: ["object", true],
  fillCount: ["number", false],
};
const BID: Spec<BidRow> = {
  id: ["string", false], bidder: ["string", false], want: ["object", false], give: ["object", false], status: ["string", false],
  expiresEpoch: ["number", false], height: ["number", false], offerCount: ["number", false],
};
const HOLDER: Spec<HolderRow> = { address: ["string", false], available: ["string", false], locked: ["string", false] };
const EVENT: Spec<EventRow> = {
  txid: ["string", false], height: ["number", false], pos: ["number", false], kind: ["string", false],
  applied: ["boolean", false], code: ["string|null", false],
};
const SPECS: { [R in keyof RowOf]: Spec<RowOf[R]> } = { names: NAME, bids: BID, tokens: TOKEN, events: EVENT, holders: HOLDER, offers: OFFER };

// The nested shapes, one spec per member of each union.
const TOKEN_GIVE: Spec<Extract<Give, { ticker: string }>> = { ticker: ["string", false], amount: ["string", false] };
const NAME_GIVE: Spec<Extract<Give, { name: string }>> = { name: ["string", false] };
const CSD_WANT: Spec<Extract<OfferState["want"], { value: string }>> = { value: ["string", false], payto: ["string", false] };
const TOKEN_WANT: Spec<Extract<OfferState["want"], { ticker: string }>> = { ticker: ["string", false], amount: ["string", false], payto: ["string", false] };
const FILL: Spec<FillEntry> = { buyer: ["string", false], txid: ["string", false], height: ["number", false], paid: ["string", false], fee: ["string", false], got: ["string", true] };
const BID_TOKEN_WANT: Spec<Extract<BidState["want"], { ticker: string }>> = { ticker: ["string", false], amount: ["string", false] };
const BID_NAME_WANT: Spec<Extract<BidState["want"], { name: string }>> = { name: ["string", false] };
const BID_GIVE: Spec<BidState["give"]> = { value: ["string", false] };
const NESTED: Record<string, Record<string, Loose[]>> = {
  offers: { give: [TOKEN_GIVE, NAME_GIVE], want: [CSD_WANT, TOKEN_WANT], fill: [FILL] },
  bids: { want: [BID_TOKEN_WANT, BID_NAME_WANT], give: [BID_GIVE] },
};

// The spec fields no corpus row carries: no corpus name has lapsed (`expired`) or is a reservation (`pending`,
// `finalizeBy`).
const UNEXERCISED: Record<keyof RowOf, string[]> = {
  names: ["expired", "pending", "finalizeBy"], bids: [], tokens: [], events: [], holders: [], offers: [],
};

const kindOf = (v: unknown): Kind =>
  v === true ? "true" : Array.isArray(v) ? "array" : v === null ? "string|null" : (typeof v as Kind);
const fits = (want: Kind, v: unknown): boolean =>
  want === "string|null" ? v === null || typeof v === "string" : want === "boolean" ? typeof v === "boolean" : kindOf(v) === want;
/** The faults of `row` against `spec`: a field outside it, of another kind, or a required field missing. */
function faults(row: object, spec: Loose): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    const s = spec[k];
    if (s === undefined) out.push(`${k}: not a field`);
    else if (!fits(s[0], v)) out.push(`${k}: ${kindOf(v)}, not ${s[0]}`);
  }
  for (const [k, [, optional]] of Object.entries(spec)) if (!optional && !(k in row)) out.push(`${k}: missing`);
  return out;
}

for (const route of Object.keys(SPECS) as (keyof RowOf)[]) {
  const spec: Loose = SPECS[route], list: object[] = rows[route];
  const seen = new Set(list.flatMap((r) => Object.keys(r))), bad = list.flatMap((r) => faults(r, spec));
  ok(`${route}: ${list.length} rows have only the ${Object.keys(spec).length} fields of the row type, of the kinds its type implies, required ones present`,
    list.length > 0 && bad.length === 0, show([...new Set(bad)].slice(0, 5)));
  const unseen = Object.keys(spec).filter((k) => !seen.has(k));
  ok(`${route}: fields the corpus never exercises: ${unseen.join(", ") || "none"}`, show(unseen) === show(UNEXERCISED[route]), show(unseen));
  for (const [field, shapes] of Object.entries(NESTED[route] ?? {})) {
    const values = list.map((r) => (r as Record<string, unknown>)[field]).filter((v): v is object => v !== undefined);
    const unmatched = values.filter((v) => shapes.filter((s) => faults(v, s).length === 0).length !== 1);
    ok(`${route}.${field}: ${values.length} values each match exactly one of its ${shapes.length} shape(s)`, values.length > 0 && unmatched.length === 0, show(unmatched.slice(0, 2)));
  }
}
const profiles = rows.names.flatMap((n) => (n.profile === undefined ? [] : [n.profile]));
ok(`names.profile: ${profiles.length} profile(s), every value a string`, profiles.length > 0 && profiles.every((p) => Object.values(p).every((v) => typeof v === "string")));

console.log("the counts and the event rows, against the corpus records and the resolver's state:");
// A fill names its offer, or an fclaim whose record names the offer (CONVENTION section 31).
const proposals = new Map(events.flatMap((e): [string, string][] => (e.kind === "propose" ? [[e.id, e.uri]] : [])));
const attests = new Map(events.flatMap((e): [string, string][] => (e.kind === "attest" ? [[e.txid, e.proposalId]] : [])));
const offerOf = (proposalId: string): string => {
  if (state.offers[proposalId] !== undefined) return proposalId;
  const rec = JSON.parse(proposals.get(proposalId) ?? "{}") as { t?: string; offer?: string };
  return rec.t === "fclaim" && rec.offer !== undefined ? rec.offer : proposalId;
};
const fillsLogged = new Map<string, number>();
for (const e of state.events) {
  if (e.code !== "FILL_APPLIED" && e.code !== "FILL_PARTIAL") continue;
  const target = offerOf(attests.get(e.id) ?? "");
  fillsLogged.set(target, (fillsLogged.get(target) ?? 0) + 1);
}
const wrongFills = rows.offers.filter((r) => r.fillCount !== (fillsLogged.get(r.id) ?? 0));
ok(`fillCount equals the applied fills the log records for the offer, on ${rows.offers.length} offers`, wrongFills.length === 0, show(wrongFills.map((r) => r.id).slice(0, 3)));
const filled = rows.offers.filter((r) => r.status === "filled");
ok(`no filled offer reads fillCount 0 (${filled.length} filled, ${filled.filter((r) => r.fillCount > 1).length} with more than one fill)`, filled.length > 0 && filled.every((r) => r.fillCount >= 1));
const offersNaming = (bid: string) => Object.values(state.offers).filter((o) => o.bid === bid).length;
ok(`offerCount equals the offers naming the bid, on ${rows.bids.length} bids`, rows.bids.every((r) => r.offerCount === offersNaming(r.id)) && rows.bids.some((r) => r.offerCount > 1));
ok("no offer row carries fills and no bid row offers", rows.offers.every((r) => !("fills" in r)) && rows.bids.every((r) => !("offers" in r)));
const at = new Map(events.map((e: ChainEvent) => [`${e.height}:${e.pos}`, e.kind === "propose" ? e.id : e.txid]));
ok(`every event row is a corpus record at its height and position (${rows.events.length})`, rows.events.every((r) => at.get(`${r.height}:${r.pos}`) === r.txid));
ok("event rows carry the log's verdict and code, and no note text", rows.events.every((r, i) => r.applied === state.events[i]!.ok && r.code === state.events[i]!.code && !("note" in r))
  && state.events.some((e) => typeof e.note === "string"));
ok("every corpus log entry carries a reason code of the core", rows.events.every((r) => r.code !== null && (REASON_CODES as readonly string[]).includes(r.code)));

done("cairnx-api rows");
