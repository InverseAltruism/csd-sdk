// CairnX pure deterministic resolver (CONVENTION.md). (events, tipHeight) → CairnXState.
// No I/O, no clocks, no randomness, no float math on values: two resolvers fed the same chain
// prefix MUST produce byte-identical canonical state — that determinism IS the trust model. This is
// GUARDED (not merely asserted) by the JS⇄Python differential in conformance/: the raw regex-vs-regex
// check, the full parse gate, the nprofile cross-lang + constant-PARITY check, and the resolve fuzz —
// each byte-identical or the build fails.
//
// v1.1 adds: names (commit-reveal back-dated registrar + transfer + set + name offers) and
// protocol fees (deploy / name-reg / trade-taker) enforced by same-tx outputs to the treasury.
import { isName, nameCommit, parseAmount, parseRecord } from "./records.js";
import {
  ACTIVATION_HEIGHT, CLAIM_COOLDOWN_BLOCKS, COMMIT_MAX_BLOCKS, CONF_TOKEN_FILL, DEPLOY_FEE, FEE_BPS, FEE_BPS_V16,
  MAX_ACTIVE_CLAIMS, NAME_GRACE_EPOCHS, NAME_TERM_EPOCHS, SCORE_CANCEL, SCORE_CLAIM,
  SCORE_FILL, TREASURY_ADDR, V11_HEIGHT, V12_HEIGHT, V13_HEIGHT, V14_HEIGHT, V15_HEIGHT, V16_HEIGHT, V17_HEIGHT, V19_HEIGHT, V20_HEIGHT, V21_HEIGHT, MAX_OFFER_EPOCHS,
  claimGraceOf, claimWindowAt, epochOf, expiredClaimFee, isNameGive, isTokenWant, makerRebate, nameRegFee,
  tradeFee,
  type AppliedEvent, type BalanceState, type BidState, type CairnXState, type ChainEvent,
  type Give, type NameState, type OfferState, type ProposeEvent, type TokenState,
} from "./types.js";

interface Bal { available: bigint; locked: bigint }
interface Tok { meta: TokenState; minted: bigint; supply: bigint; mintLimit: bigint | null }
interface NameRec { owner: string; effHeight: number; pos: number; id: string; height: number; addr?: string; locked: boolean; viaFill?: boolean; paidThroughEpoch?: number; profile?: Record<string, string> }

