// WA-PARITY (Plan 70 R2 / W-A defense-in-depth) - the SHARED fill-boundary corpus, SEAM 1 of 3: cairnx-core.
//
// One canonical hostile-case corpus (test/vectors/wa-parity-corpus.json) is fed to all three fill-boundary
// seams so a wallet-vs-site (or vs cairnx-core) divergence can never re-open the F8 class silently. This file
// is the cairnx-core adapter: it materializes each scenario as abstract ChainEvents and drives the REAL
// verifyFillSpv (the pure grant/hold/delivery replay). The cairn (swapguard.js) and cairn-wallet (fillspv.ts)
// adapters vendor a byte-identity-checked COPY of the SAME json and materialize it as REAL signed txs.
//
// Two families (see the corpus note): 'replay' scenarios exercise the grant/hold/completeness replay that ALL
// THREE seams share (verifyFillSpv applies directly). 'terms' scenarios exercise the served-offer vs
// merkle-proven-offer bind that only the CALLERS do (wallet provenTermsMismatch + site verifyOfferContent),
// because verifyFillSpv takes NO served offer - so for a 'terms' scenario this seam asserts (a) cairnxCore is
// correctly NOT in its seam list, and (b) verifyFillSpv ACCEPTS the honest underlying fill, proving the lie is
// invisible to this layer and genuinely the caller's job.
//
// Run: tsx test/wa-parity.test.ts   (offline; no chain)
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { payloadHash } from "@inversealtruism/csd-codec";
import {
  deploy, mint, offer, fclaim, offerCancelAll,
  verifyFillSpv, resolve,
  V28_HEIGHT, EPOCH_LEN, FCLAIM_MAX_EPOCH_AHEAD, CLAIM_COOLDOWN_BLOCKS, FILL_TIP_MARGIN,
  FEE_BPS_V16, TREASURY_ADDR, DEPLOY_FEE, epochOf, fclaimHoldEnd,
} from "../src/index.js";
import type { ChainEvent, ProvenEvent, FillSpvIo } from "../src/index.js";

let pass = 0;
const ok = (cond: boolean, name: string) => { assert.ok(cond, name); pass++; };

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusPath = path.join(here, "vectors", "wa-parity-corpus.json");
const corpusRaw = readFileSync(corpusPath, "utf8");
const corpus = JSON.parse(corpusRaw) as WaCorpus;

// ── 0. corpus integrity: the freshness/byte-identity hash the vendored COPIES (cairn, wallet) must match.
// This is the I2 dead-green cure applied to the corpus itself: a drifted copy FAILS, never skips. The hash is
// over the PARSED-then-canonicalised object (whitespace-independent), so the wallet/site copies can be
// pretty-printed differently and still match iff the DATA is identical.
export const WA_CORPUS_SHA = "0x514874b3036a78e0b8429d44777da7a3d20793525c022b440868e4a720f78ffd";
const actualSha = payloadHash(corpus);
ok(actualSha === WA_CORPUS_SHA, `corpus hash matches the pin (got ${actualSha})`);

// ── 1. constants bind: a silent constant drift (a gate/fee/epoch change) must RED the corpus, not pass. ──
const C = corpus.consts;
ok(V28_HEIGHT === C.V28_HEIGHT, `V28_HEIGHT matches corpus (${V28_HEIGHT})`);
ok(EPOCH_LEN === C.EPOCH_LEN, `EPOCH_LEN matches corpus (${EPOCH_LEN})`);
ok(FCLAIM_MAX_EPOCH_AHEAD === C.FCLAIM_MAX_EPOCH_AHEAD, "FCLAIM_MAX_EPOCH_AHEAD matches corpus");
ok(CLAIM_COOLDOWN_BLOCKS === C.CLAIM_COOLDOWN_BLOCKS, "CLAIM_COOLDOWN_BLOCKS matches corpus");
ok(FILL_TIP_MARGIN === C.FILL_TIP_MARGIN, "FILL_TIP_MARGIN matches corpus");
ok(Number(FEE_BPS_V16) === C.FEE_BPS_V16, "FEE_BPS_V16 matches corpus");
ok(String(TREASURY_ADDR).toLowerCase() === String(C.TREASURY_ADDR).toLowerCase(), "TREASURY_ADDR matches corpus (fee-leg drift guard)");

