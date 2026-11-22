// The cursor codec of every list order: round trips, foreign cursors, malformed cursors, and the order each codec's
// compare defines against an oracle written independently of it (bytewise Buffer.compare for the strings, sign of
// a difference for the numbers), over every row of the corpus.
import { CURSORS, type CursorCodec } from "../src/index.js";
import { done, ok, show } from "./check.js";
import { rows, state } from "./corpus.js";

const H = `0x${"ab".repeat(32)}`, A = `0x${"cd".repeat(20)}`;
const MAX_AMOUNT = (1n << 96n) - 1n;
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
const sign = (d: number | bigint) => (d > 0 ? 1 : d < 0 ? -1 : 0);

function roundTrips<K>(what: string, codec: CursorCodec<K, never>, keys: K[]): void {
  const bad = keys.filter((k) => { const d = codec.decode(codec.encode(k)); return d === null || codec.compare(d, k) !== 0 || show(d) !== show(k); });
  ok(`${what}: ${keys.length} keys round trip`, bad.length === 0, show(bad.slice(0, 3)));
}
function refuses(what: string, codec: CursorCodec<unknown, never>, cursors: string[]): void {
  const taken = cursors.filter((c) => codec.decode(c) !== null);
  ok(`${what}: ${cursors.length} malformed cursors refused`, taken.length === 0, show(taken));
}
/** Sorting by compare equals sorting by the oracle, and compare is antisymmetric and zero only on equal keys. */
function orders<K>(what: string, codec: CursorCodec<K, never>, keys: K[], oracle: (a: K, b: K) => number): void {
  const a = [...keys].sort(codec.compare).map(codec.encode), b = [...keys].sort(oracle).map(codec.encode);
  ok(`${what}: compare sorts ${keys.length} keys as the oracle does`, show(a) === show(b), `${show(a.slice(0, 5))} vs ${show(b.slice(0, 5))}`);
  const pairs = keys.slice(0, 60).flatMap((x) => keys.slice(0, 60).map((y) => [x, y] as const));
  ok(`${what}: compare agrees with the oracle in sign on ${pairs.length} pairs`, pairs.every(([x, y]) => sign(codec.compare(x, y)) === sign(oracle(x, y))));
  const encoded = keys.map(codec.encode).sort((x, y) => codec.compare(codec.decode(x) as K, codec.decode(y) as K));
  ok(`${what}: encoded cursors sort through decode as their keys do`, show(encoded) === show(a));
}

const names = rows.names.map(CURSORS.name.of), newest = rows.names.map(CURSORS.newest.of), lengthKeys = rows.names.map(CURSORS.length.of);
const offers = rows.offers.map(CURSORS.anchor.of), bids = rows.bids.map(CURSORS.anchor.of);
const tickers = rows.tokens.map(CURSORS.ticker.of), holders = rows.holders.map(CURSORS.holder.of), events = rows.events.map(CURSORS.event.of);

console.log("round trips:");
roundTrips("name", CURSORS.name, [...names, { name: "a" }, { name: "10" }, { name: `a${"-b".repeat(15)}c` }]);
roundTrips("newest", CURSORS.newest, [...newest, { height: 0, name: "0" }, { height: 999_999_999_999_999, name: "z" }]);
roundTrips("length", CURSORS.length, [...lengthKeys, { length: 1, name: "0" }, { length: 32, name: `a${"-b".repeat(15)}c` }]);
roundTrips("anchor (offers)", CURSORS.anchor, offers);
roundTrips("anchor (bids)", CURSORS.anchor, [...bids, { height: 0, id: H }]);
roundTrips("ticker", CURSORS.ticker, [...tickers, { ticker: "ABC" }, { ticker: "Z00000000000" }]);
roundTrips("holder", CURSORS.holder, [...holders, { amount: 0n, address: A }, { amount: MAX_AMOUNT, address: A }]);
roundTrips("event", CURSORS.event, [...events, { height: 0, pos: 0 }, { height: 999_999_999_999_999, pos: 999_999_999_999_999 }]);

