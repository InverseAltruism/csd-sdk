// CairnX shared types. The convention is CONVENTION.md; these mirror it 1:1.
// v1   = tokens (deploy/mint/transfer) + offers/fills (atomic DvP).
// v1.1 = names (registrar, commit-reveal back-dating, transfer, set, name offers) + protocol fees.
import { EPOCH_LEN } from "@inversealtruism/csd-codec";

export const DOMAIN = "cairnx:v1";
export const ACTIVATION_HEIGHT = 29_860;      // tokens went live here
export const V11_HEIGHT = 29_960;             // names + protocol fees activate here (non-retroactive)
export const V12_HEIGHT = 30_300;             // token⇄token swaps + partial fills + bids (non-retroactive)
// v1.3 = CSD-priced offers must be taker-bound (the open CSD-quoted fill race can lose a buyer
// the FULL payment — irreversible on a no-escrow chain; CSD buys go bid→RFQ→taker-bound fill),
// and a name FILL re-stamps the ownership basis so a back-dated reveal can't displace a buyer.
export const V13_HEIGHT = 31_100;             // (non-retroactive)
// v1.4 = fill-before-cancel: a cancel/ocancel's EFFECT is deferred to the block boundary, so a
// same-block fill always wins. Kills the "cancel snipe" (a malicious seller front-runs a buyer's
// taker-bound fill with a cheap cancel/ocancel proposal to take the payment without delivering).
export const V14_HEIGHT = 31_400;             // (non-retroactive)
// v1.5 = name LEASING (the §9 promise): names are paid-through leases, renewable by anyone
// (nrenew + fee), grace-period for the owner, then a DECAYING-PREMIUM re-claim (ENS recapture
// model — squatting has a carrying cost, lapsed names return to the market at a fair price);
// plus tmeta (issuer-only token metadata pointer into the csd-swarm content layer).
export const V15_HEIGHT = 32_000;             // (non-retroactive)
// v1.6 = fee update + MAKER REBATE. The treasury trade fee rises 1%→1.5%, and a maker rebate
// (flat 0.25 CSD + 0.5%, taker-funded, routed to the offer's maker o.seller) rides resting-liquidity
// fills — in v1.6 that means BID-ANSWERED whole fills (the RFQ/MM lane). Both are captured per-offer
// at CREATION height (feeBps stored on the offer), so a pre-v1.6 offer keeps 1% and every historical
// replay stays byte-identical. (non-retroactive) — see cairn/docs/ecosystem/24. ACTIVATION set to
// 33_600 (above the 2026-06-15 deploy tip ~33.35k, max live offer 32665 — so non-retroactive). MUST
// be IDENTICAL in the UI mirror (cairn helpers.js), the wallet mirror (cairn-wallet cairnx.ts), and
// the Python port (conformance/cairnx_ref.py) — a divergence forks the fee/rebate.
export const V16_HEIGHT = 33_600;
// v1.7 = claim-to-fill. OPEN CSD offers return (the v1.3 taker-bound requirement is lifted at V17),
// made race-safe by a payment-free FIRST-CLAIM exclusivity: a SCORE_CLAIM attest reserves an open offer
// for the first claimer (by consensus order) for CLAIM_WINDOW_BLOCKS; only the live claimer may fill, so
// the same-block fill race moves to a payment-free claim and a losing buyer forfeits nothing. Bounded by
// a per-address concurrent-claim cap + an anti-recycle cooldown (doc 24 §4). (non-retroactive) Activation
// ≥ V16_HEIGHT; non-retroactive so it is safe even if the tip crosses it before the UI rollout completes
// (no claim attest / open CSD offer exists below it in the wild → nothing to reinterpret).
export const V17_HEIGHT = 34_000;
export { EPOCH_LEN };   // SINGLE-SOURCED from @inversealtruism/csd-codec (no re-declaration → no drift; audit M5)
// ── v1.5 lease parameters (epochs ≈ 1h: 30 blocks × ~2min) ──
export const NAME_TERM_EPOCHS = 8_760;        // one term ≈ 1 year
export const NAME_GRACE_EPOCHS = 720;         // ≈ 30 days: only the OWNER may renew in grace
export const NAME_PREMIUM_START = 20n;        // expired re-claim premium starts at 20× the reg fee…
export const NAME_PREMIUM_DECAY_EPOCHS = 720; // …decaying linearly to 1× over ≈ 30 days
/** Fee to claim a name whose lease lapsed (grace over): nameRegFee × a linearly-decaying
 *  premium. Pure in (name, epochsPastGraceEnd) — deterministic for every resolver. */