// ── actor + id maps (this adapter's materialisation; the wallet/site adapters map the SAME actor labels). ──
const ADDR: Record<string, string> = { A: "0x" + "a1".repeat(20), B: "0x" + "b2".repeat(20), C: "0x" + "c3".repeat(20) };
const rid = (label: string): string => payloadHash("wa-parity:" + label);

const H0 = V28_HEIGHT;
const resolveHeight = (tok: string): number => {
  const m = /^H0(?:\+(\d+))?$/.exec(tok);
  if (!m) throw new Error(`bad height token ${tok}`);
  return H0 + (m[1] ? Number(m[1]) : 0);
};
const resolveEe = (ee: EeSpec): number => {
  if (ee.kind === "epochOfPlus") return epochOf(resolveHeight(ee.of)) + ee.plus;
  throw new Error(`bad ee ${JSON.stringify(ee)}`);
};

const PE = (id: string, built: { uri: string; payloadHash: string }, height: number, proposer: string, expiresEpoch: number, pos = 0, paidTo: Record<string, string> = {}): ChainEvent =>
  ({ kind: "propose", id, proposer, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch, height, pos, paidTo });

// Materialise ONE scenario as abstract ChainEvents (the honest, on-chain-truth event set). The 'terms' family
// attacks live in the SERVED offer only, which this layer never sees, so the on-chain events are always honest.
function materialise(s: WaScenario): { events: ChainEvent[]; offerId: string; fillFclaimId: string; me: string; tip: number; pay?: string; withheldIds: string[] } {
  const idOf: Record<string, string> = {};
  const events: ChainEvent[] = [];
  const withheldIds: string[] = [];   // on-chain events the resolver hint list OMITS (F8 completeness attack)
  // backing (deploy + mint), shared across scenarios
  for (const b of corpus.backing) {
    const by = ADDR[b.by];
    const built = b.rec.t === "deploy"
      ? deploy({ ticker: b.rec.ticker!, decimals: b.rec.decimals!, supply: b.rec.supply!, mint: "issuer" })
      : mint({ ticker: b.rec.ticker!, amount: b.rec.amount! });
    const paidTo = b.fee === "DEPLOY_FEE" ? { [TREASURY_ADDR]: String(DEPLOY_FEE) } : {};
    events.push(PE(rid(s.name + ":" + (b.rec.t)), built, resolveHeight(b.height), by, 9e9, 0, paidTo));
  }
  // offer
  const offerId = rid(s.name + ":" + s.offer.id);
  idOf[s.offer.id] = offerId;
  const wantRec: { value: string; payto?: string } = { value: s.offer.want.value };
  if (s.offer.want.payto) wantRec.payto = ADDR[s.offer.want.payto];
  const offerBody: Parameters<typeof offer>[0] = { give: s.offer.give, want: wantRec };
  if (s.offer.min) (offerBody as { min?: string }).min = s.offer.min;
  events.push(PE(offerId, offer(offerBody), resolveHeight(s.offer.height), ADDR[s.offer.by], 9e9));
  // the primary fclaim
  const fcId = rid(s.name + ":" + s.fclaim.id);
  idOf[s.fclaim.id] = fcId;
  events.push(PE(fcId, fclaim({ offer: offerId }), resolveHeight(s.fclaim.height), ADDR[s.fclaim.by], resolveEe(s.fclaim.ee)));
  // extra events (a second fclaim, an ocancel)
  for (const e of s.extra) {
    const eid = rid(s.name + ":" + e.id);
    idOf[e.id] = eid;
    if (e.kind === "fclaim") {
      events.push(PE(eid, fclaim({ offer: offerId }), resolveHeight(e.height), ADDR[e.by], resolveEe(e.ee!)));
    } else if (e.kind === "ocancel") {
      events.push(PE(eid, offerCancelAll({ ticker: e.ticker! }), resolveHeight(e.height), ADDR[e.by], 9e9));
      if (e.withheld) withheldIds.push(eid.toLowerCase());   // on-chain but omitted from io.offerEventIds
    } else throw new Error(`bad extra kind ${e.kind}`);
  }
  // fill target + tip
  const fillFclaimId = idOf[s.fill.fclaim];
  const fillEe = resolveEe((s.extra.find((e) => e.id === s.fill.fclaim)?.ee) ?? s.fclaim.ee);
  let tip: number;
  if (s.fill.tip.kind === "holdEndMinus") tip = fclaimHoldEnd(fillEe) - s.fill.tip.n!;
  else if (s.fill.tip.kind === "absolute") tip = resolveHeight(s.fill.tip.h!);
  else throw new Error(`bad tip ${JSON.stringify(s.fill.tip)}`);
  return { events, offerId, fillFclaimId, me: ADDR[s.fill.me], tip, pay: s.fill.pay ?? undefined, withheldIds };
}

