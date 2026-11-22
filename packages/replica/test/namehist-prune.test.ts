// The name history keeps a selected record only when the resolver applied it in the full replay or in the
// name-scoped replay. Records any chain user can anchor for a fee and that change nothing for the
// name (a non-owner's nset, a stranger's refused offer of the name and the fill attest on it, refused fill attests on
// the owner's own offer, the bare ocancels of a refused offer's proposer) neither grow the hints a wallet must fetch
// (cairn-wallet src/core/namespv.ts refuses more than 256) nor flag the name unprovable. Every call has a
// resolver service's shape (check with the full replay's applied ids). The attack records sit on the chain before the request, so a name attacked
// before this change is served as if they were not there.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { buildRecord, nameCommit } from "@inversealtruism/cairnx-core";
import { resolve } from "@inversealtruism/cairnx-core";
import { appliedIds, keepPruned, nameHistory } from "../src/namehist.js";
import { CONF_TOKEN_FILL, DEPLOY_FEE, NAME_TERM_EPOCHS, SCORE_CANCEL, SCORE_FILL, TREASURY_ADDR, epochOf, feeBpsAt, nameRegFee, tradeFee, type CairnXRecord, type ChainEvent, type NameState } from "@inversealtruism/cairnx-core";
import { supersededHints } from "./namehist-oracle.js";
import { passCount, t } from "./runner.js";

/** cairn-wallet src/core/namespv.ts MAX_HINTS: a history with more hints is refused before any block is fetched. */
const WALLET_MAX_HINTS = 256;
const ATTACKER = "0x" + "a7".repeat(20);

// The replay corpus csd-sdk publishes in cairnx-core (the real chain's cairnx:v1 events at one height), from the
// exact pinned install.
const corpusPath = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..", "test", "vectors", "replay-corpus.json");
const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { tipHeight: number; events: ChainEvent[] };
const TIP = corpus.tipHeight;

/** What the service serves for `name` over `events` at `tip`. */
function served(events: ChainEvent[], tip: number, name: string) {
  const st = resolve(events, tip);
  const hist = nameHistory(events, name, { tipHeight: tip, fullRecord: st.names[name], fullApplied: appliedIds(st.events) });
  return { record: st.names[name], hist, txids: hist.events.map((e) => e.txid) };
}
/** The record a wallet's replay of exactly the served hints gives. */
function replayHints(events: ChainEvent[], tip: number, name: string, txids: readonly string[]): NameState | undefined {
  const ids = new Set(txids);
  return resolve(events.filter((e) => ids.has((e.kind === "propose" ? e.id : e.txid).toLowerCase())), tip).names[name];
}
let seq = 0;
const nextId = () => "0x" + (0xa7a70000 + ++seq).toString(16).padStart(64, "0");
const propose = (rec: CairnXRecord, height: number, proposer = ATTACKER, expiresEpoch = epochOf(height) + 100): ChainEvent => {
  const b = buildRecord(rec);
  return { kind: "propose", id: nextId(), proposer, uri: b.uri, payloadHash: b.payloadHash, height, pos: 1, expiresEpoch, paidTo: {} };
};
const fillAttest = (proposalId: string, height: number, attester = ATTACKER): ChainEvent =>
  ({ kind: "attest", txid: nextId(), proposalId, attester, score: SCORE_FILL, confidence: 0, height, pos: 1, paidTo: {} });

const live = resolve(corpus.events, TIP);
const owned = Object.keys(live.names).filter((n) => !live.names[n]!.pending);
const sound = owned.filter((n) => served(corpus.events, TIP, n).hist.scopedReplaySufficient);
const victim = sound.find((n) => !live.names[n]!.expired && !live.names[n]!.locked)!;   // a live lease its owner can list
const before = served(corpus.events, TIP, victim);

t(`setup: on the published capture at ${TIP}, ${sound.length} of ${owned.length} owned names are name-scope-sufficient`, () => {
  assert.ok(sound.length > 50, `only ${sound.length}`);
  assert.ok(before.txids.length > 0 && before.txids.length < WALLET_MAX_HINTS);
});