console.log("a cursor of another list is a position:");
const ev = CURSORS.event.encode({ height: 44682, pos: 2 });
ok("the events cursor 44682:2 decodes as the newest names position (44682, \"2\")", show(CURSORS.newest.decode(ev)) === show({ height: 44682, name: "2" }));
ok("a names cursor that fits the ticker grammar does not exist (names are lowercase)", names.every((k) => CURSORS.ticker.decode(CURSORS.name.encode(k)) === null));
// The anchor grammar, spelled out independently from the resolver's state rather than through the codec.
const anchorText = Object.values(state.offers).map((o) => `${o.height}:${o.id}`);
ok(`the anchor cursor of each corpus offer is "<height>:<id>" (${anchorText.length})`, show(rows.offers.map((r) => CURSORS.anchor.encode(CURSORS.anchor.of(r)))) === show(anchorText));
ok("a literal anchor cursor decodes to its height and id", show(CURSORS.anchor.decode(`17:${H}`)) === show({ height: 17, id: H }));
ok("an offers cursor does not fit the newest names grammar (a hash is not a name)", CURSORS.newest.decode(CURSORS.anchor.encode(offers[0]!)) === null);
ok("a newest names cursor with a decimal name decodes as an events position", show(CURSORS.event.decode("7:10")) === show({ height: 7, pos: 10 }));

ok("the length cursor of each corpus name is \"<length>:<name>\", spelled from the name's bytes", rows.names.every((r) =>
  CURSORS.length.encode(CURSORS.length.of(r)) === `${Buffer.byteLength(r.name, "ascii")}:${r.name}`));
ok("a names cursor and a newest cursor do not fit the length grammar", names.every((k) => CURSORS.length.decode(CURSORS.name.encode(k)) === null)
  && newest.filter((k) => k.height !== k.name.length).every((k) => CURSORS.length.decode(CURSORS.newest.encode(k)) === null));

console.log("malformed:");
refuses("name", CURSORS.name, ["", "Alice", "-a", "a-", "a_b", "a".repeat(33), "1:a", "é", "a b"]);
refuses("newest", CURSORS.newest, ["", "alice", "1:", ":a", "01:a", "-1:a", "1:A", "1:a:b", "1.0:a", "9007199254740992:a", "1000000000000000:a", "1e3:a", " 1:a"]);
refuses("length", CURSORS.length, ["", "alice", "5", "4:alice", "6:alice", "05:alice", "5:Alice", "5:alice:x", "1:", ":a", "44682:2", "33:" + "a".repeat(33), "5.0:alice"]);
refuses("anchor", CURSORS.anchor, ["", H, `1000000000000000:${H}`, `1:${H.toUpperCase().replace("0X", "0x")}`, `${H}:1`, `1:${H}:x`, `01:${H}`, `1:${A}`, `1:${H.slice(0, -1)}`]);
refuses("ticker", CURSORS.ticker, ["", "cairn", "AB", "A".repeat(13), "1ABC", "AB-C"]);
refuses("holder", CURSORS.holder, ["", A, `1:${A.toUpperCase().replace("0X", "0x")}`, `-1:${A}`, `01:${A}`, `${MAX_AMOUNT + 1n}:${A}`, `${"9".repeat(500)}:${A}`, `1:${H}`, `1.5:${A}`]);
refuses("event", CURSORS.event, ["", "1", "1:", ":1", "01:1", "1:01", "1:2:3", "-1:0", "1:-1", "9007199254740992:0", "0:9007199254740992",
  "1000000000000000:0", "0:1000000000000000", "a:1"]);