export function expiredClaimFee(name: string, epochsPastGraceEnd: number, height: number): bigint {
  const base = nameRegFee(name, height);
  if (epochsPastGraceEnd >= NAME_PREMIUM_DECAY_EPOCHS) return base;
  const left = BigInt(NAME_PREMIUM_DECAY_EPOCHS - epochsPastGraceEnd);
  // start×base shrinking linearly; integer math, never below base
  const mult = 1n + ((NAME_PREMIUM_START - 1n) * left) / BigInt(NAME_PREMIUM_DECAY_EPOCHS);
  return base * mult;
}
export const MAX_RECORD_BYTES = 512;          // consensus MAX_URI_BYTES — records live in `uri`
export const MAX_AMOUNT = (1n << 96n) - 1n;
export const SCORE_FILL = 100;
export const SCORE_CANCEL = 0;
// v1.7 claim-to-fill (gated at V17_HEIGHT). SCORE_CLAIM ∉ {SCORE_FILL, SCORE_CANCEL} → pre-V17 it hits
// the resolver's reserved-score no-op path, so a claim is inert below the gate (non-retroactive).
export const SCORE_CLAIM = 50;             // a payment-free claim attest on an open offer
export const CLAIM_WINDOW_BLOCKS = 15;     // <V20 — the original ~30-min exclusive fill window
// v2.0 (V20): the open-lane claim window + a bounded fill GRACE. The 15-block window was too small (a fill
// mining at the boundary burned the buyer's payment); V20 widens it to 40 (~80 min) and adds a 5-block grace
// during which the claimer's fill is still honored AND no other address may claim — so an in-window fill that
// mines slightly late still DELIVERS, with no displacement race. The hold = window + grace = 45 blocks. Gated
// at V20_HEIGHT (non-retroactive); MUST match cairnx_ref.py + helpers.js + the vendored wallet bundle.
export const CLAIM_WINDOW_BLOCKS_V20 = 40;
export const CLAIM_FILL_GRACE_BLOCKS = 5;
export const MAX_ACTIVE_CLAIMS = 3;        // a single address may hold ≤ this many LIVE claims at once (anti-squat)
export const CLAIM_COOLDOWN_BLOCKS = 15;   // a just-lapsed claimer cannot re-grab the SAME offer for this long
// Token-priced fills debit the ATTESTER's token balance, so they must be an explicit opt-in:
// normal signaling attests use confidence 0–100 — this magic value can't happen by accident.
export const CONF_TOKEN_FILL = 1_000_000;