t("257 non-owner nset records leave the victim's hints as they were, under the wallet's cap of 256", () => {
  const extra = Array.from({ length: 257 }, (_, k) => propose({ v: 1, t: "nset", name: victim, addr: ATTACKER } as CairnXRecord, TIP + 1 + k));
  const tip = TIP + 300;
  const after = served([...corpus.events, ...extra], tip, victim);
  assert.equal(after.record?.owner, before.record?.owner, "the records change nothing for the name");
  assert.ok(after.txids.length <= WALLET_MAX_HINTS, `hints grew to ${after.txids.length}`);
  assert.deepEqual(after.txids, before.txids);
  assert.equal(after.hist.scopedReplaySufficient, true);
});

t("a stranger's refused offer of the name brings none of its proposer's 256 bare ocancels into the hints", () => {
  const extra = [propose({ v: 1, t: "offer", give: { name: victim }, want: { value: "100000000" }, taker: "0x" + "b7".repeat(20) } as CairnXRecord, TIP + 1)];
  for (let k = 0; k < 256; k++) extra.push(propose({ v: 1, t: "ocancel" } as CairnXRecord, TIP + 2 + k));
  const after = served([...corpus.events, ...extra], TIP + 300, victim);
  assert.deepEqual(after.txids, before.txids);
  assert.equal(after.hist.scopedReplaySufficient, true);
});

t("refused fill attests on the owner's own open-lane offer neither flag the name nor reach the hints", () => {
  const owner = before.record!.owner;
  const listed = propose({ v: 1, t: "offer", give: { name: victim }, want: { value: "100000000" } } as CairnXRecord, TIP + 1, owner, epochOf(TIP + 1) + 2);
  const extra = [listed, ...Array.from({ length: 257 }, (_, k) => fillAttest(listed.kind === "propose" ? listed.id : "", TIP + 2 + k))];
  const tip = TIP + 2 + 257;
  const after = served([...corpus.events, ...extra], tip, victim);
  assert.equal(resolve([...corpus.events, ...extra], tip).offers[(listed as { id: string }).id]?.seller, owner, "setup: the owner's offer applied");
  assert.deepEqual(after.txids, [...before.txids, (listed as { id: string }).id], "the owner's applied offer is the one new hint");
  assert.equal(after.hist.scopedReplaySufficient, true, "no applied fill decided the name");
});

t("on every name of the capture: a stranger's open-lane offer of the name and one fill attest change no verdict and no hint", () => {
  const changed: string[] = [];
  for (const name of owned) {
    const was = served(corpus.events, TIP, name);
    const grief = propose({ v: 1, t: "offer", give: { name }, want: { value: "100000000" } } as CairnXRecord, TIP + 1);
    const evs = [...corpus.events, grief, fillAttest((grief as { id: string }).id, TIP + 2)];
    const now = served(evs, TIP + 2, name);
    if (now.hist.scopedReplaySufficient !== was.hist.scopedReplaySufficient || JSON.stringify(now.txids) !== JSON.stringify(was.txids)) changed.push(name);
  }
  assert.deepEqual(changed, [], `${changed.length} of ${owned.length} names changed (e.g. ${changed.slice(0, 5).join(", ")})`);
});

t("the real capture still verifies: every name keeps the verdict of the unpruned selection, and its hints replay to the served record", () => {
  for (const name of Object.keys(live.names)) {
    const now = served(corpus.events, TIP, name);
    // the unpruned selection, judged as the service judged it before: its class flags, then the exact compare
    const legacy = nameHistory(corpus.events, name);
    const legacyOk = legacy.scopedReplaySufficient && JSON.stringify(replayHints(corpus.events, TIP, name, legacy.events.map((e) => e.txid)) ?? null) === JSON.stringify(live.names[name] ?? null);
    assert.equal(now.hist.scopedReplaySufficient, legacyOk, name);
    for (const id of now.txids) assert.ok(legacy.events.some((e) => e.txid === id), `${name}: ${id} is not in the unpruned selection`);
    if (now.hist.scopedReplaySufficient) assert.deepEqual(replayHints(corpus.events, TIP, name, now.txids), live.names[name], name);
  }
});

