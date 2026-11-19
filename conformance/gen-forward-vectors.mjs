// Generator for the forward-resolution vectors (CONVENTION §35.4): each case is an event list and a tip, and asks
// resolveNameIn and nameView about names of resolve(events, tip).names. The expected answers are written here by hand;
// the built dist must give them, and each case must still show the state it pins, or nothing is written.
// Re-runnable: rewrites the whole forward.json each run. Run: node conformance/gen-forward-vectors.mjs (after building
// packages/cairnx).
//   held-nset             a held name with an `nset` address resolves to it.
//   held-owner            without an address it resolves to the owner; absent, prototype, upper-case and suffixed keys,
//                         and an unregistered `constructor`, resolve to nothing.
//   nset-cleared          an `nset` to the zero address (V23 and above) clears the address: the owner again.
//   nset-zero-below-v23   below V23 the same record stores the zero address, and the name resolves to it (§26).
//   grace-held            past paidThroughEpoch but inside the grace, the name is held.
//   lapsed                past the grace: resolveNameIn flags it, nameView gives no address and no profile.
//   pending               a reservation resolves to nothing; nameView names its reserver.
//   at-finalize-by        at a tip equal to finalizeBy the reservation is gone: free.
//   reserved              a reveal of a reserved name does not parse, so the name is not in the state.
//   constructor-held      a name `constructor` that is registered resolves.
//   locked                a name an open offer holds resolves as held.
//   sold                  a sale gives the buyer the name and clears its address.
//   nxfer                 a transfer gives the recipient the name and clears its address.
//   profile-not-target    an address in the profile is not the send target.
import { writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  resolve, resolveNameIn, nameView, canonicalJson, payloadHash, requiredFillOutputs, nameCommit, nameRegFee, nameCommitRecord,
  nameClaim, nameFinalize, nameSet, nameProfile, nameXfer, offer, epochOf, V29_HEIGHT, SCORE_FILL, TREASURY_ADDR, ZERO_ADDR,
  EPOCH_LEN, NAME_TERM_EPOCHS, NAME_GRACE_EPOCHS, REG_COMMIT_MAX_BLOCKS, REG_FINALIZE_GRACE_BLOCKS, V23_HEIGHT, V25_HEIGHT,
} from "../packages/cairnx/dist/index.js";

const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
let idn = 0xf0e00000;
const nid = () => "0x" + (idn++).toString(16).padStart(64, "0");
const FAR = 9_000_000_000;
const SALT = "00112233445566778899aabbccddeeff";
const PE = (b, height, proposer, ee = FAR, pos = 0, paidTo = {}) =>
  ({ kind: "propose", id: nid(), proposer, uri: b.uri, payloadHash: b.payloadHash, expiresEpoch: ee, height, pos, paidTo });
const AE = (proposalId, attester, height, paidTo) =>
  ({ kind: "attest", txid: nid(), proposalId, attester, score: SCORE_FILL, confidence: 0, height, pos: 0, paidTo });
const toTreasury = (v) => ({ [TREASURY_ADDR]: String(v) });

const H = V29_HEIGHT + 12_000;
// commit at h, reveal at h + 1, finalize at h + 10 (past the freeze of §28)
const register = (name, who, h) => [
  PE(nameCommitRecord({ commit: nameCommit(name, SALT, who) }), h, who),
  PE(nameClaim({ name, salt: SALT }), h + 1, who),
  PE(nameFinalize({ name, salt: SALT }), h + 10, who, FAR, 0, toTreasury(nameRegFee(name, h + 10))),
];
const paidThrough = (h) => epochOf(h + 10) + NAME_TERM_EPOCHS;   // §28: the lease starts at the finalize
const held = (name, owner, addr, h, profile = {}) => ({ name, state: "held", owner, addr, profile, paidThroughEpoch: paidThrough(h) });
const none = (name, state) => ({ name, state, owner: null, addr: null, profile: {}, paidThroughEpoch: null });
const to = (name, addr, via, owner, lapsed = false) => ({ name, addr, via, lapsed, owner });