// ── protocol treasury + fees (convention-enforced via same-tx outputs; see CONVENTION §8) ──
// p2pkh address; privkey held off-chain by the operator. Fees accrue as ordinary UTXOs.
export const TREASURY_ADDR = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016";
export const FEE_BPS = 100;                   // 1% taker fee — UNCHANGED; pre-v1.6 offers keep this (replay-identity)
export const FEE_BPS_V16 = 150;               // v1.6: 1.5% treasury fee on offers created at/after V16_HEIGHT
// v1.6 maker rebate (taker-funded, routed to o.seller): a flat 0.25 CSD reimburses the maker's propose
// (anchor) cost + 0.5% margin. Integer/ceil, pinned across impls. Applies to bid-answered whole fills.
export const REBATE_FLAT = 25_000_000n;       // 0.25 CSD
export const REBATE_BPS = 50;                 // 0.5%
export const DEPLOY_FEE = 100_000_000;        // 1 CSD to deploy a token
// v1.8: simplified 2-tier name fee — ACTIVATION (must match cairnx_ref.py + UI helpers.js + wallet
// cairnx.ts). BELOW this height the original ENS-style 5-tier curve is preserved BYTE-IDENTICALLY, so
// all historical replay + pinned vectors stay unchanged; AT/AFTER it a flat 2-tier applies. Height-pure
// → deterministic. Placeholder height — the operator sets the real activation at deploy (non-retroactive:
// no name registration below it is ever reinterpreted, so feesPaid / canonical state can't shift on replay).
export const V18_HEIGHT = 40_000;
export const NAME_FEE_SHORT_V18 = 670_000_000n;  // 6.7 CSD — names ≤ 4 chars (premium / anti-squat)
export const NAME_FEE_V18 = 300_000_000n;         // 3 CSD — names ≥ 5 chars
// v2.4: a steeper, length-graded short-name premium (anti-squat) — a 4-tier curve replacing the V18 2-tier.
// ACTIVATION gated at V24_HEIGHT (MUST match cairnx_ref.py + helpers.js + the vendored UI/wallet bundles + cli).
// BELOW this height the V18 2-tier is preserved BYTE-IDENTICALLY (every pre-V24 canonical hash + pinned vector
// stays unchanged). ⚠ HARD ADOPTION GATE (V23-class — a fee INCREASE is NOT fail-soft for stale VERIFIERS): at a
// tip >= V24 an attacker can register a 3-9 char name paying the OLD (lower) fee. A fresh resolver REJECTS it
// (oldFee < newFee); a STALE wallet/clarvis ACCEPTS it (oldFee still satisfies the old `feeToTreasury >= oldFee`),
// then the attacker nsets it — so every un-updated wallet resolves that name to the attacker and a third party
// paying it is MISDIRECTED. (The "overpay satisfies the old check" property only covers HONEST overpayers; the
// attacker pays EXACTLY the old fee, which ONLY a stale verifier accepts.) So EVERY replayer (Granus resolver,
// website bundle, cli, clarvis, Python oracle) AND the wallet (CWS — adoption-gated, not just published) MUST be
// on the V24 bundle BEFORE the tip crosses V24; set the height with runway for wallet adoption, like V23. (Honest
// registration is unaffected — the website builds the fee, the wallet only clear-signs it.) Height-pure / det.
// Set the real activation at deploy AFTER all mirrors ship: tip + enough blocks for the chosen runway.
export const V24_HEIGHT = 49_200;   // set ~7d out (tip ~44,150 + ~5050 ≈ 7 days) for wallet CWS adoption before the fee-increase gate
export const NAME_FEE_LEN3_V24 = 1_500_000_000n;  // 15 CSD — names ≤ 3 chars
export const NAME_FEE_LEN4_V24 = 1_000_000_000n;  // 10 CSD — names == 4 chars
export const NAME_FEE_MID_V24 = 500_000_000n;     // 5 CSD  — names 5–9 chars
export const NAME_FEE_LONG_V24 = 300_000_000n;    // 3 CSD  — names ≥ 10 chars
// v1.9 = ENS-class identity records (doc 36): a single inert `nprofile` record carries a charset-locked
// string→string map of identity keys (avatar/display/socials/url). Pure metadata — no value, no fee, no
// paidTo, NEVER a send target (the verified address stays in `nset`). Owner-gated, last-write-wins,
// cleared on every ownership change like `addr`. Applied + materialized at v1.9+ tips ONLY, so every
// pre-v1.9 canonical hash stays byte-identical. Placeholder height — operator sets the real activation
// (non-retroactive). MUST match cairnx_ref.py + the wallet/UI mirrors.
export const V19_HEIGHT = 36_700;
// v2.0 (V20): open-lane claim→fill LATE-FILL FUND-LOSS FIX. Below V20 an open offer's fill is honored ONLY
// while the claim window is live (`height < claimUntilHeight`), so a fill that mines AT/AFTER the boundary —
// having already paid the seller irreversibly — is rejected and the buyer loses the payment (the claim→fill
// is two txs; the payment is UTXO-final but the asset transfer is resolver-decided). v2.0 widens the window
// (15→40) and adds a BOUNDED fill grace: the recorded claimer's fill is honored — AND any other address's new
// claim is blocked — through `claimUntilHeight + CLAIM_FILL_GRACE_BLOCKS` (the hold = window 40 + grace 5 = 45
// blocks). The SAME interval governs both, so a slightly-late in-window fill still delivers with NO displacement
// race; it is NOT until-displaced — past the hold the offer reopens and a late fill is rejected (bounded).
// Non-retroactive: below V20 the strict-window behavior is byte-identical (every pre-V20 canonical hash is
// unchanged). Placeholder height — operator sets the real activation AFTER all mirrors (cairnx-core,
// cairnx_ref.py, UI helpers/state/swapguard, vendored wallet bundle) are redeployed. MUST match every mirror.
export const V20_HEIGHT = 38_400;
// v2.1 (V21): MAX offer/bid duration cap. An open offer/bid may rest at most MAX_OFFER_EPOCHS epochs (7 days)
// from its anchor — both rejected at creation if longer AND lazily swept once the effective (capped) expiry
// passes. WHY: the in-browser SPV light client must hold headers back to the oldest OPEN offer (the swapguard
// checkpoint sits below resting inventory); an unbounded-lifetime offer forces an ever-deeper checkpoint →
// slow cold sync. Capping listing lifetime keeps resting inventory shallow. The sweep cap is gated by the
// CURRENT sweep height (deterministic), so existing over-cap offers expire exactly at V21 across all replayers.
// Non-retroactive below V21 (every pre-V21 canonical hash unchanged). MUST match cairnx_ref.py + UI mirrors.
// Placeholder height — operator sets the real activation AFTER all mirrors are redeployed (deploy BEFORE the
// tip crosses it, else a stale resolver and a fresh one diverge at the gate).
export const V21_HEIGHT = 40_100;
export const MAX_OFFER_EPOCHS = 168;          // 7 days (1 epoch = EPOCH_LEN blocks ≈ 1h) — retained ONLY for the [V21,V22) era
// v2.2 (V22): REMOVE the offer/bid duration cap from consensus. Listing duration becomes a pure UI/product
// policy (enforced in the trade UI, not the chain) — see cairn docs/Plans/47. For an offer/bid anchored at
// height >= V22_HEIGHT the cap no longer applies (neither the creation reject NOR the lazy-sweep cap), so it
// may rest until its raw expiresEpoch — bounded only by the Number.isSafeInteger fork-guard in resolve.ts.
// RELAXATION (the HARD fork direction): keyed on the OFFER's ANCHOR height (ev.height), NOT the sweep height,
// so every pre-V21 hash AND all of [V21,V22) stay BYTE-IDENTICAL (offers anchored < V22 keep the exact V21
// behavior; only offers anchored >= V22 are un-capped). Every replayer (Granus cairnx, clarvis, the
// indexer-fed resolver, the wallet SPV bundle, cli) MUST upgrade BEFORE the tip crosses V22 — relaxation
// INVERTS the failure mode (a stale replayer REJECTS what a fresh one ACCEPTS, and the accepted long offer
// becomes load-bearing state the stale host lacks). The cold-sync backstop the cap used to provide moves to
// the light client (a bounded checkpoint window; offers older than it are simply not in-browser-fillable).
// PREREQUISITE: the indexer must store expires_epoch type-honestly (no clamp) so the isSafeInteger guard fires
// identically on Granus and SPV (GRX-WIRE-CLAMP-1, fixed in csd-indexer). FAST-ACTIVATION (operator, 2026-06-26):
// set near the tip. SAFE to activate before full wallet adoption because the relaxation is DORMANT under the UI's
// 1-week cap — no UI-created offer ever exceeds the old 168-epoch cap, so fresh and stale replayers compute
// IDENTICAL state until someone DELIBERATELY posts an over-cap offer via raw API. The residual fork surface is a
// deliberately-crafted over-cap offer (anchored >=V22) that gets FILLED → forks not-yet-updated wallets fail-soft
// (no theft); such an offer also stops being in-browser-fillable once it ages past the SPV checkpoint window
// (~16 days, NOT immediately) — "their issue". Operator MUST still deploy the
// SERVER-SIDE mirrors (Granus cairnx + cairnx-mm, clarvis, website, cli) BEFORE the tip crosses this height.
// MUST match cairnx_ref.py + the UI/vendored mirrors.
export const V22_HEIGHT = 41_300;   // set 2026-06-26 at tip ~41145 (+155, safe lockstep margin ≈ 90 min at the current rate; later activation is harmless — V22 is dormant under the UI cap). Below the gate 0.1.20 ≡ 0.1.19, so a mixed-version fleet does NOT fork during the deploy; the only requirement is ALL replayers on 0.1.20 BEFORE the tip reaches this height.
// v2.3 nset-clear ("unset"): at EVENT height >= V23_HEIGHT an `nset` whose addr is the ZERO address CLEARS
// the resolver record (n.addr = undefined => the name falls back to its owner, and drops out of the primary
// candidate set) instead of pointing at 0x000..0. Gated on event height so ALL history is byte-identical and
// the zero address is already a valid addr, so there is NO record-validation change (no parser-fork class).
// Below the gate the new core is byte-identical to the old, so a mixed-version fleet does NOT fork pre-V23.
// ⚠ DEPLOY (harder gate than V22): set this height only AFTER every vendored mirror (wallet cairnx-spv + cairn
// public/vendor/cairnx-core) carries the v23 branch AND the wallet update is ADOPTED (not merely published) on
// the Web Store. UNLIKE V22 (fail-soft: a stale resolver just REJECTS what a fresh one accepts), a stale wallet
// here does NOT reject: it replays a cleared name to 0x000..0, so a third-party send BURNS to the zero address,
// and the clarvis union does NOT rescue it (the send goes to the wallet's OWN replay winner, a disagreement is
// only flagged). So "all mirrors re-vendored + wallet ADOPTED" is a HARD fund-safety precondition, not just
// liveness/anti-fork. (The wallet also now hard-blocks any send resolving to 0x0, mitigating but not erasing
// this.) Tune the height to the wallet-ADOPTION date, not just publication. MUST match cairnx_ref.py + helpers.js + mirrors.
export const V23_HEIGHT = 52_000;   // set 2026-06-27 at tip ~41,836 (+~10,160 blocks ≈ 14 days @ ~718/day) — runway for wallet 0.2.36 CWS+website adoption before the unset feature activates chain-wide
export const ZERO_ADDR = "0x" + "00".repeat(20);   // the nset-clear sentinel (0x + 40 hex zeros)
// nprofile `p` keys: ENSIP-5-style (global + reverse-DNS service). Lowercase ASCII only, so the canonical
// key sort is INVARIANT under UTF-16 / UTF-8-byte / codepoint order (future-proof vs a 3rd-language
// resolver). Structurally NAME_RE + the `.` separator. Charset-VALIDATED, not allow-listed → new keys
// need no protocol bump. Values are strings only.
export const PKEY = /^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$/;
export const PROFILE_MAX_KEYS = 16;            // ≤ this many keys (DoS/clarity bound; the 512B record is the true cap)
export const PROFILE_MAX_VALUE_BYTES = 256;    // ≤ this many UTF-8 bytes per value
// name registration / renewal fee by length (base units). `height` selects the fee regime (the V18 gate).
export function nameRegFee(name: string, height: number): bigint {
  if (height >= V24_HEIGHT) {                       // v2.4 length-graded short-name premium (anti-squat)
    const ln = name.length;
    if (ln <= 3) return NAME_FEE_LEN3_V24;          // 15 CSD
    if (ln === 4) return NAME_FEE_LEN4_V24;         // 10 CSD
    if (ln <= 9) return NAME_FEE_MID_V24;           // 5 CSD (5–9 chars)
    return NAME_FEE_LONG_V24;                       // 3 CSD (≥10 chars)
  }
  if (height >= V18_HEIGHT) return name.length <= 4 ? NAME_FEE_SHORT_V18 : NAME_FEE_V18;
  const n = name.length;                           // pre-V18 ENS-style curve — FROZEN for replay-identity
  if (n <= 3) return 500_000_000n;                 // 5 CSD
  if (n === 4) return 200_000_000n;                // 2 CSD
  if (n === 5) return 100_000_000n;                // 1 CSD
  if (n <= 9) return 50_000_000n;                  // 0.5 CSD
  return 10_000_000n;                               // 0.1 CSD
}
// taker fee for a trade of `want` base units at `bps` (ceil) — always ≥ 0 (want may be 0 for giveaways).
// `bps` is the rate captured on the offer at creation (o.feeBps): 100 pre-v1.6, 150 from v1.6. Default
// FEE_BPS keeps every existing call site byte-identical.
export const tradeFee = (want: bigint, bps: number = FEE_BPS): bigint => (want * BigInt(bps) + 9999n) / 10000n;
// v1.6 maker rebate for a trade of `value` base units: flat + ceil(0.5%). Routed to o.seller, taker-paid.
export const makerRebate = (value: bigint): bigint => REBATE_FLAT + (value * BigInt(REBATE_BPS) + 9999n) / 10000n;