t("a name whose ownership an applied open-lane fill decided stays flagged; the refused records around it are pruned", () => {
  const flagged = owned.filter((n) => !served(corpus.events, TIP, n).hist.scopedReplaySufficient);
  assert.ok(flagged.length > 0, "the capture holds names sold through the open lane");
  for (const n of flagged) assert.match(served(corpus.events, TIP, n).hist.caveat ?? "", /out-of-name-scope state/);
});

t("257 copies of a name's public commitment hash stay out of the hints; the commit the reveal needs stays in", () => {
  const withCommit = sound.find((nm) => served(corpus.events, TIP, nm).hist.events.some((e) => e.kind === "ncommit"))!;
  const was = served(corpus.events, TIP, withCommit);
  const honest = was.hist.events.find((e) => e.kind === "ncommit")!;
  const ev = corpus.events.find((e) => e.kind === "propose" && e.id === honest.txid)!;
  const copies = Array.from({ length: 257 }, (_, k) => ({ ...ev, id: nextId(), proposer: ATTACKER, height: TIP + 1 + k, pos: 1 } as ChainEvent));
  const now = served([...corpus.events, ...copies], TIP + 300, withCommit);
  assert.ok(now.txids.length <= WALLET_MAX_HINTS, `hints grew to ${now.txids.length}`);
  assert.deepEqual(now.txids, was.txids, "the earliest commit stays, no copy enters");
  assert.equal(now.hist.scopedReplaySufficient, true);
});

// A former owner X listed the name while it owned it (an applied offer), so X stays a seller of the name for good, and
// cairnx-core logs every bare ocancel as applied ("0 cancelled") whether or not it cancels anything. Only the ocancel
// that can still cancel X's offer (the first by X after it, while it is open) may stay in the hints.
const formerOwner = () => {
  const X = before.record!.owner, Y = "0x" + "e9".repeat(20);
  const listed = propose({ v: 1, t: "offer", give: { name: victim }, want: { value: "100000000" } } as CairnXRecord, TIP + 1, X, epochOf(TIP + 1) + 50);
  return { X, Y, listed, id: (listed as { id: string }).id };
};

t("a former owner's 257 bare ocancels after it sold or gave the name away stay out of the hints (its first one cancelled its offer)", () => {
  const { X, Y, listed, id } = formerOwner();
  const early = propose({ v: 1, t: "ocancel" } as CairnXRecord, TIP, X);                          // before the offer: cancels nothing of it
  const first = propose({ v: 1, t: "ocancel" } as CairnXRecord, TIP + 2, X);                       // cancels X's open offer
  const xfer = propose({ v: 1, t: "nxfer", name: victim, to: Y } as CairnXRecord, TIP + 4, X);
  const evs = [...corpus.events, early, listed, first, xfer];
  for (let k = 0; k < 257; k++) evs.push(propose({ v: 1, t: "ocancel" } as CairnXRecord, TIP + 10 + k, X));
  const tip = TIP + 300;
  const after = served(evs, tip, victim);
  assert.equal(after.record?.owner, Y, "setup: the name moved to Y");
  assert.equal(resolve(evs, tip).offers[id]?.status, "cancelled", "setup: X's first ocancel cancelled its offer");
  assert.deepEqual(after.txids, [...before.txids, id, (first as { id: string }).id, (xfer as { id: string }).id].sort((a, b) => {
    const h = (t: string) => evs.find((e) => (e.kind === "propose" ? e.id : e.txid) === t)!.height;
    return h(a) - h(b);
  }), "the offer, the ocancel that cancelled it and the transfer; none of the later 257");
  assert.equal(after.hist.scopedReplaySufficient, true);
  assert.deepEqual(replayHints(evs, tip, victim, after.txids), after.record, "the served hints replay to the record");
});