const built = [];
const fail = (name, what) => { throw new Error(`vector ${name} no longer shows what it pins: ${what}`); };
const add = (name, events, tipHeight, asks, shows) => {
  const st = resolve(events, tipHeight);
  for (const [what, ok] of shows(st)) if (!ok) fail(name, what);
  for (const a of asks) {
    const r = resolveNameIn(st.names, a.query), v = nameView(st.names, a.query);
    if (!isDeepStrictEqual(r, a.resolveNameIn)) fail(name, `resolveNameIn(${a.query}) = ${JSON.stringify(r)}, written ${JSON.stringify(a.resolveNameIn)}`);
    if (!isDeepStrictEqual(v, a.nameView)) fail(name, `nameView(${a.query}) = ${JSON.stringify(v)}, written ${JSON.stringify(a.nameView)}`);
  }
  built.push({ name, tipHeight, events, asks });
};
const own = (st, n) => Object.hasOwn(st.names, n);

add("held-nset", [...register("alice", A, H), PE(nameSet({ name: "alice", addr: C }), H + 11, A)], H + 12,
  [{ query: "alice", resolveNameIn: to("alice", C, "nset", A), nameView: held("alice", A, C, H) }],
  (st) => [["alice has addr C", st.names.alice?.addr === C]]);

add("held-owner", register("bobby", A, H), H + 12, [
  { query: "bobby", resolveNameIn: to("bobby", A, "owner", A), nameView: held("bobby", A, A, H) },
  { query: "nobody", resolveNameIn: null, nameView: none("nobody", "free") },
  { query: "constructor", resolveNameIn: null, nameView: none("constructor", "free") },
  { query: "__proto__", resolveNameIn: null, nameView: null },
  { query: "Bobby", resolveNameIn: null, nameView: null },
  { query: "bobby.csd", resolveNameIn: null, nameView: null },
], (st) => [["bobby has no addr", own(st, "bobby") && st.names.bobby.addr === undefined], ["no own constructor", !own(st, "constructor")]]);

add("nset-cleared", [...register("clear1", A, H), PE(nameSet({ name: "clear1", addr: C }), H + 11, A), PE(nameSet({ name: "clear1", addr: ZERO_ADDR }), H + 12, A)], H + 13,
  [{ query: "clear1", resolveNameIn: to("clear1", A, "owner", A), nameView: held("clear1", A, A, H) }],
  (st) => [["the zero-address nset cleared addr", own(st, "clear1") && st.names.clear1.addr === undefined]]);

// one lease, read at the last height of the grace's final epoch and at the first height after it
const lease = [...register("lease1", A, H), PE(nameSet({ name: "lease1", addr: C }), H + 11, A), PE(nameProfile({ name: "lease1", p: { display: "Lease" } }), H + 12, A)];
const graceEnd = paidThrough(H) + NAME_GRACE_EPOCHS;
add("grace-held", lease, graceEnd * EPOCH_LEN + EPOCH_LEN - 1,
  [{ query: "lease1", resolveNameIn: to("lease1", C, "nset", A), nameView: held("lease1", A, C, H, { display: "Lease" }) }],
  (st) => [["the tip epoch is the grace's last", epochOf(st.tipHeight) === graceEnd], ["not expired", st.names.lease1?.expired === undefined]]);
add("lapsed", lease, (graceEnd + 1) * EPOCH_LEN, [{
  query: "lease1", resolveNameIn: to("lease1", C, "nset", A, true),
  nameView: { name: "lease1", state: "lapsed", owner: A, addr: null, profile: {}, paidThroughEpoch: paidThrough(H) },
}], (st) => [["expired", st.names.lease1?.expired === true], ["the state keeps the profile", st.names.lease1?.profile?.display === "Lease"]]);

// a reservation: commit at H, reveal at H + 1, no finalize; finalizeBy = H + 8 + 20
const reserve = [PE(nameCommitRecord({ commit: nameCommit("pend1", SALT, A) }), H, A), PE(nameClaim({ name: "pend1", salt: SALT }), H + 1, A)];
const finalizeBy = H + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS;
add("pending", reserve, H + 5,
  [{ query: "pend1", resolveNameIn: null, nameView: { ...none("pend1", "pending"), owner: A } }],
  (st) => [["pending", st.names.pend1?.pending === true], ["finalizeBy", st.names.pend1?.finalizeBy === finalizeBy]]);
add("at-finalize-by", reserve, finalizeBy,
  [{ query: "pend1", resolveNameIn: null, nameView: none("pend1", "free") }],
  (st) => [["the reservation is gone", !own(st, "pend1")]]);