export const TICKER_RE = /^[A-Z][A-Z0-9]{2,11}$/;
export const ADDR_RE = /^0x[0-9a-f]{40}$/;
export const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;
// names: lowercase ASCII only (no unicode → no homograph/confusable class), 1–32 chars,
// alnum + internal hyphens, no leading/trailing hyphen. Single/double-char names are valid
// (premium-priced, see nameRegFee). Deterministic for every indexer.
export const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
export const HASH_RE = /^0x[0-9a-f]{64}$/;
export const SALT_RE = /^[0-9a-fA-F]{16,128}$/;   // commit salt — single-sourced (mirrored in cairnx_ref.py SALT_RE + crosscheck-regex)
// Reserved = generic authority/impersonation names that NOBODY may register (anti-phishing).
// The project's own brand (cairn/cairnx) is NOT reserved — it's registered + held by the operator.
export const RESERVED_NAMES = new Set(["csd", "treasury", "admin", "official", "root", "www", "support"]);
export const COMMIT_MAX_BLOCKS = 8 * EPOCH_LEN; // a name commit must be revealed within ~8h

// v2.5 = "sealed reservation" registration (root fix for the reveal fee-burn). At height >= V25 a `name`
// reveal is PAYMENT-FREE and creates a `pending` reservation (still snipe-resistant via the blind ncommit
// seal + back-dating); the reg fee moves to a new winner-only `nfinalize`, valid ONLY after the
// displacement contest is frozen. So a losing reveal costs only its ~0.25 anchor, never the reg fee.
// Registration ONLY (lapsed recapture is a later V26). Non-retroactive + emit-gated: every pre-V25 canonical
// hash is byte-identical, so a mixed-version fleet does NOT fork below the gate. HARD ADOPTION GATE (like V24):
// a stale wallet crossing V25 attaches a fee the fresh resolver IGNORES on the payment-free reveal (burn), so
// EVERY replayer AND the wallet must run the V25 core BEFORE the tip crosses V25_HEIGHT. Set the real
// activation at rollout (tip + a short lockstep margin, ~150 blocks like V22); 10_000_000 = a far-future
// placeholder that keeps V25 dormant for all dev replay/fuzz. MUST match cairnx_ref.py + helpers.js + wallet.
export const V25_HEIGHT = 10_000_000;
export const REG_COMMIT_MAX_BLOCKS = 8;       // register commit->reveal window AND the displacement freeze
                                              // (one value, both roles: the freeze must equal the window so
                                              //  no back-dated displacer can arrive after nfinalize). ~16 min.