t("a former owner whose offer a cancel attest ended: none of its later bare ocancels stays in the hints", () => {
  const { X, Y, listed, id } = formerOwner();
  const cancel: ChainEvent = { kind: "attest", txid: "0x" + "c4".repeat(32), proposalId: id, attester: X, score: SCORE_CANCEL, confidence: 0, height: TIP + 2, pos: 1, paidTo: {} };
  const xfer = propose({ v: 1, t: "nxfer", name: victim, to: Y } as CairnXRecord, TIP + 4, X);
  const evs = [...corpus.events, listed, cancel, xfer];
  for (let k = 0; k < 257; k++) evs.push(propose({ v: 1, t: "ocancel" } as CairnXRecord, TIP + 10 + k, X));
  const after = served(evs, TIP + 300, victim);
  assert.equal(after.txids.filter((t) => evs.some((e) => e.kind === "propose" && e.id === t && e.height >= TIP + 10)).length, 0);
  assert.ok(after.txids.length <= WALLET_MAX_HINTS && after.hist.scopedReplaySufficient);
});

const ownerAddr = (r: NameState | undefined) => ({ owner: r?.owner, addr: r?.addr });

t("the pruned hints served at the tip give the full chain's owner and address at later tips too", () => {
  const hints = new Map(Object.keys(live.names).map((nm) => [nm, served(corpus.events, TIP, nm)] as const).filter(([, r]) => r.hist.scopedReplaySufficient));
  for (const later of [TIP + 1, TIP + 100_000]) {   // the next block, and past every lease and offer expiry
    const full = resolve(corpus.events, later);
    for (const [nm, r] of hints) assert.deepEqual(ownerAddr(replayHints(corpus.events, later, nm, r.txids)), ownerAddr(full.names[nm]), `${nm} at ${later}`);
  }
  assert.ok(hints.size > 50);
});

// The limit of that claim: the exact compare holds at the tip it ran at. An fclaim is not in a name's selection, so
// a hold it grants is invisible to the scoped replay: the owner's ocancel cancels the held offer there (the full
// chain freezes it) and a second offer applies there (the full chain refuses it, the name is still locked). Both
// records are locked at the serving tip; once the second offer expires the scoped record unlocks while the full one
// stays locked by the first. Owner and address agree throughout.
t("documented limit: an out-of-scope fclaim hold can make the locked flag differ at a later tip; owner and address still agree", () => {
  const A = before.record!.owner, B = "0x" + "f1".repeat(20);
  const h = TIP + 1;
  const first = propose({ v: 1, t: "offer", give: { name: victim }, want: { value: "100000000" } } as CairnXRecord, h, A, epochOf(h) + 40);
  const hold = propose({ v: 1, t: "fclaim", offer: (first as { id: string }).id } as CairnXRecord, h + 1, B, epochOf(h + 1) + 1);
  const cancelAll = propose({ v: 1, t: "ocancel" } as CairnXRecord, h + 2, A);
  const second = propose({ v: 1, t: "offer", give: { name: victim }, want: { value: "200000000" } } as CairnXRecord, h + 3, A, epochOf(h + 3) + 2);
  const evs = [...corpus.events, first, hold, cancelAll, second];
  const tip = h + 10;
  const now = served(evs, tip, victim);
  assert.equal(now.hist.scopedReplaySufficient, true, "setup: both replays agree at the serving tip");
  assert.equal(now.record!.locked, true);
  const later = (epochOf(h + 3) + 3) * 30 + 5;      // the second offer has expired, the first has not
  const full = resolve(evs, later).names[victim]!;
  const scoped = replayHints(evs, later, victim, now.txids)!;
  assert.deepEqual([full.locked, scoped.locked], [true, false], "the locked flag differs");
  assert.deepEqual(ownerAddr(scoped), ownerAddr(full));
});

t("the V25 reservation cap: a fourth reveal the full chain refused still serves scopedReplaySufficient false", () => {
  // A proposer holding 3 live reservations reveals a 4th name: the full chain refuses it at MAX_PENDING_REG, a
  // name-scoped replay cannot see the other 3 and accepts it (the forged-green shape the exact compare catches).
  const A = "0x" + "c4".repeat(20), H = TIP + 10, salt = (k: number) => String(k + 1).repeat(16);
  const evs: ChainEvent[] = [];
  ["capa", "capb", "capc"].forEach((nm, k) => evs.push(
    propose({ v: 1, t: "ncommit", commit: nameCommit(nm, salt(k), A) } as CairnXRecord, H + k, A),
    propose({ v: 1, t: "name", name: nm, salt: salt(k) } as CairnXRecord, H + k + 1, A)));
  evs.push(propose({ v: 1, t: "ncommit", commit: nameCommit("capfour", salt(3), A) } as CairnXRecord, H + 5, A),
    propose({ v: 1, t: "name", name: "capfour", salt: salt(3) } as CairnXRecord, H + 6, A));
  const all = [...corpus.events, ...evs];
  const r = served(all, H + 8, "capfour");
  assert.equal(r.record, undefined, "setup: the full chain refused the 4th reveal");
  assert.ok(replayHints(all, H + 8, "capfour", nameHistory(all, "capfour").events.map((e) => e.txid)), "setup: a scoped replay accepts it");
  assert.equal(r.hist.scopedReplaySufficient, false);
  assert.equal(r.txids.length, 2, "the reveal and its commit stay: the scoped replay applied the reveal");
});