// the builders refuse a reserved name, so the reveal is written raw
const rawAdmin = { uri: canonicalJson({ v: 1, t: "name", name: "admin", salt: SALT }), payloadHash: payloadHash({ v: 1, t: "name", name: "admin", salt: SALT }) };
const adminReveal = PE(rawAdmin, H + 1, A);
add("reserved", [PE(nameCommitRecord({ commit: nameCommit("admin", SALT, A) }), H, A), adminReveal], H + 5, [
  { query: "admin", resolveNameIn: null, nameView: none("admin", "reserved") },
  { query: "csd", resolveNameIn: null, nameView: none("csd", "reserved") },
], (st) => [["the reveal is refused as reserved", st.events.some((e) => e.id === adminReveal.id && e.code === "RECORD_NAME_RESERVED")], ["admin absent", !own(st, "admin")]]);

add("constructor-held", register("constructor", A, H), H + 12,
  [{ query: "constructor", resolveNameIn: to("constructor", A, "owner", A), nameView: held("constructor", A, A, H) }],
  (st) => [["own constructor", own(st, "constructor")]]);

// a name offer to taker B: open (locked), then filled (sold)
const listed = (name) => [...register(name, A, H), PE(nameSet({ name, addr: C }), H + 11, A),
  PE(offer({ give: { name }, want: { value: "100000000" }, taker: B }), H + 20, A, epochOf(H + 20) + 2)];
add("locked", listed("lockd"), H + 21,
  [{ query: "lockd", resolveNameIn: to("lockd", C, "nset", A), nameView: held("lockd", A, C, H) }],
  (st) => [["locked", st.names.lockd?.locked === true]]);
const sale = listed("sold1");
const offerId = sale[sale.length - 1].id;
const o = resolve(sale, H + 20).offers[offerId];
const pay = Object.fromEntries((requiredFillOutputs(o, "100000000") ?? []).map((x) => [x.to, String(x.value)]));
const fillEv = AE(offerId, B, H + 21, pay);
add("sold", [...sale, fillEv], H + 22, [{
  query: "sold1", resolveNameIn: to("sold1", B, "owner", B),
  nameView: { name: "sold1", state: "held", owner: B, addr: B, profile: {}, paidThroughEpoch: paidThrough(H) },
}], (st) => [["viaFill to B", st.names.sold1?.viaFill === true && st.names.sold1.owner === B], ["addr cleared", st.names.sold1?.addr === undefined]]);

add("nxfer", [...register("gift1", A, H), PE(nameSet({ name: "gift1", addr: C }), H + 11, A), PE(nameXfer({ name: "gift1", to: B }), H + 12, A)], H + 13,
  [{ query: "gift1", resolveNameIn: to("gift1", B, "owner", B), nameView: held("gift1", B, B, H) }],
  (st) => [["owner B, addr cleared", st.names.gift1?.owner === B && st.names.gift1.addr === undefined]]);

add("profile-not-target", [...register("prof1", A, H), PE(nameProfile({ name: "prof1", p: { wallet: C } }), H + 11, A)], H + 12,
  [{ query: "prof1", resolveNameIn: to("prof1", A, "owner", A), nameView: held("prof1", A, A, H, { wallet: C }) }],
  (st) => [["the profile holds C", st.names.prof1?.profile?.wallet === C]]);

// below V23 (and above V25, so the sealed registration applies) an nset to the zero address is stored as written
const L = V23_HEIGHT - 2_000;
add("nset-zero-below-v23", [...register("zero1", A, L), PE(nameSet({ name: "zero1", addr: ZERO_ADDR }), L + 11, A)], L + 12,
  [{ query: "zero1", resolveNameIn: to("zero1", ZERO_ADDR, "nset", A), nameView: held("zero1", A, ZERO_ADDR, L) }],
  (st) => [["between V25 and V23", L > V25_HEIGHT && L + 11 < V23_HEIGHT], ["addr is the zero address", st.names.zero1?.addr === ZERO_ADDR]]);

const path = new URL("../packages/cairnx/test/vectors/forward.json", import.meta.url);
writeFileSync(path, `{"format":1,"cases":[\n${built.map((c) => JSON.stringify(c)).join(",\n")}\n]}\n`);
console.log(`wrote ${built.length} forward-resolution cases (${built.reduce((n, c) => n + c.asks.length, 0)} asks) -> forward.json`);