export const REG_FINALIZE_GRACE_BLOCKS = 20;  // the winner's window to land nfinalize before the reservation
                                              // auto-expires (finalizeBy = effHeight + REG_COMMIT_MAX_BLOCKS + this).
                                              // Sized for comfortable headroom: the wallet signs at ~effHeight+10
                                              // (freeze + FINALIZE_TIP_MARGIN), leaving ~18 blocks (~36 min) for
                                              // the fee-bearing finalize to CONFIRM before finalizeBy, so a late
                                              // inclusion does not burn the reg fee. Does not slow legit
                                              // registration (finalize can land right after the freeze); only
                                              // extends the deadline. Dormant below V25 (byte-identical).
export const MAX_PENDING_REG = 3;             // per-address concurrent un-finalized reservations (anti-Sybil;
                                              // mirrors MAX_ACTIVE_CLAIMS). Excludes a same-name re-reveal.
export const FINALIZE_TIP_MARGIN = 2;         // wallet-side band (mirrors the V17 claimBlocksLeft >= 2 rule);
                                              // resolve() does not use it (client selector, single-sourced here).
// v2.6 = the SAME sealed-reservation cure applied to lapsed-name RECAPTURE (the up-to-~300 CSD premium burn:
// a losing recapture racer pays the full decaying premium and forfeits it). At height >= V26 a `name` reveal on
// a LAPSED name is PAYMENT-FREE and creates a recapture reservation (tracked in an internal `recaptures` map;
// the lapsed record in `names` is left UNTOUCHED so its premium basis is preserved and an abandoned reservation
// cannot bypass the premium); the decaying premium moves to the winner-only `nfinalize`, priced at the finalize
// height. Reuses REG_COMMIT_MAX_BLOCKS / REG_FINALIZE_GRACE_BLOCKS / MAX_PENDING_REG (own cap) / FINALIZE_TIP_MARGIN.
// Non-retroactive + the recaptures map is INTERNAL (not materialized), so every pre-V26 canonical hash is
// byte-identical. Independent gate from V25 (recapture is latent ~1yr; the operator may activate it later). Same
// HARD-ADOPTION-GATE discipline as V25 (a stale wallet crossing V26 attaches a premium the fresh resolver ignores
// -> burn). 10_000_000 = a far-future dormant placeholder. MUST match cairnx_ref.py + helpers.js + wallet.
export const V26_HEIGHT = 10_000_000;