t("the prune guard: a pruned selection whose replay differs from the whole selection's is not served", () => {
  const owner = before.record!.owner;
  const setAddr = propose({ v: 1, t: "nset", name: victim, addr: "0x" + "d5".repeat(20) } as CairnXRecord, TIP + 1, owner);
  const foreign = propose({ v: 1, t: "nset", name: victim, addr: ATTACKER } as CairnXRecord, TIP + 2);   // refused: not the owner
  const evs = [...corpus.events, setAddr, foreign];
  const selected = new Set(nameHistory(evs, victim).events.map((e) => e.txid));
  const whole = replayHints(evs, TIP + 3, victim, [...selected]);
  const id = (e: ChainEvent) => (e as { id: string }).id;
  const wrong = new Set([...selected].filter((x) => x !== id(setAddr)));   // drops the applied nset
  assert.equal(keepPruned(evs, victim, TIP + 3, selected, wrong, whole), selected, "a prune that changes the record falls back");
  const right = new Set([...selected].filter((x) => x !== id(foreign)));   // drops the refused one
  assert.equal(keepPruned(evs, victim, TIP + 3, selected, right, whole), right, "paired: a prune that keeps the record is used");
});

// Superseded address and profile records. Each nset and nprofile replaces its field whole and a transfer or sale
// clears both, so of a name's applied ones only the last of each, with no transfer or sale after it, can reach the
// record. Each case runs on a live name whose hints hold neither kind, so the expected hints are exact.
const plain = sound.find((n) => !live.names[n]!.expired && !live.names[n]!.locked &&
  !served(corpus.events, TIP, n).hist.events.some((e) => e.kind === "nset" || e.kind === "nprofile"))!;
const plainWas = served(corpus.events, TIP, plain);
const P = plainWas.record!.owner, Q = "0x" + "e7".repeat(20);
const idOf = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid);
const inOrder = (evs: ChainEvent[], ids: string[]) => {
  const at = new Map(evs.map((e, i) => [idOf(e), i] as const));
  return [...ids].sort((a, b) => at.get(a)! - at.get(b)!);
};
/** Serves `plain` over the corpus plus `extra` at `tip`; asserts the hints replay to the full record and that the
 *  hints' own replay supersedes none of them (test/namehist-oracle.ts). */
function servePlain(extra: ChainEvent[], tip: number) {
  const evs = [...corpus.events, ...extra];
  const r = served(evs, tip, plain);
  assert.equal(r.hist.scopedReplaySufficient, true);
  assert.deepEqual(replayHints(evs, tip, plain, r.txids), r.record, "the served hints replay to the full record");
  assert.deepEqual(supersededHints(evs, tip, plain, r.txids), [], "no served nset or nprofile is superseded in the hints' replay");
  return { ...r, expect: (added: ChainEvent[]) => inOrder(evs, [...plainWas.txids, ...added.map(idOf)]) };
}
const nset = (addr: string, h: number, who = P) => propose({ v: 1, t: "nset", name: plain, addr } as CairnXRecord, h, who);
const nprofile = (p: Record<string, string>, h: number, who = P) => propose({ v: 1, t: "nprofile", name: plain, p } as CairnXRecord, h, who);
const nxfer = (to: string, h: number, who = P) => propose({ v: 1, t: "nxfer", name: plain, to } as CairnXRecord, h, who);
const addr = (k: number) => "0x" + k.toString(16).padStart(2, "0").repeat(20);