// A long amount is refused before BigInt sees it: every BigInt call during the decode is recorded.
const realBigInt = globalThis.BigInt, lengths: number[] = [];
globalThis.BigInt = ((v: string | number | bigint | boolean) => { lengths.push(String(v).length); return realBigInt(v); }) as BigIntConstructor;
try {
  ok("a 100,000-digit amount is refused", CURSORS.holder.decode(`${"9".repeat(100_000)}:${A}`) === null);
  ok("and no string longer than MAX_AMOUNT's 29 digits reached BigInt", lengths.every((n) => n <= 29), show(lengths.slice(0, 3)));
} finally {
  globalThis.BigInt = realBigInt;
}
ok("the guard check sees BigInt: an honest holder cursor calls it", (() => { lengths.length = 0; globalThis.BigInt = ((v: string) => { lengths.push(v.length); return realBigInt(v); }) as BigIntConstructor;
  try { return CURSORS.holder.decode(`12:${A}`) !== null && lengths.length === 1; } finally { globalThis.BigInt = realBigInt; } })());
const deepFrozen = (v: unknown): boolean => typeof v !== "object" || v === null || v instanceof RegExp || (Object.isFrozen(v) && Object.values(v).every(deepFrozen));
ok("CURSORS and every codec in it are frozen", deepFrozen(CURSORS) && Object.isFrozen(CURSORS.name));

console.log("order:");
orders("name (bytewise ascending)", CURSORS.name, [...names, { name: "9" }, { name: "10" }, { name: "a-b" }, { name: "ab" }], (a, b) => bytes(a.name, b.name));
ok("name: \"10\" sorts before \"9\" (bytewise, not the state object's integer-first order)", CURSORS.name.compare({ name: "10" }, { name: "9" }) < 0);
orders("newest (height desc, name asc)", CURSORS.newest, newest, (a, b) => sign(b.height - a.height) || bytes(a.name, b.name));
// Equal lengths across every class of byte the name grammar admits: digits, hyphen, lowercase. Uppercase and
// non-ASCII bytes are outside NAME_RE, so no name holds one.
const tied = ["a-b", "a0b", "ab0", "0-0", "00a", "9-9", "z-z", "a9z", "b", "9", "z", "0", "ab-cd", "ab0cd", "abzcd", "10", "9a"].map((name) => ({ length: name.length, name }));
orders("length (length asc, name asc)", CURSORS.length, [...lengthKeys, ...tied], (a, b) => sign(Buffer.byteLength(a.name) - Buffer.byteLength(b.name)) || bytes(a.name, b.name));
ok("length: equal lengths order bytewise, hyphen before digits before letters", show([...tied].sort(CURSORS.length.compare).map((k) => k.name))
  === show(["0", "9", "b", "z", "10", "9a", "0-0", "00a", "9-9", "a-b", "a0b", "a9z", "ab0", "z-z", "ab-cd", "ab0cd", "abzcd"]));
orders("anchor on offers (height desc, id asc)", CURSORS.anchor, offers, (a, b) => sign(b.height - a.height) || bytes(a.id, b.id));
orders("anchor on bids (height desc, id asc)", CURSORS.anchor, bids, (a, b) => sign(b.height - a.height) || bytes(a.id, b.id));
orders("ticker (bytewise ascending)", CURSORS.ticker, tickers, (a, b) => bytes(a.ticker, b.ticker));
orders("holder (available + locked desc, address asc)", CURSORS.holder, holders, (a, b) => sign(b.amount - a.amount) || bytes(a.address, b.address));
ok("holder: an amount of 10 sorts before 9 (numeric, not text)", CURSORS.holder.compare({ amount: 10n, address: A }, { amount: 9n, address: A }) < 0);
ok("holder: the key is available + locked", CURSORS.holder.of({ address: A, available: "7", locked: "5" }).amount === 12n);
orders("event (height asc, pos asc)", CURSORS.event, events, (a, b) => sign(a.height - b.height) || sign(a.pos - b.pos));
ok("event: 44682:10 sorts after 44682:9 (numeric, not text)", CURSORS.event.compare({ height: 44682, pos: 10 }, { height: 44682, pos: 9 }) > 0);
ok("the corpus has names, offers, bids, tokens, holders and events to order", [names, offers, bids, tickers, holders, events].every((k) => k.length > 10));

done("cairnx-api cursor");