export const epochOf = (height: number) => Math.floor(height / EPOCH_LEN);

// ── pure client-side selectors ──────────────────────────────────────────────────────────────────
// Exported so the browser UI / wallet / swapguard IMPORT these instead of re-deriving them (a
// re-derivation is a fork hazard — it forks who-may-fill / when-an-offer-expires). resolve() uses the
// same definitions internally, so the canonical resolver and these helpers cannot drift.

// The exclusivity window a claim placed at `height` is granted (V20+ is wider). claimUntilHeight = grant + this.
export const claimWindowAt = (height: number): number =>
  height >= V20_HEIGHT ? CLAIM_WINDOW_BLOCKS_V20 : CLAIM_WINDOW_BLOCKS;
// Inverse for a STORED claimUntilHeight: a V20 claim has claimUntilHeight ≥ V20+40, and the
// [V20+15, V20+40) range is unreachable, so this recovers the window baked into an existing claim
// unambiguously. (Mirrors the resolver's era inverse — see resolve.ts claimGrace.)
export const claimWindowOf = (claimUntilHeight: number): number =>
  (claimUntilHeight - CLAIM_WINDOW_BLOCKS_V20) >= V20_HEIGHT ? CLAIM_WINDOW_BLOCKS_V20 : CLAIM_WINDOW_BLOCKS;
// The fill GRACE baked into a stored claim (V20+ only = CLAIM_FILL_GRACE_BLOCKS, else 0), recovered from
// its era by the same unambiguous inverse. resolve()'s claimGrace(offer) is this applied to claimUntilHeight.
export const claimGraceOf = (claimUntilHeight: number): number =>
  (claimUntilHeight - CLAIM_WINDOW_BLOCKS_V20) >= V20_HEIGHT ? CLAIM_FILL_GRACE_BLOCKS : 0;