t("a run of the owner's nset records is served as its last one", () => {
  const run = [nset(addr(1), TIP + 1), nset(addr(2), TIP + 2), nset(addr(3), TIP + 3)];
  const r = servePlain(run, TIP + 10);
  assert.equal(r.record?.addr, addr(3), "setup: the last nset decides the address");
  assert.deepEqual(r.txids, r.expect([run[2]!]));
});

t("a transfer splits the run: the old owner's nset records go (the transfer cleared them), the new owner's last stays", () => {
  const evs = [nset(addr(1), TIP + 1), nset(addr(2), TIP + 2), nxfer(Q, TIP + 3), nset(addr(4), TIP + 4, Q), nset(addr(5), TIP + 5, Q)];
  const r = servePlain(evs, TIP + 10);
  assert.deepEqual([r.record?.owner, r.record?.addr], [Q, addr(5)], "setup");
  assert.deepEqual(r.txids, r.expect([evs[2]!, evs[4]!]));
});

t("once ownership moved, no nset of the former owner is needed: a transfer with no nset after it serves no nset", () => {
  const evs = [nset(addr(1), TIP + 1), nprofile({ display: "x" }, TIP + 2), nxfer(Q, TIP + 3)];
  const r = servePlain(evs, TIP + 10);
  assert.deepEqual([r.record?.owner, r.record?.addr, r.record?.profile], [Q, undefined, undefined], "setup: the transfer cleared both");
  assert.deepEqual(r.txids, r.expect([evs[2]!]));
});

t("an nprofile replaces the whole profile (no merge), so a run of them is served as its last; an empty one is that last", () => {
  const evs = [nprofile({ display: "a", url: "u" }, TIP + 1), nprofile({ avatar: "b" }, TIP + 2)];
  const r = servePlain(evs, TIP + 10);
  assert.deepEqual(r.record?.profile, { avatar: "b" }, "setup: no key of the first profile survives");
  assert.deepEqual(r.txids, r.expect([evs[1]!]));
  const cleared = [...evs, nprofile({}, TIP + 3)];
  const c = servePlain(cleared, TIP + 10);
  assert.equal(c.record?.profile, undefined, "setup: the empty profile cleared it");
  assert.deepEqual(c.txids, c.expect([cleared[2]!]));
});

t("a sale clears address and profile: an nset in the fill's own block is ordered before the fill, as resolve() orders it", () => {
  const value = 100_000_000n, h = TIP + 5;
  const offer = propose({ v: 1, t: "offer", give: { name: plain }, want: { value: value.toString() }, taker: Q } as CairnXRecord, TIP + 1, P, epochOf(TIP + 1) + 50);
  const fill: ChainEvent = { kind: "attest", txid: nextId(), proposalId: idOf(offer), attester: Q, score: SCORE_FILL, confidence: 0, height: h, pos: 1,
    paidTo: { [P]: value.toString(), [TREASURY_ADDR]: tradeFee(value, feeBpsAt(TIP + 1)).toString() } };
  const sameBlock = { ...nset(addr(7), h), pos: 5 } as ChainEvent;   // a later position than the fill, but a Propose
  const evs = [nset(addr(6), TIP + 2), nprofile({ display: "p" }, TIP + 3), offer, sameBlock, fill];
  const r = servePlain(evs, h + 5);
  assert.deepEqual([r.record?.owner, r.record?.addr, r.record?.profile, r.record?.viaFill], [Q, undefined, undefined, true], "setup: the sale applied");
  assert.deepEqual(r.txids, r.expect([offer, fill]));
});

t("two renewals both stay: a renewal adds a term to the lease, it does not replace the one before", () => {
  const renew = (h: number) => propose({ v: 1, t: "nrenew", name: plain } as CairnXRecord, h, P, epochOf(h) + 100);
  const evs = [renew(TIP + 1), renew(TIP + 2)].map((e) => ({ ...e, paidTo: { [TREASURY_ADDR]: nameRegFee(plain, TIP + 2).toString() } }) as ChainEvent);
  const r = servePlain(evs, TIP + 10);
  assert.equal(r.record!.paidThroughEpoch, plainWas.record!.paidThroughEpoch! + 2 * NAME_TERM_EPOCHS, "setup: both renewals applied");
  assert.deepEqual(r.txids, r.expect(evs));
});