const idKey = (e: ChainEvent) => (e.kind === "propose" ? e.id : e.txid).toLowerCase();
function makeIo(events: ChainEvent[], tip: number, withheld: Set<string> = new Set()): FillSpvIo {
  return {
    async tip() { return tip; },
    // A withheld event is on-chain (provable) but OMITTED from the hint list - the exact F8 completeness attack.
    async offerEventIds() { return events.map(idKey).filter((id) => !withheld.has(id)); },
    async provenEvent(x: string) {
      const e = events.find((y) => idKey(y) === String(x).toLowerCase());
      return e ? ({ ...e, depth: tip - e.height + 1 } as ProvenEvent) : null;
    },
  };
}

const vfs = (oid: string, fc: string, me: string, io: FillSpvIo, pay?: string) =>
  verifyFillSpv(oid, fc, me, io, { myLiveHoldsAtGrant: 0, ...(pay !== undefined ? { pay } : {}) });

// ── 2. drive every scenario through the cairnx-core seam ──
let replayRun = 0, termsRun = 0;
for (const s of corpus.scenarios) {
  const { events, offerId, fillFclaimId, me, tip, pay, withheldIds } = materialise(s);
  const isCairnx = s.seams.includes("cairnxCore");
  const io = makeIo(events, tip, new Set(withheldIds));
  if (s.family === "replay") {
    if (isCairnx) {
      ok(withheldIds.length === 0, `[${s.name}] a cairnxCore replay scenario has no withheld events (nothing hidden from the pure layer)`);
      const v = await vfs(offerId, fillFclaimId, me, io, pay);
      ok(v.safe === (s.expect === "accept"), `[${s.name}] cairnx-core verdict = ${s.expect} (got safe=${v.safe} :: ${v.reason})`);
    } else {
      // seam-completeness (withheld event): the pure layer's event set IS the seam's hint list, so it CANNOT
      // catch an event withheld from that list. Assert it ACCEPTS - which is exactly why the wallet/site seams
      // must scan block bodies themselves (their adapters assert those seams REJECT this same scenario).
      ok(withheldIds.length > 0, `[${s.name}] a replay scenario excluding cairnxCore must be a withheld/seam-completeness case`);
      const v = await vfs(offerId, fillFclaimId, me, io, pay);
      ok(v.safe === true, `[${s.name}] cairnx-core ACCEPTS with the offending event withheld from its hint list; catching it is a SEAM obligation (${v.reason})`);
    }
    replayRun++;
  } else if (s.family === "terms") {
    // cairnx-core has NO served offer, so it CANNOT see a served-terms lie: assert it is correctly N/A here,
    // and that it ACCEPTS the honest underlying fill (proving the bind is genuinely the caller's job).
    ok(!isCairnx, `[${s.name}] terms-family scenario correctly EXCLUDES cairnxCore (no served offer at this layer)`);
    const v = await vfs(offerId, fillFclaimId, me, io, pay);
    ok(v.safe === true, `[${s.name}] cairnx-core ACCEPTS the honest underlying fill; the served-terms lie is above this layer (${v.reason})`);
    termsRun++;
  } else throw new Error(`unknown family ${(s as WaScenario).family}`);
}
ok(replayRun >= 7, `ran the replay-family scenarios through cairnx-core (${replayRun})`);
ok(termsRun >= 5, `confirmed the terms-family scenarios are cairnx-core-N/A + honest-accepting (${termsRun})`);