// Ordinal (code-unit) string comparison — the ONLY comparator allowed anywhere in the resolver.
// localeCompare is ICU-collation-dependent and therefore non-reproducible across runtimes; a
// third-party (Rust/Go/…) resolver must be able to match byte-for-byte from plain byte order.
const ord = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function resolve(events: ChainEvent[], tipHeight: number): CairnXState {
  // consensus apply order: height asc; within a block all proposals (pos asc) then attests (pos asc);
  // final tiebreak = ordinal order of the lowercase 0x-hex id/txid (CONVENTION §3).
  const ordered = [...events].sort((a, b) =>
    a.height - b.height ||
    Number(a.kind === "attest") - Number(b.kind === "attest") ||
    a.pos - b.pos ||
    ord(
      a.kind === "propose" ? (a as ProposeEvent).id : (a as ChainEvent & { txid: string }).txid,
      b.kind === "propose" ? (b as ProposeEvent).id : (b as ChainEvent & { txid: string }).txid,
    ),
  );

  const tokens = new Map<string, Tok>();
  const balances = new Map<string, Map<string, Bal>>();       // ticker → addr → bal
  const names = new Map<string, NameRec>();                   // name → record
  const commits = new Map<string, number>();                  // commitHash → earliest height seen
  const offers = new Map<string, OfferState>();
  const offerLock = new Map<string, bigint>();                // token offers: id → locked amount
  const bids = new Map<string, BidState>();                   // v1.2 buy-side intents
  const log: AppliedEvent[] = [];
  let feesPaid = 0n;

  // v1.4 fill-before-cancel: at V14_HEIGHT+ a cancel/ocancel's EFFECT is deferred to the block
  // boundary, so any same-block fill wins — a seller can no longer snipe a buyer's in-flight
  // payment by front-running the fill with a cheap cancel (cancel applies first in consensus
  // order: proposals before attests, and a paid-up cancel attest can out-pos the fill). A fill
  // that lands = seller got paid = a completed sale; the late cancel then no-ops. Pre-v14 blocks
  // never populate pendingCancels, so all historical replay stays byte-identical.
  let pendingCancels: Array<() => void> = [];
  let pendingBlock = -1;
  const applyPendingCancels = () => { for (const f of pendingCancels) f(); pendingCancels = []; };

  const bal = (ticker: string, addr: string): Bal => {
    let m = balances.get(ticker);
    if (!m) { m = new Map(); balances.set(ticker, m); }
    let b = m.get(addr);
    if (!b) { b = { available: 0n, locked: 0n }; m.set(addr, b); }
    return b;
  };
  const note = (e: ChainEvent, id: string, kind: string, ok: boolean, why?: string) =>
    log.push({ height: e.height, pos: e.pos, id, kind, ok, ...(why ? { note: why } : {}) });

  // ── release the asset held by an offer (token amount unlock, or name unlock) ──
  const releaseGive = (o: OfferState) => {
    if (isNameGive(o.give)) { const n = names.get(o.give.name); if (n) n.locked = false; }
    else { const amt = offerLock.get(o.id) ?? 0n; const b = bal(o.give.ticker, o.seller); b.locked -= amt; b.available += amt; }
  };

  // lazily settle offers/bids whose window has ended before `height`. v2.1 (≥ V21): the EFFECTIVE expiry is
  // capped at anchorEpoch + MAX_OFFER_EPOCHS, so a long-resting offer/bid expires at the cap (and existing
  // over-cap inventory expires exactly when the sweep height first crosses V21). Gated by the sweep height →
  // deterministic across replayers; below V21 byte-identical to the old behavior.
  const effExpiry = (e: { expiresEpoch: number; height: number }, height: number): number =>
    height >= V21_HEIGHT ? Math.min(e.expiresEpoch, epochOf(e.height) + MAX_OFFER_EPOCHS) : e.expiresEpoch;
  const sweepExpired = (height: number) => {
    const ep = epochOf(height);
    for (const o of offers.values()) {
      if (o.status === "open" && ep > effExpiry(o, height)) { releaseGive(o); o.status = "expired"; }
    }
    for (const b of bids.values()) {
      if (b.status === "open" && ep > effExpiry(b, height)) b.status = "expired";
    }
  };

  // ── v1.5 leases ── a name claimed pre-v1.5 is GRANDFATHERED one full term from activation
  // (computed lazily — no state mutation at the activation boundary). A lease past its grace is
  // LAPSED: the name is unowned again (premium re-claim; viaFill immunity does not survive a
  // lapse — immunity protects a PAID basis, and an unpaid lease is an abandoned one).
  const V15_EPOCH = epochOf(V15_HEIGHT);
  const paidThrough = (n: NameRec): number => n.paidThroughEpoch ?? (V15_EPOCH + NAME_TERM_EPOCHS);
  const lapsed = (n: NameRec, ep: number): boolean => ep > paidThrough(n) + NAME_GRACE_EPOCHS;
  const inGrace = (n: NameRec, ep: number): boolean => ep > paidThrough(n) && !lapsed(n, ep);

  // an offer responding to a bid, filled by the bidder ⇒ the bid is satisfied (informational)
  const markBidDone = (o: OfferState, buyer: string) => {
    if (!o.bid) return;
    const b = bids.get(o.bid);
    if (b && b.status === "open" && b.bidder === buyer) b.status = "done";
  };
  // v1.7/v2.0: a claim grants the claimer an EXCLUSIVE HOLD of an open offer = a window (the exclusivity
  // period) + a fill GRACE (v2.0/V20 only). Within the hold the claimer's fill is honored AND no other
  // address may claim — both governed by the SAME interval — so a fill submitted in-window that mines
  // slightly late still DELIVERS instead of burning the already-paid seller value (the late-fill fund loss),
  // and there is NO displacement race (the holder is exclusive for the whole window+grace; below the grace a
  // new claim is rejected). Below V20: window 15, grace 0 → byte-identical history (non-retroactive). The
  // grace is derived from the claim's ERA so its inverse is UNAMBIGUOUS: a claim granted at ≥V20 has
  // claimUntilHeight = grantHeight + CLAIM_WINDOW_BLOCKS_V20 ≥ V20+40; a pre-V20 claim has ≤ V20+14; the
  // [V20+15, V20+40) range is unreachable, so `claimUntilHeight − 40 ≥ V20` ⟺ "this was a V20 claim".
  // the fill GRACE for a stored claim (claimGraceOf, imported from types — derived from the claim's era,
  // V20+ ⇒ CLAIM_FILL_GRACE_BLOCKS, else 0; undefined claimUntilHeight ⇒ 0). claimWindowAt is likewise the
  // imported selector, so the resolver and the exported client helpers share one definition (cannot drift).
  const claimGrace = (o: OfferState): number =>
    o.claimUntilHeight !== undefined ? claimGraceOf(o.claimUntilHeight) : 0;
  // is the offer still EXCLUSIVELY HELD (window + grace) at `height`? Lazy lapse — a past hold reads as
  // "not held" (no mutation). Used for BOTH the fill gate (with who===claimedBy) and the new-claim block.
  const claimHeld = (o: OfferState, height: number): boolean =>
    o.claimedBy !== undefined && o.claimUntilHeight !== undefined && height < o.claimUntilHeight + claimGrace(o);

  // ── shared SCORE_FILL helpers (dedup of the three fill paths — behaviour-preserving) ──
  // v1.7 open-fill gate: an untaken CSD offer (≥V13) is fillable only by the holder of a live claim;
  // in [V13,V17) open CSD fills stay banned. Returns the rejection reason, or undefined if allowed.
  const openFillReject = (o: OfferState, height: number, who: string): string | undefined => {
    if (!(height >= V13_HEIGHT && !o.taker)) return undefined;
    if (height < V17_HEIGHT) return "v1.3: open CSD-quoted fills disabled (offer must be taker-bound)";
    if (!(claimHeld(o, height) && who === o.claimedBy)) return "v1.7: open offer — claim it first (no live claim by you)";
    return undefined;
  };
  // a name sale (CSD or token fill) transfers ownership to the buyer, clears addr+profile, and — v1.3+ —
  // re-stamps the anchor to the fill itself with displacement-immune viaFill (red-team H3).
  const deliverNameToBuyer = (n: NameRec, who: string, ev: { height: number; pos: number; txid: string }) => {
    n.owner = who; n.locked = false; n.addr = undefined; n.profile = undefined; // sale clears the profile (doc 36)
    if (ev.height >= V13_HEIGHT) { n.effHeight = ev.height; n.pos = ev.pos; n.id = ev.txid; n.height = ev.height; n.viaFill = true; }
  };
  // release a token offer's locked give-amount in FULL to the buyer, consuming the lock so it can never
  // release twice. (The partial-fill path releases a sub-amount and keeps the lock — it does NOT use this.)
  const releaseGiveLock = (o: OfferState, who: string, amt: bigint) => {
    const t = (o.give as { ticker: string }).ticker;
    bal(t, o.seller).locked -= amt;
    bal(t, who).available += amt;
    offerLock.delete(o.id);
  };

  for (const ev of ordered) {
    if (ev.height < ACTIVATION_HEIGHT) continue;
    if (ev.height !== pendingBlock) { applyPendingCancels(); pendingBlock = ev.height; }
    sweepExpired(ev.height);
    const v11 = ev.height >= V11_HEIGHT;
    const v12 = ev.height >= V12_HEIGHT;
    const v15 = ev.height >= V15_HEIGHT;
    const v16 = ev.height >= V16_HEIGHT;
    const v19 = ev.height >= V19_HEIGHT;
    const feeToTreasury = ev.kind === "propose" ? BigInt((ev.paidTo ?? {})[TREASURY_ADDR] ?? "0") : 0n;

    if (ev.kind === "propose") {
      const rec = parseRecord(ev.uri, ev.payloadHash);
      if (!rec) { note(ev, ev.id, "invalid", false, "unparseable/non-canonical record"); continue; }
      const who = ev.proposer.toLowerCase();

      if (rec.t === "deploy") {
        if (tokens.has(rec.ticker)) { note(ev, ev.id, "deploy", false, "ticker taken (first anchor wins)"); continue; }
        if (v11 && feeToTreasury < BigInt(DEPLOY_FEE)) { note(ev, ev.id, "deploy", false, "deploy fee unpaid"); continue; }
        const supply = parseAmount(rec.supply)!;
        const mintLimit = rec.mint === "open" ? parseAmount(rec.mintLimit)! : null;
        tokens.set(rec.ticker, {
          minted: 0n, supply, mintLimit,
          meta: { ticker: rec.ticker, deployId: ev.id, deployer: who, name: rec.name, decimals: rec.decimals, supply: rec.supply, minted: "0", mint: rec.mint, mintLimit: rec.mintLimit, height: ev.height },
        });
        if (v11) feesPaid += BigInt(DEPLOY_FEE);
        note(ev, ev.id, "deploy", true);

      } else if (rec.t === "mint") {
        const tok = tokens.get(rec.ticker);
        if (!tok) { note(ev, ev.id, "mint", false, "unknown ticker"); continue; }
        const remaining = tok.supply - tok.minted;
        if (remaining <= 0n) { note(ev, ev.id, "mint", false, "supply exhausted"); continue; }
        let credit: bigint;
        if (tok.meta.mint === "issuer") {
          if (who !== tok.meta.deployer) { note(ev, ev.id, "mint", false, "issuer-only mint"); continue; }
          const req = rec.amount !== undefined ? parseAmount(rec.amount) : null;
          if (req === null) { note(ev, ev.id, "mint", false, "issuer mint requires amount"); continue; }
          credit = req < remaining ? req : remaining;
        } else {
          const req = rec.amount !== undefined ? parseAmount(rec.amount)! : tok.mintLimit!;
          const capped = req < tok.mintLimit! ? req : tok.mintLimit!;
          credit = capped < remaining ? capped : remaining;
        }
        tok.minted += credit;
        bal(rec.ticker, who).available += credit;
        note(ev, ev.id, "mint", true, credit.toString());

      } else if (rec.t === "transfer") {
        if (!tokens.has(rec.ticker)) { note(ev, ev.id, "transfer", false, "unknown ticker"); continue; }
        const amt = parseAmount(rec.amount)!;
        const from = bal(rec.ticker, who);
        if (from.available < amt) { note(ev, ev.id, "transfer", false, "insufficient available balance"); continue; }
        from.available -= amt;
        bal(rec.ticker, rec.to.toLowerCase()).available += amt;
        note(ev, ev.id, "transfer", true);

      // ── names (v1.1) ──
      } else if (rec.t === "ncommit") {
        if (!v11) { note(ev, ev.id, "ncommit", false, "before v1.1 activation"); continue; }
        const prev = commits.get(rec.commit);
        if (prev === undefined || ev.height < prev) commits.set(rec.commit, ev.height);
        note(ev, ev.id, "ncommit", true);

      } else if (rec.t === "name") {
        if (!v11) { note(ev, ev.id, "name", false, "before v1.1 activation"); continue; }
        // effective (anchor) height: a reveal back-dates to its commit height (front-run defense).
        let effHeight = ev.height;
        if (rec.salt !== undefined) {
          const ch = nameCommit(rec.name, rec.salt, who);
          const cH = commits.get(ch);
          if (cH === undefined || cH >= ev.height || ev.height - cH > COMMIT_MAX_BLOCKS) {
            note(ev, ev.id, "name", false, "no valid in-window commit for this reveal"); continue;
          }
          effHeight = cH;
        }
        const cur = names.get(rec.name);
        const epClaim = epochOf(ev.height);
        // v1.5: a LAPSED lease makes the name unowned again — claimable by anyone at the
        // decaying premium (squat recapture). The prior holder's basis is void, BUT the premium
        // re-claim establishes a fresh PAID basis, so it is itself displacement-immune (viaFill):
        // without this, a griefer who pre-commits the name before the lapse could reveal a
        // back-dated claim within COMMIT_MAX_BLOCKS and take the just-reclaimed name from the
        // premium payer for only the base reg fee — stealing it AND bypassing the premium entirely.
        if (cur && v15 && lapsed(cur, epClaim)) {
          const fee = expiredClaimFee(rec.name, epClaim - (paidThrough(cur) + NAME_GRACE_EPOCHS), ev.height);
          if (feeToTreasury < fee) { note(ev, ev.id, "name", false, "lapsed-name claim fee unpaid (decaying premium)"); continue; }
          for (const o of offers.values()) if (o.status === "open" && isNameGive(o.give) && o.give.name === rec.name) { releaseGive(o); o.status = "cancelled"; }
          names.set(rec.name, { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false, viaFill: true, paidThroughEpoch: epClaim + NAME_TERM_EPOCHS });
          feesPaid += fee;
          note(ev, ev.id, "name", true, "lapsed lease re-claimed (premium)");
          continue;
        }
        if (feeToTreasury < nameRegFee(rec.name, ev.height)) { note(ev, ev.id, "name", false, "name registration fee unpaid"); continue; }
        const cand: NameRec = { owner: who, effHeight, pos: ev.pos, id: ev.id, height: ev.height, locked: false,
          ...(v15 ? { paidThroughEpoch: epClaim + NAME_TERM_EPOCHS } : {}) };
        // lowest (effectiveHeight, pos, id) wins; a back-dated reveal can DISPLACE a squatter.
        // v1.3: displacement arbitrates claim-vs-claim ONLY — a record acquired by a paid fill
        // (viaFill, only ever set at v1.3+ fills) is immune, so a back-dated reveal can never
        // take a name from the innocent buyer of a completed sale (red-team H3).
        const better = !cur || (!cur.viaFill && (effHeight < cur.effHeight ||
          (effHeight === cur.effHeight && (ev.pos < cur.pos || (ev.pos === cur.pos && ev.id < cur.id)))));
        if (!better) { note(ev, ev.id, "name", false, cur?.viaFill ? "name taken (purchased — not displaceable)" : "name taken (earlier anchor wins)"); continue; }
        if (cur) {
          // displacement: void any open offer the wrongful holder made on this name. (The name
          // record itself is replaced below with locked:false, so the live name is never stuck;
          // releaseGive keeps lock-handling uniform with the cancel/expiry paths.)
          for (const o of offers.values()) if (o.status === "open" && isNameGive(o.give) && o.give.name === rec.name) { releaseGive(o); o.status = "cancelled"; }
        }
        names.set(rec.name, cand);
        feesPaid += nameRegFee(rec.name, ev.height);
        note(ev, ev.id, "name", true, cur ? "displaced prior holder" : undefined);

      } else if (rec.t === "nxfer") {
        const n = names.get(rec.name);
        if (!n || n.owner !== who) { note(ev, ev.id, "nxfer", false, "not the name owner"); continue; }
        if (v15 && lapsed(n, epochOf(ev.height))) { note(ev, ev.id, "nxfer", false, "lease lapsed — claim it instead"); continue; }
        if (n.locked) { note(ev, ev.id, "nxfer", false, "name is locked by an open offer"); continue; }
        n.owner = rec.to.toLowerCase(); n.addr = undefined; n.profile = undefined; // ownership change clears the profile (doc 36)
        note(ev, ev.id, "nxfer", true);

      } else if (rec.t === "nset") {
        const n = names.get(rec.name);
        if (!n || n.owner !== who) { note(ev, ev.id, "nset", false, "not the name owner"); continue; }
        if (v15 && lapsed(n, epochOf(ev.height))) { note(ev, ev.id, "nset", false, "lease lapsed — claim it instead"); continue; }
        n.addr = rec.addr.toLowerCase();
        note(ev, ev.id, "nset", true);

      } else if (rec.t === "nprofile") {
        // v1.9 ENS-class identity (doc 36). INERT metadata — no value/fee/paidTo, never a send target
        // (the verified address stays in `nset`). Owner-gated, last-write-wins; an empty `p` clears it.
        // Cleared on every ownership change (nxfer/fill/reclaim) exactly like `addr`.
        if (!v19) { note(ev, ev.id, "nprofile", false, "before v1.9 activation"); continue; }
        const n = names.get(rec.name);
        if (!n || n.owner !== who) { note(ev, ev.id, "nprofile", false, "not the name owner"); continue; }
        if (v15 && lapsed(n, epochOf(ev.height))) { note(ev, ev.id, "nprofile", false, "lease lapsed — claim it instead"); continue; }
        n.profile = Object.keys(rec.p).length ? { ...rec.p } : undefined;
        note(ev, ev.id, "nprofile", true);

      } else if (rec.t === "offer") {
        const wantIsToken = isTokenWant(rec.want);
        // v1.2 shapes (token-priced want, partial-fill min, bid link) are non-retroactive
        if ((wantIsToken || rec.min !== undefined || rec.bid !== undefined) && !v12) {
          note(ev, ev.id, "offer", false, "v1.2 offer shape before activation"); continue;
        }
        // v1.3: an open (non-taker-bound) CSD-priced offer is structurally unsafe — a lost
        // same-block fill race forfeits the loser's ENTIRE payment (no escrow on the substrate).
        // CSD buys go bid → taker-bound answer → race-free fill. Token⇄token stays open (no-op-safe).
        // v1.3 banned open CSD offers (the lost-fill-race forfeits a payment); v1.7 RE-ALLOWS them, made
        // race-safe by claim-to-fill (the fill is gated on a live claim below) — so the ban applies only
        // in [V13, V17). Below V17 this is byte-identical to the original gate.
        if (ev.height >= V13_HEIGHT && ev.height < V17_HEIGHT && !wantIsToken && rec.taker === undefined) {
          note(ev, ev.id, "offer", false, "v1.3: CSD-priced offers must be taker-bound (use bid/RFQ)"); continue;
        }
        const payto = (rec.want.payto ?? who).toLowerCase();
        if (payto === TREASURY_ADDR) { note(ev, ev.id, "offer", false, "payto cannot be the protocol treasury"); continue; }
        // expiresEpoch is an unbounded on-chain u64; one ≥ 2^53 is stored verbatim into the OPEN
        // offer's canonical state and serializes as the JS-specific "1e+21"/loses precision —
        // forking sha256(canonicalState) vs a u64/decimal resolver (audit M1). No live offer is
        // anywhere near 2^53 (max ~1e5), so rejecting the unrepresentable range is replay-identical.
        if (!Number.isSafeInteger(ev.expiresEpoch)) { note(ev, ev.id, "offer", false, "expiresEpoch out of safe-integer range"); continue; }
        if (epochOf(ev.height) > ev.expiresEpoch) { note(ev, ev.id, "offer", false, "already expired at anchor"); continue; }
        if (ev.height >= V21_HEIGHT && ev.expiresEpoch - epochOf(ev.height) > MAX_OFFER_EPOCHS) { note(ev, ev.id, "offer", false, "v2.1: offer duration exceeds the max"); continue; }
        const give: Give = rec.give;
        if (isNameGive(give)) {
          if (!v11) { note(ev, ev.id, "offer", false, "name offers need v1.1"); continue; }
          const n = names.get(give.name);
          if (!n || n.owner !== who) { note(ev, ev.id, "offer", false, "you don't own this name"); continue; }
          if (n.locked) { note(ev, ev.id, "offer", false, "name already locked by another offer"); continue; }
          // v1.3: a claim-based name may not be offered until its claim out-ages the commit
          // window — every lurking commit's reveal deadline passes BEFORE a sale can exist, so
          // viaFill immunity (below) can never shield a front-run squatter's quick flip.
          if (ev.height >= V13_HEIGHT && !n.viaFill && ev.height - n.effHeight <= COMMIT_MAX_BLOCKS) {
            note(ev, ev.id, "offer", false, "v1.3: name too young to sell (claim must out-age the commit window)"); continue;
          }
          // v1.5: the lease must outlive the offer window — so a fill can NEVER hit a lapsed
          // name (a no-op'd CSD fill would still have paid the seller; make it unrepresentable)
          if (v15 && paidThrough(n) < ev.expiresEpoch) {
            note(ev, ev.id, "offer", false, "v1.5: lease ends inside the offer window (renew first)"); continue;
          }
          n.locked = true;
        } else {
          if (!tokens.has(give.ticker)) { note(ev, ev.id, "offer", false, "unknown ticker"); continue; }
          const amt = parseAmount(give.amount)!;
          const s = bal(give.ticker, who);
          if (s.available < amt) { note(ev, ev.id, "offer", false, "insufficient available balance"); continue; }
          s.available -= amt; s.locked += amt; offerLock.set(ev.id, amt);
        }
        const o: OfferState = {
          id: ev.id, seller: who, give,
          want: wantIsToken
            ? { ticker: (rec.want as { ticker: string; amount: string }).ticker, amount: (rec.want as { ticker: string; amount: string }).amount, payto }
            : { value: (rec.want as { value: string }).value, payto },
          ...(rec.taker ? { taker: rec.taker.toLowerCase() } : {}),
          ...(rec.min !== undefined ? { min: rec.min, paid: "0", delivered: "0", fills: [] } : {}),
          ...(rec.bid !== undefined ? { bid: rec.bid } : {}),
          status: "open", expiresEpoch: ev.expiresEpoch, height: ev.height, feeBps: v11 ? (v16 ? FEE_BPS_V16 : FEE_BPS) : 0,
        };
        offers.set(ev.id, o);
        const linked = rec.bid !== undefined ? bids.get(rec.bid) : undefined;
        if (linked) linked.offers.push(ev.id);
        note(ev, ev.id, "offer", true);

      } else if (rec.t === "bid") {
        if (!v12) { note(ev, ev.id, "bid", false, "bids need v1.2"); continue; }
        if (!Number.isSafeInteger(ev.expiresEpoch)) { note(ev, ev.id, "bid", false, "expiresEpoch out of safe-integer range"); continue; }
        if (epochOf(ev.height) > ev.expiresEpoch) { note(ev, ev.id, "bid", false, "already expired at anchor"); continue; }
        if (ev.height >= V21_HEIGHT && ev.expiresEpoch - epochOf(ev.height) > MAX_OFFER_EPOCHS) { note(ev, ev.id, "bid", false, "v2.1: bid duration exceeds the max"); continue; }
        bids.set(ev.id, {
          id: ev.id, bidder: who, want: rec.want, give: rec.give,
          status: "open", expiresEpoch: ev.expiresEpoch, height: ev.height, offers: [],
        });
        note(ev, ev.id, "bid", true);

      } else if (rec.t === "ocancel") {
        if (!v12) { note(ev, ev.id, "ocancel", false, "ocancel needs v1.2"); continue; }
        // cancel all the proposer's open offers anchored strictly earlier in apply order
        // (snapshotting at apply-time is correct: higher-pos same-block offers aren't applied yet)
        const targets: OfferState[] = [];
        for (const o of offers.values()) {
          if (o.status !== "open" || o.seller !== who) continue;
          if (rec.ticker !== undefined && !(!isNameGive(o.give) && o.give.ticker === rec.ticker)) continue;
          if (rec.name !== undefined && !(isNameGive(o.give) && o.give.name === rec.name)) continue;
          targets.push(o);
        }
        if (ev.height >= V14_HEIGHT) {
          // v1.4: defer the effect to the block boundary — same-block fills win (anti-snipe)
          pendingCancels.push(() => {
            let n = 0;
            for (const o of targets) if (o.status === "open") { releaseGive(o); o.status = "cancelled"; n++; }
            note(ev, ev.id, "ocancel", true, `${n} cancelled (deferred past same-block fills)`);
          });
        } else {
          for (const o of targets) { releaseGive(o); o.status = "cancelled"; }
          note(ev, ev.id, "ocancel", true, `${targets.length} cancelled`);
        }

      // ── v1.5 ──
      } else if (rec.t === "nrenew") {
        if (!v15) { note(ev, ev.id, "nrenew", false, "nrenew needs v1.5"); continue; }
        const n = names.get(rec.name);
        const ep = epochOf(ev.height);
        if (!n || lapsed(n, ep)) { note(ev, ev.id, "nrenew", false, "no live lease (lapsed names are claimed, not renewed)"); continue; }
        // anyone may renew a LIVE lease (third-party gifting, ENS-style); in GRACE the owner
        // alone may — otherwise a squatter could extend a lapsing name they intend to take
        if (inGrace(n, ep) && who !== n.owner) { note(ev, ev.id, "nrenew", false, "grace period: only the owner may renew"); continue; }
        if (feeToTreasury < nameRegFee(rec.name, ev.height)) { note(ev, ev.id, "nrenew", false, "renewal fee unpaid"); continue; }
        n.paidThroughEpoch = paidThrough(n) + NAME_TERM_EPOCHS;
        feesPaid += nameRegFee(rec.name, ev.height);
        note(ev, ev.id, "nrenew", true, `paid through epoch ${n.paidThroughEpoch}`);

      } else if (rec.t === "tmeta") {
        if (!v15) { note(ev, ev.id, "tmeta", false, "tmeta needs v1.5"); continue; }
        const tok = tokens.get(rec.ticker);
        if (!tok) { note(ev, ev.id, "tmeta", false, "unknown ticker"); continue; }
        if (who !== tok.meta.deployer) { note(ev, ev.id, "tmeta", false, "issuer-only metadata"); continue; }
        tok.meta.tmeta = rec.hash;  // last write wins; content lives in csd-swarm (self-certifying)
        note(ev, ev.id, "tmeta", true);
      }

    } else {
      // ── attest: fill (score=100) / cancel (score=0) on a CairnX offer or bid ──
      const o = offers.get(ev.proposalId);
      const who = ev.attester.toLowerCase();
      if (!o) {
        // v1.2: bids are proposals too — the bidder cancels with score=0
        const b = bids.get(ev.proposalId);
        if (b && ev.score === SCORE_CANCEL) {
          if (who !== b.bidder) { note(ev, ev.txid, "bidcancel", false, "only bidder may cancel"); continue; }
          if (b.status !== "open") { note(ev, ev.txid, "bidcancel", false, `bid ${b.status}`); continue; }
          b.status = "cancelled";
          note(ev, ev.txid, "bidcancel", true);
        }
        continue; // attest on a non-CairnX proposal — not our event
      }

      if (ev.score === SCORE_CANCEL) {
        if (who !== o.seller) { note(ev, ev.txid, "cancel", false, "only seller may cancel"); continue; }
        if (o.status !== "open") { note(ev, ev.txid, "cancel", false, `offer ${o.status}`); continue; }
        if (ev.height >= V14_HEIGHT) {
          // v1.4: defer the effect to the block boundary — a same-block fill wins (anti-snipe)
          pendingCancels.push(() => {
            if (o.status === "open") { releaseGive(o); o.status = "cancelled"; note(ev, ev.txid, "cancel", true); }
            else note(ev, ev.txid, "cancel", false, "superseded by same-block fill (v1.4)");
          });
        } else {
          releaseGive(o); o.status = "cancelled";
          note(ev, ev.txid, "cancel", true);
        }

      } else if (ev.score === SCORE_FILL && isTokenWant(o.want)) {
        // ── v1.2 token-priced fill: the attester's want-tokens pay for the give ──
        if (o.status !== "open") { note(ev, ev.txid, "fill", false, `offer ${o.status}`); continue; }
        if (o.taker && who !== o.taker) { note(ev, ev.txid, "fill", false, "taker-bound offer"); continue; }
        // explicit opt-in marker: a plain signaling attest must never spend the attester's tokens
        if (ev.confidence !== CONF_TOKEN_FILL) { note(ev, ev.txid, "fill", false, "token fill requires confidence marker"); continue; }
        if (!tokens.has(o.want.ticker)) { note(ev, ev.txid, "fill", false, "want ticker does not exist"); continue; }
        const amt = BigInt(o.want.amount);
        const fee = o.feeBps ? tradeFee(amt, o.feeBps) : 0n; // in kind, debited convention-side (1.5% for v1.6 offers)
        const buyer = bal(o.want.ticker, who);
        if (buyer.available < amt + fee) { note(ev, ev.txid, "fill", false, "insufficient want-token balance"); continue; }
        // validate the give side BEFORE any mutation (check-then-act: a defensive no-op here
        // must not leave the buyer debited with nothing delivered)
        const giveName = isNameGive(o.give) ? names.get(o.give.name) : undefined;
        if (isNameGive(o.give) && !giveName) { note(ev, ev.txid, "fill", false, "name vanished (consensus violation)"); continue; }
        const giveLock = isNameGive(o.give) ? undefined : offerLock.get(o.id);
        if (!isNameGive(o.give) && giveLock === undefined) { note(ev, ev.txid, "fill", false, "offer lock missing"); continue; }
        // atomic swap: debit buyer, credit payto + treasury, deliver give to buyer
        buyer.available -= amt + fee;
        bal(o.want.ticker, o.want.payto).available += amt;
        if (fee > 0n) bal(o.want.ticker, TREASURY_ADDR).available += fee;
        if (isNameGive(o.give)) deliverNameToBuyer(giveName!, who, ev);
        else releaseGiveLock(o, who, giveLock!);
        o.status = "filled";
        o.fill = { buyer: who, txid: ev.txid, height: ev.height, paid: amt.toString(), fee: fee.toString() };
        markBidDone(o, who);
        note(ev, ev.txid, "fill", true);

      } else if (ev.score === SCORE_FILL && o.min !== undefined && !isNameGive(o.give)) {
        // ── v1.2 partial fill (CSD-priced token offer): payment X buys pro-rata, maker-favoring ──
        if (o.status !== "open") { note(ev, ev.txid, "fill", false, `offer ${o.status}`); continue; }
        if (o.taker && who !== o.taker) { note(ev, ev.txid, "fill", false, "taker-bound offer"); continue; }
        // v1.7: an open (non-taker) offer is fillable — but ONLY by the holder of a LIVE claim (the
        // claim-to-fill race-safety). In [V13, V17) open CSD fills stay banned (byte-identical to v1.3).
        const blk = openFillReject(o, ev.height, who);
        if (blk) { note(ev, ev.txid, "fill", false, blk); continue; }
        const pt = ev.paidTo ?? {};
        const want = BigInt((o.want as { value: string }).value);
        const paidSoFar = BigInt(o.paid ?? "0");
        const remaining = want - paidSoFar;
        const X = BigInt(pt[o.want.payto] ?? "0");
        const minV = BigInt(o.min);
        const effMin = remaining < minV ? remaining : minV;   // the tail is always buyable
        if (X < effMin) { note(ev, ev.txid, "fill", false, "payment below offer min"); continue; }
        const x = X < remaining ? X : remaining;              // overpayment is clamped
        const fee = o.feeBps ? tradeFee(x, o.feeBps) : 0n;    // 1.5% for v1.6 offers (partial fills carry NO maker rebate in v1.6)
        if (BigInt(pt[TREASURY_ADDR] ?? "0") < fee) { note(ev, ev.txid, "fill", false, "protocol fee unpaid"); continue; }
        const giveTotal = BigInt((o.give as { amount: string }).amount);
        const newPaid = paidSoFar + x;
        const deliveredSoFar = BigInt(o.delivered ?? "0");
        // cumulative pro-rata floor: never oversells, and the final fill delivers the exact remainder
        const newDelivered = (giveTotal * newPaid) / want;
        const out = newDelivered - deliveredSoFar;
        if (out === 0n) { note(ev, ev.txid, "fill", false, "fill too small to deliver any tokens"); continue; }
        const lock = offerLock.get(o.id);
        if (lock === undefined) { note(ev, ev.txid, "fill", false, "offer lock missing"); continue; }
        bal(o.give.ticker, o.seller).locked -= out;
        bal(o.give.ticker, who).available += out;
        offerLock.set(o.id, lock - out);
        o.paid = newPaid.toString(); o.delivered = newDelivered.toString();
        const entry = { buyer: who, txid: ev.txid, height: ev.height, paid: x.toString(), fee: fee.toString(), got: out.toString() };
        (o.fills ??= []).push(entry);
        feesPaid += fee;
        if (newPaid === want) {
          o.status = "filled"; o.fill = entry; offerLock.delete(o.id);
          markBidDone(o, who);
        }
        note(ev, ev.txid, "fill", true, `partial ${x}/${want}`);

      } else if (ev.score === SCORE_FILL) {
        if (o.status !== "open") { note(ev, ev.txid, "fill", false, `offer ${o.status}`); continue; }
        if (o.taker && who !== o.taker) { note(ev, ev.txid, "fill", false, "taker-bound offer"); continue; }
        // v1.7: an open (non-taker) offer is fillable — but ONLY by the holder of a LIVE claim (the
        // claim-to-fill race-safety). In [V13, V17) open CSD fills stay banned (byte-identical to v1.3).
        const blk = openFillReject(o, ev.height, who);
        if (blk) { note(ev, ev.txid, "fill", false, blk); continue; }
        const pt = ev.paidTo ?? {};
        const want = BigInt((o.want as { value: string }).value);
        const fee = o.feeBps ? tradeFee(want, o.feeBps) : 0n;
        // v1.6 maker rebate on a BID-ANSWERED whole fill (the RFQ/MM lane): the taker pays the maker
        // o.seller a flat 0.25 CSD + 0.5%, reimbursing the maker's posting (propose) cost. DERIVED from
        // the offer's creation height + bid link — NO new stored field, so every pre-v1.6 offer's
        // canonical state is byte-identical. (Partial fills + token⇄token carry no rebate in v1.6.)
        // maker rebate — RESTING-LIQUIDITY lanes only: a TAKER-BOUND answer to a bid (the v1.6 RFQ/MM
        // lane) OR a v1.7 OPEN ask (claim-to-fill, no taker). Closes a red-team finding (MED-2): keying
        // on `bid` alone let a maker self-attach an unanchored bid to an OPEN offer and self-mint a rebate.
        // Now an open offer earns it via the open-ask lane regardless of `bid`, and a bid-answer rebate
        // requires a real consenting taker (self-dealing is net-negative). Replay-identical in [V16,V17):
        // every bid-answered CSD offer there was taker-bound (the v1.3 ban), so `taker && bid` == `bid`.
        const restingLiquidity = (o.taker !== undefined && o.bid !== undefined) || (o.height >= V17_HEIGHT && o.taker === undefined);
        const rebate = (o.height >= V16_HEIGHT && restingLiquidity) ? makerRebate(want) : 0n;
        // combined same-tx output gate: SUM the required amount per recipient, so payto==o.seller (the
        // common case — a maker's payto defaults to itself) is correct: paidTo is an addr→sum map, so
        // the price and the rebate landing on the same address must be checked against their SUM, never
        // satisfied by max(). (payto can never be the treasury — rejected at offer creation — so those
        // two never collide.) For a pre-v1.6 offer (rebate=0n) this reduces to the old two checks exactly.
        const need = new Map<string, bigint>();
        const addNeed = (a: string, v: bigint) => need.set(a, (need.get(a) ?? 0n) + v);
        addNeed(o.want.payto, want);            // seller payment
        addNeed(TREASURY_ADDR, fee);            // treasury fee
        if (rebate > 0n) addNeed(o.seller, rebate); // v1.6 maker rebate
        // ACCUMULATE (not a Map literal): if any two recipients ever coincide (e.g. payto==seller, the
        // common case; or a hypothetical payto==treasury) the required amounts SUM — a literal would
        // silently overwrite and drop one, letting a fill underpay. Defense-in-depth on the value gate.
        let unpaid: string | undefined;
        for (const [addr, amt] of need) if (BigInt(pt[addr] ?? "0") < amt) {
          unpaid = addr === TREASURY_ADDR ? "protocol fee unpaid" : (rebate > 0n && addr === o.seller) ? "maker rebate unpaid (v1.6)" : "payment below want.value";
          break;
        }
        if (unpaid) { note(ev, ev.txid, "fill", false, unpaid); continue; }
        const paid = BigInt(pt[o.want.payto] ?? "0");
        // deliver the asset to the buyer
        if (isNameGive(o.give)) {
          const n = names.get(o.give.name);
          if (!n) { note(ev, ev.txid, "fill", false, "name vanished (consensus violation)"); continue; }
          deliverNameToBuyer(n, who, ev);
        } else {
          const amt = offerLock.get(o.id);
          if (amt === undefined) { note(ev, ev.txid, "fill", false, "offer lock missing"); continue; }
          releaseGiveLock(o, who, amt);
        }
        feesPaid += fee;
        o.status = "filled";
        o.fill = { buyer: who, txid: ev.txid, height: ev.height, paid: paid.toString(), fee: fee.toString() };
        markBidDone(o, who);
        note(ev, ev.txid, "fill", true);

      } else if (ev.height >= V17_HEIGHT && ev.score === SCORE_CLAIM) {
        // ── v1.7 claim-to-fill: reserve an OPEN CSD offer for the FIRST claimer (consensus order) for
        // CLAIM_WINDOW_BLOCKS. Payment-free → a losing same-block claimer forfeits only the attest fee,
        // never a payment. Only the live claimer may fill (enforced in the fill paths above). ──
        if (o.status !== "open") { note(ev, ev.txid, "claim", false, `offer ${o.status}`); continue; }
        if (o.taker) { note(ev, ev.txid, "claim", false, "taker-bound offer needs no claim"); continue; }
        if (isTokenWant(o.want)) { note(ev, ev.txid, "claim", false, "claims are for CSD-priced offers (token offers are no-op-safe)"); continue; }
        if (claimHeld(o, ev.height)) { note(ev, ev.txid, "claim", false, "offer already claimed (hold live)"); continue; }
        // anti-recycle: the JUST-LAPSED claimer cannot immediately re-grab the SAME offer (anyone else can).
        // KNOWN BOUND (intentional — identical in cairnx_ref.py, so NOT a cross-impl fork): the cooldown keys
        // on being the LAST claimer (o.claimedBy === who), so an intervening claim by a 2nd address resets it
        // and a colluding A→B→A pair can recycle one offer. Bounded by MAX_ACTIVE_CLAIMS + the claim being
        // payment-free → a griefing/liveness nuisance on a SINGLE offer, never value loss. Revisit (key the
        // cooldown on the offer, not the last claimer) if the open lane re-opens with a monopoly concern.
        // cooldown runs from the END of the hold (window + grace), so the grace can't be used to dodge it.
        if (o.claimedBy === who && o.claimUntilHeight !== undefined && ev.height < o.claimUntilHeight + claimGrace(o) + CLAIM_COOLDOWN_BLOCKS) {
          note(ev, ev.txid, "claim", false, "claim cooldown (you just held this offer)"); continue;
        }
        // per-address concurrent-claim cap (anti-squat): count offers this attester still HOLDS (window+grace),
        // so the V20 grace can't expand an address's effective concurrent reach past the cap.
        let liveN = 0; for (const x of offers.values()) if (x.claimedBy === who && claimHeld(x, ev.height)) liveN++;
        if (liveN >= MAX_ACTIVE_CLAIMS) { note(ev, ev.txid, "claim", false, `max ${MAX_ACTIVE_CLAIMS} live claims per address`); continue; }
        // grant. No expiry-clamp needed: a claim past the offer's expiry is moot (sweepExpired sets the
        // offer expired and a fill on a non-open offer is rejected) — the expiry always beats the claim.
        o.claimedBy = who; o.claimUntilHeight = ev.height + claimWindowAt(ev.height);
        note(ev, ev.txid, "claim", true);
      }
      // other scores: reserved → no-op
    }
  }

  applyPendingCancels();   // flush the final block's deferred cancels before the closing sweep
  sweepExpired(tipHeight + 1);

  // ── materialize canonical state (sorted; values as decimal strings) ──
  const tokensOut: Record<string, TokenState> = {};
  for (const [t, tok] of [...tokens.entries()].sort(([a], [b]) => ord(a, b))) tokensOut[t] = { ...tok.meta, minted: tok.minted.toString() };
  const balancesOut: Record<string, Record<string, BalanceState>> = {};
  for (const [t, m] of [...balances.entries()].sort(([a], [b]) => ord(a, b))) {
    const inner: Record<string, BalanceState> = {};
    for (const [a, b] of [...m.entries()].sort(([x], [y]) => ord(x, y))) {
      if (b.available === 0n && b.locked === 0n) continue;
      inner[a] = { available: b.available.toString(), locked: b.locked.toString() };
    }
    if (Object.keys(inner).length) balancesOut[t] = inner;
  }
  const namesOut: Record<string, NameState> = {};
  const tipV15 = tipHeight >= V15_HEIGHT;
  const tipV19 = tipHeight >= V19_HEIGHT;
  const tipEpoch = epochOf(tipHeight);
  for (const [nm, n] of [...names.entries()].sort(([a], [b]) => ord(a, b))) {
    namesOut[nm] = { name: nm, owner: n.owner, claimId: n.id, height: n.height, effectiveHeight: n.effHeight, locked: n.locked, ...(n.addr ? { addr: n.addr } : {}), ...(n.viaFill ? { viaFill: true as const } : {}),
      // v1.9 profile materialized at v1.9+ tips ONLY (the apply is also gated) → every pre-v1.9 canonical
      // hash stays byte-identical; absent when empty/unset.
      ...(tipV19 && n.profile ? { profile: n.profile } : {}),
      // lease fields exist only at v1.5+ tips so every pre-v1.5 canonical hash stays pinned
      ...(tipV15 ? { paidThroughEpoch: paidThrough(n), ...(lapsed(n, tipEpoch) ? { expired: true as const } : {}) } : {}) };
  }
  const offersOut: Record<string, OfferState> = {};
  for (const [id, o] of [...offers.entries()].sort(([a], [b]) => ord(a, b))) offersOut[id] = o;
  const bidsOut: Record<string, BidState> = {};
  for (const [id, b] of [...bids.entries()].sort(([a], [b2]) => ord(a, b2))) bidsOut[id] = b;

  return { tipHeight, tokens: tokensOut, balances: balancesOut, names: namesOut, offers: offersOut, bids: bidsOut, events: log, feesPaid: feesPaid.toString() };
}

/** Canonical serialization of state (FORMAT 2) — byte-identical across honest resolvers.
 *  The canonical surface is the DATA ONLY: {tipHeight, tokens, balances, names, offers, bids,
 *  feesPaid}. The applied-event log is deliberately EXCLUDED — its free-text reason strings are
 *  implementation diagnostics, and making them normative would force every third-party resolver
 *  to reproduce English prose byte-for-byte. (Format 1, pre-2026-06-12, included the log and
 *  sorted with localeCompare; pinned format-1 hashes live in test/vectors/replay-hashes.json
 *  history.) Keys sort in ordinal (code-unit) order at every depth. */
export function canonicalState(s: CairnXState): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => ord(a, b)).map(([k, x]) => [k, sortKeys(x)]));
    }
    return v;
  };
  const { events: _events, ...data } = s;
  return JSON.stringify(sortKeys(data));
}