t("a record the full chain applied and the scoped replay refused supersedes nothing: an nset before a name-for-token sale stays", () => {
  // The full chain applies the token fill (the buyer's balance is out of the name's scope), the scoped replay refuses
  // it, so the scoped record keeps the nset's address. A stranger's refused nset is in the selection but not served.
  const h = TIP + 1, tok = "TOKQ";
  const dep = propose({ v: 1, t: "deploy", ticker: tok, decimals: 0, supply: "1000", mint: "issuer" } as CairnXRecord, h, Q);
  const mint = propose({ v: 1, t: "mint", ticker: tok, amount: "100" } as CairnXRecord, h + 1, Q);
  const set = nset(addr(8), h + 2), stranger = nset(ATTACKER, h + 3, ATTACKER);
  const offer = propose({ v: 1, t: "offer", give: { name: plain }, want: { ticker: tok, amount: "10" }, taker: Q } as CairnXRecord, h + 4, P, epochOf(h + 4) + 50);
  const fill: ChainEvent = { kind: "attest", txid: nextId(), proposalId: idOf(offer), attester: Q, score: SCORE_FILL, confidence: CONF_TOKEN_FILL, height: h + 5, pos: 1, paidTo: {} };
  const evs = [...corpus.events, { ...dep, paidTo: { [TREASURY_ADDR]: DEPLOY_FEE.toString() } } as ChainEvent, mint, set, stranger, offer, fill];
  const r = served(evs, h + 10, plain);
  assert.equal(r.record?.owner, Q, "setup: the full chain sold the name");
  assert.equal(r.hist.scopedReplaySufficient, false, "setup: flagged, as every name-for-token sale is");
  assert.deepEqual(r.txids, inOrder(evs, [...plainWas.txids, idOf(set), idOf(offer), idOf(fill)]), "the nset stays and the stranger's does not enter");
});

t("the guard over the new prune: dropping the last nset of a run instead of the first falls back to the whole selection", () => {
  const run = [nset(addr(1), TIP + 1), nset(addr(2), TIP + 2)];
  const evs = [...corpus.events, ...run];
  const selected = new Set(nameHistory(evs, plain).events.map((e) => e.txid));
  const whole = replayHints(evs, TIP + 10, plain, [...selected]);
  const keepFirst = new Set([...selected].filter((x) => x !== idOf(run[1]!)));
  assert.equal(keepPruned(evs, plain, TIP + 10, selected, keepFirst, whole), selected, "keeping the first changes the address: not served");
  const keepLast = new Set([...selected].filter((x) => x !== idOf(run[0]!)));
  assert.equal(keepPruned(evs, plain, TIP + 10, selected, keepLast, whole), keepLast, "paired: keeping the last is served");
});

t("on every name of the capture: no served nset or nprofile is superseded, none dropped sits above the highest hint, and the hints replay to the record", () => {
  let names = 0, shorter = 0;
  for (const name of Object.keys(live.names)) {
    const now = served(corpus.events, TIP, name);
    const legacy = nameHistory(corpus.events, name).events;
    if (!now.hist.scopedReplaySufficient) continue;
    names++;
    const dropped = supersededHints(corpus.events, TIP, name, legacy.map((e) => e.txid)).filter((id) => !now.txids.includes(id));
    if (dropped.length) shorter++;
    assert.deepEqual(supersededHints(corpus.events, TIP, name, now.txids), [], name);
    const top = Math.max(...now.hist.events.map((e) => e.height));   // the wallet's depth is counted from it
    for (const id of dropped) assert.ok(legacy.find((e) => e.txid === id)!.height <= top, `${name}: ${id} was above the highest hint`);
    assert.deepEqual(replayHints(corpus.events, TIP, name, now.txids), live.names[name], name);
  }
  assert.ok(names > 50 && shorter > 0, `${names} names, ${shorter} served without a superseded record of the unpruned selection`);
});

console.log(`namehist-prune: ${passCount()} passed`);