// The first height at which the resolver treats an offer/bid (anchored at `anchorHeight`, raw expiry epoch
// `expiresEpoch`) as EXPIRED — the height projection of effExpiry + sweepExpired (resolve.ts). v2.1 (≥V21)
// caps the effective expiry at anchorEpoch + MAX_OFFER_EPOCHS; v2.2 (anchor >= V22) REMOVES the cap (raw
// binds). Proven equivalent to the resolver's height-gated sweep; client-helpers.test.ts locks that
// equivalence over a grid spanning V21 and V22.
//   raw    = (expiresEpoch + 1) * EPOCH_LEN                       — first height with epochOf(h) > expiresEpoch
//   capped = (epochOf(anchor) + MAX_OFFER_EPOCHS + 1) * EPOCH_LEN — first height past the v2.1 cap
//   result = anchor >= V22 ? raw : min(raw, max(V21_HEIGHT, capped))
export const offerExpiryHeightOf = (expiresEpoch: number, anchorHeight: number): number => {
  const raw = (Number(expiresEpoch ?? 0) + 1) * EPOCH_LEN;
  if (anchorHeight >= V22_HEIGHT) return raw;   // v2.2: cap removed for offers anchored >= V22 (UI-only policy)
  const capped = (epochOf(anchorHeight) + MAX_OFFER_EPOCHS + 1) * EPOCH_LEN;
  return Math.min(raw, Math.max(V21_HEIGHT, capped));
};

// ── records (the canonical-JSON objects anchored in Propose.uri) ──
export interface DeployRecord {
  v: 1; t: "deploy"; ticker: string; name?: string; decimals: number;
  supply: string; mint: "open" | "issuer"; mintLimit?: string;
}
export interface MintRecord { v: 1; t: "mint"; ticker: string; amount?: string }
export interface TransferRecord {
  v: 1; t: "transfer"; ticker: string; to: string; amount: string; memo?: string; ts?: number;
}
// give is EITHER a fungible token amount OR a name (the asset being sold)
export type Give = { ticker: string; amount: string } | { name: string };
// want is EITHER a CSD value OR a token amount (v1.2 token⇄token swaps)
export type Want = { value: string; payto?: string } | { ticker: string; amount: string; payto?: string };
export interface OfferRecord {
  v: 1; t: "offer"; give: Give; want: Want;
  /** v1.2: smallest payment a partial fill may make (CSD-priced token offers only) */
  min?: string;
  /** v1.2: txid of the bid this offer responds to (informational RFQ link) */
  bid?: string;
  taker?: string; memo?: string; ts?: number;
}
// v1.2: non-binding buy-side intent — "I will pay give.value CSD for want"
export interface BidRecord {
  v: 1; t: "bid"; want: { ticker: string; amount: string } | { name: string };
  give: { value: string }; memo?: string; ts?: number;
}
// v1.2: mass-cancel all the proposer's open offers anchored strictly earlier (optional give filter)
export interface OfferCancelAllRecord { v: 1; t: "ocancel"; ticker?: string; name?: string }
// ── names (v1.1) ──
export interface NameCommitRecord { v: 1; t: "ncommit"; commit: string }
export interface NameRecord { v: 1; t: "name"; name: string; salt?: string }   // salt → reveal (back-dated)
// v2.5: the winner-only register finalize. salt MANDATORY (self-contained re-derivation of the deep commit);
// carries the reg fee to the treasury. Valid only after the displacement contest freezes (see V25_HEIGHT).
export interface NameFinalizeRecord { v: 1; t: "nfinalize"; name: string; salt: string }
export interface NameXferRecord { v: 1; t: "nxfer"; name: string; to: string }
export interface NameSetRecord { v: 1; t: "nset"; name: string; addr: string }
// ── v1.5 ──
export interface NameRenewRecord { v: 1; t: "nrenew"; name: string }          // anyone may pay; +1 term
export interface TokenMetaRecord { v: 1; t: "tmeta"; ticker: string; hash: string } // issuer-only swarm pointer
// ── v1.9 ──
// ENS-class identity. `p` = string→string map of ENSIP-5 keys (avatar/display/socials/url). INERT
// cosmetic metadata — never a send target (the verified address is `nset`). Empty `p` clears the profile.
export interface NameProfileRecord { v: 1; t: "nprofile"; name: string; p: Record<string, string> }
export type CairnXRecord =
  | DeployRecord | MintRecord | TransferRecord | OfferRecord | BidRecord | OfferCancelAllRecord
  | NameCommitRecord | NameRecord | NameFinalizeRecord | NameXferRecord | NameSetRecord
  | NameRenewRecord | TokenMetaRecord | NameProfileRecord;

// ── chain events fed to the resolver (consensus data, normalized) ──
export interface ProposeEvent {
  kind: "propose";
  id: string;           // proposal txid — also the offer/record id
  proposer: string;     // 0x…40 lowercase (consensus: hash160 of input[0] pubkey)
  uri: string;          // the record's canonical JSON (on-chain)
  payloadHash: string;  // 0x…64
  expiresEpoch: number;
  height: number;
  pos: number;          // tx index within the block (consensus order)
  paidTo: Record<string, string>; // per-address output sums of THIS tx (for protocol fees)
}
export interface AttestEvent {
  kind: "attest";
  txid: string;
  proposalId: string;   // the offer being filled/cancelled
  attester: string;     // 0x…40 lowercase
  score: number;
  confidence: number;   // v1.2: CONF_TOKEN_FILL marks an explicit token-debiting fill
  height: number;
  pos: number;
  paidTo: Record<string, string>; // per-address output sums of the attesting tx (payment + fee)
}
export type ChainEvent = ProposeEvent | AttestEvent;

