// CairnX shared types. The convention is CONVENTION.md; these mirror it 1:1.
// v1   = tokens (deploy/mint/transfer) + offers/fills (atomic DvP).
// v1.1 = names (registrar, commit-reveal back-dating, transfer, set, name offers) + protocol fees.

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
export const EPOCH_LEN = 30;
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
export const CLAIM_WINDOW_BLOCKS = 15;     // ~30 min at 120s/block — the claimer's exclusive fill window
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
// v1.9 = ENS-class identity records (doc 36): a single inert `nprofile` record carries a charset-locked
// string→string map of identity keys (avatar/display/socials/url). Pure metadata — no value, no fee, no
// paidTo, NEVER a send target (the verified address stays in `nset`). Owner-gated, last-write-wins,
// cleared on every ownership change like `addr`. Applied + materialized at v1.9+ tips ONLY, so every
// pre-v1.9 canonical hash stays byte-identical. Placeholder height — operator sets the real activation
// (non-retroactive). MUST match cairnx_ref.py + the wallet/UI mirrors.
export const V19_HEIGHT = 36_700;
// nprofile `p` keys: ENSIP-5-style (global + reverse-DNS service). Lowercase ASCII only, so the canonical
// key sort is INVARIANT under UTF-16 / UTF-8-byte / codepoint order (future-proof vs a 3rd-language
// resolver). Structurally NAME_RE + the `.` separator. Charset-VALIDATED, not allow-listed → new keys
// need no protocol bump. Values are strings only.
export const PKEY = /^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$/;
export const PROFILE_MAX_KEYS = 16;            // ≤ this many keys (DoS/clarity bound; the 512B record is the true cap)
export const PROFILE_MAX_VALUE_BYTES = 256;    // ≤ this many UTF-8 bytes per value
// name registration / renewal fee by length (base units). `height` selects the fee regime (the V18 gate).
export function nameRegFee(name: string, height: number): bigint {
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
// Reserved = generic authority/impersonation names that NOBODY may register (anti-phishing).
// The project's own brand (cairn/cairnx) is NOT reserved — it's registered + held by the operator.
export const RESERVED_NAMES = new Set(["csd", "treasury", "admin", "official", "root", "www", "support"]);
export const COMMIT_MAX_BLOCKS = 8 * EPOCH_LEN; // a name commit must be revealed within ~8h

export const epochOf = (height: number) => Math.floor(height / EPOCH_LEN);

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
  | NameCommitRecord | NameRecord | NameXferRecord | NameSetRecord
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
  events: AppliedEvent[];
  feesPaid: string;       // running total of protocol fees observed to the treasury (base units)
}

export const isNameGive = (g: Give): g is { name: string } => typeof (g as { name?: string }).name === "string";
export const isTokenWant = (w: Want | OfferState["want"]): w is { ticker: string; amount: string; payto?: string } =>
  typeof (w as { ticker?: string }).ticker === "string";