// ── 3. MUTATION GATE (load-bearing): the corpus reject-cases must be enforced by the actual guards. Remove
// the denied/superseded guard (MUTATE_GUARD_R) and confirm the denied-fclaim + ocancel-before-grant scenarios
// FLIP to accept - proving the corpus is not passing for an unrelated reason. Mirrors verifyfill.test.ts. ──
async function withGuardRemoved<T>(marker: string, run: (mod: typeof import("../src/verifyfill.js")) => Promise<T>): Promise<T> {
  const src = readFileSync(path.join(here, "..", "src", "verifyfill.ts"), "utf8");
  const kept = src.split("\n").filter((l) => !l.includes(marker));
  assert.ok(kept.length < src.split("\n").length, `sanity: ${marker} line exists to remove`);
  const tmp = path.join(here, "..", "src", `__waparity_mutant_${marker}.ts`);
  writeFileSync(tmp, kept.join("\n"));
  try { return await run((await import(pathToFileURL(tmp).href)) as typeof import("../src/verifyfill.js")); }
  finally { unlinkSync(tmp); }
}
{
  const flips = await withGuardRemoved("MUTATE_GUARD_R", async (mod) => {
    let n = 0;
    for (const name of ["denied-fclaim", "ocancel-before-grant"]) {
      const s = corpus.scenarios.find((x) => x.name === name)!;
      const { events, offerId, fillFclaimId, me, tip, pay } = materialise(s);
      const v = await mod.verifyFillSpv(offerId, fillFclaimId, me, makeIo(events, tip), { myLiveHoldsAtGrant: 0, ...(pay !== undefined ? { pay } : {}) });
      if (v.safe === true) n++;   // the guard removal FLIPPED a corpus reject-case to accept
    }
    return n;
  });
  ok(flips >= 1, `MUTATION: removing the denied/superseded guard flips a corpus reject-case to accept (${flips}) - the corpus is load-bearing`);
}

console.log(`wa-parity (cairnx-core seam): ${pass} checks passed`);

// ── types (structural; the json is the source of truth) ──
interface EeSpec { kind: "epochOfPlus"; of: string; plus: number }
interface TipSpec { kind: "holdEndMinus" | "absolute"; n?: number; h?: string }
interface WaExtra { kind: "fclaim" | "ocancel"; id: string; by: string; offer?: string; height: string; ee?: EeSpec; ticker?: string; withheld?: boolean }
interface WaScenario {
  name: string; family: "replay" | "terms"; seams: string[]; desc: string;
  offer: { id: string; by: string; height: string; give: { ticker: string; amount: string }; want: { value: string; payto: string | null }; min: string | null };
  fclaim: { id: string; by: string; offer: string; height: string; ee: EeSpec };
  extra: WaExtra[];
  fill: { me: string; fclaim: string; tip: TipSpec; pay: string | null };
  attack: { type: string; [k: string]: unknown };
  expect: "accept" | "reject";
}
interface WaCorpus {
  schemaVersion: number; note: string;
  consts: { V28_HEIGHT: number; EPOCH_LEN: number; FCLAIM_MAX_EPOCH_AHEAD: number; CLAIM_COOLDOWN_BLOCKS: number; FILL_TIP_MARGIN: number; TREASURY_ADDR: string; FEE_BPS_V16: number; note: string };
  actors: Record<string, { role: string }>;
  backing: { by: string; height: string; rec: { t: string; ticker?: string; decimals?: number; supply?: string; amount?: string }; fee?: string }[];
  scenarios: WaScenario[];
}