// ── resolver output state ──
export interface TokenState {
  ticker: string; deployId: string; deployer: string; name?: string; decimals: number;
  supply: string; minted: string; mint: "open" | "issuer"; mintLimit?: string; height: number;
  /** v1.5: issuer-set csd-swarm content hash for {logo, description, links} (last write wins) */
  tmeta?: string;
}
export interface BalanceState { available: string; locked: string }
export interface NameState {
  name: string; owner: string; claimId: string; height: number; effectiveHeight: number;
  addr?: string;          // the resolver record (name → address), via name-set
  locked: boolean;        // true while an open offer holds it
  /** v1.3: ownership basis is a paid fill — record is displacement-immune (claimId/heights = the fill) */
  viaFill?: true;
  /** v1.5: the lease — owned through this epoch; +grace for owner-only renewal; then premium re-claim */
  paidThroughEpoch?: number;
  /** v1.5: true once the lease + grace lapsed (record kept for history; name is claimable) */
  expired?: true;
  /** v2.5: a payment-free registration reservation awaiting nfinalize. NOT resolvable (confers no address)
   *  and not actionable by the owner until finalized; auto-expires at finalizeBy. Materialized at v2.5+ tips
   *  only, so every pre-v2.5 canonical hash stays byte-identical. */
  pending?: true;
  finalizeBy?: number;
  /** v1.9: ENS-class identity — a charset-locked string→string map (doc 36). INERT cosmetic metadata
   *  (NOT a send target; the verified address is `addr`). Materialized at v1.9+ tips only, cleared on
   *  every ownership change, absent when empty. */
  profile?: Record<string, string>;
}
export type OfferStatus = "open" | "filled" | "cancelled" | "expired";
export interface FillEntry { buyer: string; txid: string; height: number; paid: string; fee: string; got?: string }
export interface OfferState {
  id: string; seller: string; give: Give;
  want: { value: string; payto: string } | { ticker: string; amount: string; payto: string };
  taker?: string;
  status: OfferStatus; expiresEpoch: number; height: number; feeBps: number;
  /** v1.2 partial fills: the maker's per-fill payment floor; presence ⇒ partially fillable */
  min?: string;
  /** v1.2: cumulative payment received / give delivered so far (partial offers only) */
  paid?: string; delivered?: string;
  /** v1.2: every partial fill in apply order */
  fills?: FillEntry[];
  /** v1.2: the bid this offer responds to */
  bid?: string;
  /** v1.7 claim-to-fill: the current exclusive claimer + the height their window ends. Lazy lapse —
   *  a past claimUntilHeight just means no live claim (the fields persist as the last-claim record). */
  claimedBy?: string; claimUntilHeight?: number;
  fill?: FillEntry;
}
export type BidStatus = "open" | "cancelled" | "expired" | "done";
export interface BidState {
  id: string; bidder: string;
  want: { ticker: string; amount: string } | { name: string };
  give: { value: string };
  status: BidStatus; expiresEpoch: number; height: number;
  /** offers anchored in response (tagged with this bid's id), in apply order */
  offers: string[];
}
export interface AppliedEvent {
  height: number; pos: number; id: string; kind: string; ok: boolean; note?: string;
}
export interface CairnXState {
  tipHeight: number;
  tokens: Record<string, TokenState>;
  balances: Record<string, Record<string, BalanceState>>; // ticker → addr → balance
  names: Record<string, NameState>;                        // name → state
  offers: Record<string, OfferState>;
  bids: Record<string, BidState>;                          // v1.2 buy-side intents
  /** v2.6 pending recapture reservations (name → the current winner). DIAGNOSTIC, excluded from canonicalState
   *  (like `events`); exposed so a wallet/UI can confirm it is still the winner before paying the premium.
   *  resolve() always returns it; the one initial-state literal (cairnx service) constructs an empty {}. */
  recaptures: Record<string, { owner: string; effectiveHeight: number; finalizeBy: number }>;
  events: AppliedEvent[];
  feesPaid: string;       // running total of protocol fees observed to the treasury (base units)
}

export const isNameGive = (g: Give): g is { name: string } => typeof (g as { name?: string }).name === "string";
export const isTokenWant = (w: Want | OfferState["want"]): w is { ticker: string; amount: string; payto?: string } =>
  typeof (w as { ticker?: string }).ticker === "string";
