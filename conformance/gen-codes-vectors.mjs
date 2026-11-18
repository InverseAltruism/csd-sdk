// Generator for the vectors of CONVENTION §40 (packages/cairnx/test/vectors/codes.json), the reason codes. Each resolve
// case is a short event stream whose expected log entry (kind and code) is written by hand next to each event, or
// none where the resolver writes no entry; the built dist must meet every expectation before the file is written,
// and no expectation is read back from resolve(). The expected `ok` is the code's outcome in the table. Rewrites the
// whole file, one case per line.
// Run: node conformance/gen-codes-vectors.mjs (after building packages/cairnx).
import { writeFileSync } from "node:fs";
import * as R from "../packages/cairnx/dist/index.js";

const T = R.TREASURY_ADDR;
const A = "0x" + "a1".repeat(20), B = "0x" + "b2".repeat(20), C = "0x" + "c3".repeat(20);
const HASH = "0x" + "ef".repeat(32);
let n = 0xc0de0000;
const nid = () => "0x" + (n++).toString(16).padStart(64, "0");
const fee = (v) => ({ [T]: String(v) });

// A Propose and its expected entry: [kind, code], or null for no entry.
const P = (built, height, who, expect, { paid = {}, ee = R.epochOf(height) + 1000, pos = 1 } = {}) => ({
  event: { kind: "propose", id: nid(), proposer: who, uri: built.uri, payloadHash: built.payloadHash, expiresEpoch: ee, height, pos, paidTo: paid },
  expect,
});

// An Attest on `target` (an item or a proposal id) and its expected entry.
const X = (target, height, who, score, expect, { paid = {}, conf = 0, pos = 2 } = {}) => ({
  event: { kind: "attest", txid: nid(), proposalId: typeof target === "string" ? target : target.event.id, attester: who, score, confidence: conf, height, pos, paidTo: paid },
  expect,
});
const idOf = (item) => item.event.id;

const cases = [];
const Case = (name, tipHeight, items) => cases.push({ name, tipHeight, items: items.flat(Infinity) });

// ── tokens (src/resolve/tokens.ts) ──
const H = 50_000;
const issuer = (ticker, supply = "1000") => R.deploy({ ticker, decimals: 0, supply, mint: "issuer" });
const DEPLOYED = ["deploy", "TOKEN_DEPLOYED"];
Case("deploy-applied", H + 5, [P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) })]);
Case("deploy-ticker-taken", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(issuer("AAA"), H + 1, B, ["deploy", "TOKEN_TICKER_TAKEN"], { paid: fee(R.DEPLOY_FEE) }),
]);
Case("deploy-fee-unpaid", H + 5, [P(issuer("AAA"), H, A, ["deploy", "TREASURY_FEE_UNPAID"], { paid: fee(R.DEPLOY_FEE - 1) })]);
Case("mint-issuer", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
]);
Case("mint-open", H + 5, [
  P(R.deploy({ ticker: "OPN", decimals: 0, supply: "1000", mint: "open", mintLimit: "10" }), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "OPN" }), H + 1, B, ["mint", "TOKEN_MINTED"]),
]);
Case("mint-unknown-ticker", H + 5, [P(R.mint({ ticker: "NOPE", amount: "1" }), H, A, ["mint", "TOKEN_UNKNOWN"])]);
Case("mint-supply-exhausted", H + 5, [
  P(issuer("AAA", "10"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
  P(R.mint({ ticker: "AAA", amount: "1" }), H + 2, A, ["mint", "TOKEN_SUPPLY_EXHAUSTED"]),
]);
Case("mint-not-issuer", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "1" }), H + 1, B, ["mint", "TOKEN_NOT_ISSUER"]),
]);
Case("mint-issuer-without-amount", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA" }), H + 1, A, ["mint", "TOKEN_MINT_AMOUNT_REQUIRED"]),
]);
Case("transfer-applied", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
  P(R.transfer({ ticker: "AAA", to: B, amount: "10" }), H + 2, A, ["transfer", "TOKEN_TRANSFERRED"]),
]);
Case("transfer-unknown-ticker", H + 5, [P(R.transfer({ ticker: "NOPE", to: B, amount: "1" }), H, A, ["transfer", "TOKEN_UNKNOWN"])]);
Case("transfer-balance-low", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker: "AAA", amount: "10" }), H + 1, A, ["mint", "TOKEN_MINTED"]),
  P(R.transfer({ ticker: "AAA", to: B, amount: "11" }), H + 2, A, ["transfer", "TOKEN_BALANCE_LOW"]),
]);
Case("tmeta-applied", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.tokenMeta({ ticker: "AAA", hash: HASH }), H + 1, A, ["tmeta", "TOKEN_META_SET"]),
]);
Case("tmeta-before-v15", R.V15_HEIGHT, [
  P(issuer("AAA"), R.V11_HEIGHT, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.tokenMeta({ ticker: "AAA", hash: HASH }), R.V15_HEIGHT - 1, A, ["tmeta", "GATE_NOT_ACTIVE"]),
]);
Case("tmeta-unknown-ticker", H + 5, [P(R.tokenMeta({ ticker: "NOPE", hash: HASH }), H, A, ["tmeta", "TOKEN_UNKNOWN"])]);
Case("tmeta-not-issuer", H + 5, [
  P(issuer("AAA"), H, A, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.tokenMeta({ ticker: "AAA", hash: HASH }), H + 1, B, ["tmeta", "TOKEN_NOT_ISSUER"]),
]);

// ── names (src/resolve/names.ts) ──
// N is above V28 and below V29; a sealed registration commits at h, reveals at h + 2 and finalizes at h + 10 (after the
// freeze of REG_COMMIT_MAX_BLOCKS, before finalizeBy at h + 28), so its lease runs from epochOf(h + 10).
const N = 61_000, OLD = 45_000;                    // OLD: after V18 and before V24, the pay-now registration
const SALT = "00112233445566778899aabbccddeeff", SALT2 = "ffeeddccbbaa99887766554433221100";
const commitOf = (name, owner, salt = SALT) => R.nameCommitRecord({ commit: R.nameCommit(name, salt, owner) });
const reveal = (name, salt = SALT) => R.nameClaim({ name, salt });
const regFee = (name, h) => fee(R.nameRegFee(name, h));
const COMMITTED = ["ncommit", "NAME_COMMITTED"], RESERVED = ["name", "NAME_RESERVED"], FINALIZED = ["nfinalize", "NAME_FINALIZED"];
const register = (name, owner, h) => [
  P(commitOf(name, owner), h, owner, COMMITTED),
  P(reveal(name), h + 2, owner, RESERVED),
  P(R.nameFinalize({ name, salt: SALT }), h + 10, owner, FINALIZED, { paid: regFee(name, h + 10) }),
];
const reserve = (name, owner, h, pos = 1) => [P(commitOf(name, owner), h, owner, COMMITTED, { pos }), P(reveal(name), h + 2, owner, RESERVED, { pos })];
const paidThroughOf = (finalizeHeight) => R.epochOf(finalizeHeight) + R.NAME_TERM_EPOCHS;
const graceHeight = (finalizeHeight) => (paidThroughOf(finalizeHeight) + 1) * R.EPOCH_LEN;                 // first epoch of grace
const lapseHeight = (finalizeHeight) => (paidThroughOf(finalizeHeight) + R.NAME_GRACE_EPOCHS + 1) * R.EPOCH_LEN; // first lapsed epoch
const bare = (name, h, who, expect, paid = regFee(name, h)) => P(R.nameClaim({ name }), h, who, expect, { paid });

Case("name-register-sealed", N + 20, register("alice", A, N));
Case("name-reserve-displaces-later-anchor", N + 10, [
  P(commitOf("alice", A), N, A, COMMITTED), P(commitOf("alice", B), N + 1, B, COMMITTED),
  P(reveal("alice"), N + 3, B, RESERVED), P(reveal("alice"), N + 4, A, ["name", "NAME_RESERVED_DISPLACED"]),
]);
Case("name-taken-earlier-sealed", N + 10, [
  P(commitOf("alice", A), N, A, COMMITTED), P(commitOf("alice", B), N + 1, B, COMMITTED),
  P(reveal("alice"), N + 3, A, RESERVED), P(reveal("alice"), N + 4, B, ["name", "NAME_TAKEN_EARLIER"]),
]);
Case("name-reveal-without-commit", N + 10, [P(reveal("alice"), N, A, ["name", "NAME_NO_COMMIT"])]);
Case("name-without-salt-at-v25", N + 10, [bare("alice", N, A, ["name", "NAME_SALT_REQUIRED"])]);
Case("name-before-v11", R.V11_HEIGHT, [
  P(commitOf("alice", A), R.V11_HEIGHT - 10, A, ["ncommit", "GATE_NOT_ACTIVE"]),
  bare("alice", R.V11_HEIGHT - 5, A, ["name", "GATE_NOT_ACTIVE"]),
]);
Case("name-pay-now", OLD + 10, [bare("bob", OLD, A, ["name", "NAME_REGISTERED"])]);
Case("name-pay-now-displaces-later-anchor", OLD + 30, [
  bare("bob", OLD, A, ["name", "NAME_REGISTERED"]),
  P(commitOf("bob", B), OLD - 10, B, COMMITTED),
  P(reveal("bob"), OLD + 10, B, ["name", "NAME_REGISTERED_DISPLACED"], { paid: regFee("bob", OLD + 10) }),
]);
Case("name-pay-now-taken-earlier", OLD + 10, [bare("bob", OLD, A, ["name", "NAME_REGISTERED"]), bare("bob", OLD + 5, B, ["name", "NAME_TAKEN_EARLIER"])]);
Case("name-pay-now-fee-unpaid", OLD + 10, [bare("bob", OLD, A, ["name", "TREASURY_FEE_UNPAID"], {})]);
{
  // a name bought in a fill (viaFill) is not displaced by an earlier commit
  const want = 1_000_000n, o = P(R.offer({ give: { name: "carl" }, want: { value: String(want), payto: A }, taker: B }), OLD + 300, A, ["offer", "OFFER_CREATED"]);
  Case("name-taken-purchased", OLD + 330, [
    bare("carl", OLD, A, ["name", "NAME_REGISTERED"]), o,
    X(o, OLD + 302, B, R.SCORE_FILL, ["fill", "FILL_APPLIED"], { paid: { [A]: String(want), [T]: String(R.tradeFee(want, R.FEE_BPS_V16)) } }),
    P(commitOf("carl", C), OLD + 295, C, COMMITTED),
    P(reveal("carl"), OLD + 320, C, ["name", "NAME_TAKEN_PURCHASED"], { paid: regFee("carl", OLD + 320) }),
  ]);
}
Case("name-cap-pending-reservations", N + 10, [
  reserve("n1", A, N, 1), reserve("n2", A, N, 2), reserve("n3", A, N, 3),
  P(commitOf("n4", A), N, A, COMMITTED, { pos: 4 }), P(reveal("n4"), N + 2, A, ["name", "CAP_PENDING_RESERVATIONS"], { pos: 4 }),
]);
Case("nfinalize-salt-mismatch", N + 20, [reserve("dave", A, N), P(R.nameFinalize({ name: "dave", salt: SALT2 }), N + 10, A, ["nfinalize", "NAME_SALT_MISMATCH"], { paid: regFee("dave", N + 10) })]);
Case("nfinalize-too-early", N + 20, [reserve("dave", A, N), P(R.nameFinalize({ name: "dave", salt: SALT }), N + 8, A, ["nfinalize", "NAME_FINALIZE_TOO_EARLY"], { paid: regFee("dave", N + 8) })]);
// a finalize past finalizeBy finds no reservation: the sweep before each event drops it first (NAME_RESERVATION_EXPIRED
// at that site is a defensive check that no event reaches)
Case("nfinalize-after-finalize-by", N + 40, [reserve("dave", A, N), P(R.nameFinalize({ name: "dave", salt: SALT }), N + 29, A, ["nfinalize", "NAME_NO_RESERVATION"], { paid: regFee("dave", N + 29) })]);
Case("nfinalize-fee-unpaid", N + 20, [reserve("dave", A, N), P(R.nameFinalize({ name: "dave", salt: SALT }), N + 10, A, ["nfinalize", "TREASURY_FEE_UNPAID"], { paid: fee(R.nameRegFee("dave", N + 10) - 1n) })]);
Case("nfinalize-not-the-reserver", N + 20, [reserve("dave", A, N), P(R.nameFinalize({ name: "dave", salt: SALT }), N + 10, B, ["nfinalize", "NAME_NO_RESERVATION"], { paid: regFee("dave", N + 10) })]);
Case("nfinalize-before-v25", R.V25_HEIGHT, [P(R.nameFinalize({ name: "dave", salt: SALT }), R.V25_HEIGHT - 1, A, ["nfinalize", "GATE_NOT_ACTIVE"])]);
{
  const F = N + 10, G = graceHeight(F), L = lapseHeight(F);
  const XFER = R.nameXfer({ name: "alice", to: B }), SET = R.nameSet({ name: "alice", addr: B }), PROF = R.nameProfile({ name: "alice", p: { url: "https://example.org" } });
  Case("nxfer-applied", N + 30, [register("alice", A, N), P(XFER, N + 20, A, ["nxfer", "NAME_TRANSFERRED"])]);
  Case("nxfer-not-owner", N + 30, [register("alice", A, N), P(XFER, N + 20, B, ["nxfer", "NAME_NOT_OWNER"])]);
  Case("nxfer-pending", N + 10, [reserve("alice", A, N), P(XFER, N + 5, A, ["nxfer", "NAME_PENDING"])]);
  Case("nxfer-lapsed", L + 5, [register("alice", A, N), P(XFER, L, A, ["nxfer", "NAME_LAPSED"])]);
  Case("nxfer-locked", N + 30, [
    register("alice", A, N),
    P(R.offer({ give: { name: "alice" }, want: { value: "1000", payto: A } }), N + 20, A, ["offer", "OFFER_CREATED"]),
    P(XFER, N + 21, A, ["nxfer", "NAME_LOCKED"]),
  ]);
  Case("nset-applied", N + 30, [register("alice", A, N), P(SET, N + 20, A, ["nset", "NAME_ADDR_SET"])]);
  Case("nset-not-owner", N + 30, [register("alice", A, N), P(SET, N + 20, B, ["nset", "NAME_NOT_OWNER"])]);
  Case("nset-pending", N + 10, [reserve("alice", A, N), P(SET, N + 5, A, ["nset", "NAME_PENDING"])]);
  Case("nset-lapsed", L + 5, [register("alice", A, N), P(SET, L, A, ["nset", "NAME_LAPSED"])]);
  Case("nprofile-applied", N + 30, [register("alice", A, N), P(PROF, N + 20, A, ["nprofile", "NAME_PROFILE_SET"])]);
  Case("nprofile-not-owner", N + 30, [register("alice", A, N), P(PROF, N + 20, B, ["nprofile", "NAME_NOT_OWNER"])]);
  Case("nprofile-pending", N + 10, [reserve("alice", A, N), P(PROF, N + 5, A, ["nprofile", "NAME_PENDING"])]);
  Case("nprofile-lapsed", L + 5, [register("alice", A, N), P(PROF, L, A, ["nprofile", "NAME_LAPSED"])]);
  Case("nprofile-before-v19", R.V19_HEIGHT, [bare("bob", R.V19_HEIGHT - 100, A, ["name", "NAME_REGISTERED"]), P(PROF, R.V19_HEIGHT - 50, A, ["nprofile", "GATE_NOT_ACTIVE"])]);
  const RENEW = R.nameRenew({ name: "alice" });
  Case("nrenew-by-anyone", N + 30, [register("alice", A, N), P(RENEW, N + 20, B, ["nrenew", "NAME_RENEWED"], { paid: regFee("alice", N + 20) })]);
  Case("nrenew-before-v15", R.V15_HEIGHT, [P(RENEW, R.V15_HEIGHT - 1, A, ["nrenew", "GATE_NOT_ACTIVE"])]);
  Case("nrenew-pending", N + 10, [reserve("alice", A, N), P(RENEW, N + 5, A, ["nrenew", "NAME_PENDING"], { paid: regFee("alice", N + 5) })]);
  Case("nrenew-unknown-name", N + 10, [P(RENEW, N, A, ["nrenew", "NAME_NO_LIVE_LEASE"], { paid: regFee("alice", N) })]);
  Case("nrenew-lapsed", L + 5, [register("alice", A, N), P(RENEW, L, A, ["nrenew", "NAME_NO_LIVE_LEASE"], { paid: regFee("alice", L) })]);
  Case("nrenew-in-grace-by-another", G + 5, [register("alice", A, N), P(RENEW, G, B, ["nrenew", "NAME_GRACE_OWNER_ONLY"], { paid: regFee("alice", G) })]);
  Case("nrenew-in-grace-by-owner", G + 5, [register("alice", A, N), P(RENEW, G, A, ["nrenew", "NAME_RENEWED"], { paid: regFee("alice", G) })]);
  Case("nrenew-fee-unpaid", N + 30, [register("alice", A, N), P(RENEW, N + 20, A, ["nrenew", "TREASURY_FEE_UNPAID"])]);

  // recapture of a lapsed name (V26+): payment-free reservations, the premium at the winner's finalize
  const premium = (name, h) => fee(R.expiredClaimFee(name, R.epochOf(h) - (paidThroughOf(F) + R.NAME_GRACE_EPOCHS), h));
  Case("recapture-reserved-displaced-finalized", L + 40, [
    register("alice", A, N),
    P(commitOf("alice", B), L, B, COMMITTED), P(reveal("alice"), L + 2, B, ["name", "NAME_RECAPTURE_RESERVED"]),
    P(commitOf("alice", C), L - 1, C, COMMITTED), P(reveal("alice"), L + 3, C, ["name", "NAME_RECAPTURE_RESERVED_DISPLACED"]),
    P(R.nameFinalize({ name: "alice", salt: SALT }), L + 9, C, ["nfinalize", "NAME_RECAPTURE_FINALIZED"], { paid: premium("alice", L + 9) }),
  ]);
  Case("recapture-taken-earlier", L + 10, [
    register("alice", A, N),
    P(commitOf("alice", B), L, B, COMMITTED), P(reveal("alice"), L + 2, B, ["name", "NAME_RECAPTURE_RESERVED"]),
    P(commitOf("alice", C), L + 1, C, COMMITTED), P(reveal("alice"), L + 3, C, ["name", "NAME_TAKEN_EARLIER"]),
  ]);
  Case("recapture-without-salt", L + 10, [register("alice", A, N), bare("alice", L, B, ["name", "NAME_SALT_REQUIRED"])]);
  Case("recapture-salt-mismatch", L + 20, [
    register("alice", A, N), P(commitOf("alice", B), L, B, COMMITTED), P(reveal("alice"), L + 2, B, ["name", "NAME_RECAPTURE_RESERVED"]),
    P(R.nameFinalize({ name: "alice", salt: SALT2 }), L + 9, B, ["nfinalize", "NAME_SALT_MISMATCH"], { paid: premium("alice", L + 9) }),
  ]);
  Case("recapture-finalize-too-early", L + 20, [
    register("alice", A, N), P(commitOf("alice", B), L, B, COMMITTED), P(reveal("alice"), L + 2, B, ["name", "NAME_RECAPTURE_RESERVED"]),
    P(R.nameFinalize({ name: "alice", salt: SALT }), L + 8, B, ["nfinalize", "NAME_FINALIZE_TOO_EARLY"], { paid: premium("alice", L + 8) }),
  ]);
  Case("recapture-finalize-after-finalize-by", L + 40, [
    register("alice", A, N), P(commitOf("alice", B), L, B, COMMITTED), P(reveal("alice"), L + 2, B, ["name", "NAME_RECAPTURE_RESERVED"]),
    P(R.nameFinalize({ name: "alice", salt: SALT }), L + 29, B, ["nfinalize", "NAME_NO_RESERVATION"], { paid: premium("alice", L + 29) }),
  ]);
  Case("recapture-premium-unpaid", L + 20, [
    register("alice", A, N), P(commitOf("alice", B), L, B, COMMITTED), P(reveal("alice"), L + 2, B, ["name", "NAME_RECAPTURE_RESERVED"]),
    P(R.nameFinalize({ name: "alice", salt: SALT }), L + 9, B, ["nfinalize", "TREASURY_FEE_UNPAID"], { paid: { [T]: String(BigInt(premium("alice", L + 9)[T]) - 1n) } }),
  ]);
  const four = ["r1", "r2", "r3", "r4"];
  const L4 = lapseHeight(N + 3 * 40 + 10) + R.EPOCH_LEN;
  Case("recapture-cap-pending", L4 + 10, [
    four.map((nm, i) => register(nm, A, N + 40 * i)),
    four.slice(0, 3).map((nm, i) => [P(commitOf(nm, B), L4, B, COMMITTED, { pos: i + 1 }), P(reveal(nm), L4 + 2, B, ["name", "NAME_RECAPTURE_RESERVED"], { pos: i + 1 })]),
    P(commitOf("r4", B), L4, B, COMMITTED, { pos: 4 }), P(reveal("r4"), L4 + 2, B, ["name", "CAP_PENDING_RECAPTURES"], { pos: 4 }),
  ]);
}

// ── market proposes (src/resolve/market.ts) ──
const M = 61_000;
const tok = (ticker, owner, h, supply = "1000") => [
  P(issuer(ticker, supply), h, owner, DEPLOYED, { paid: fee(R.DEPLOY_FEE) }),
  P(R.mint({ ticker, amount: supply }), h + 1, owner, ["mint", "TOKEN_MINTED"]),
];
const csdOffer = (extra = {}) => R.offer({ give: { ticker: "AAA", amount: "10" }, want: { value: "100000000", payto: A }, ...extra });
const CREATED = ["offer", "OFFER_CREATED"];
const SAFE_MAX_PLUS_1 = 9_007_199_254_740_992;
Case("offer-created", M + 10, [tok("AAA", A, M - 10), P(csdOffer(), M, A, CREATED)]);
Case("offer-unknown-ticker", M + 10, [P(R.offer({ give: { ticker: "ZZZ", amount: "1" }, want: { value: "1", payto: A } }), M, A, ["offer", "TOKEN_UNKNOWN"])]);
Case("offer-balance-low", M + 10, [tok("AAA", A, M - 10), P(R.offer({ give: { ticker: "AAA", amount: "2000" }, want: { value: "1", payto: A } }), M, A, ["offer", "TOKEN_BALANCE_LOW"])]);
Case("offer-payto-treasury", M + 10, [tok("AAA", A, M - 10), P(R.offer({ give: { ticker: "AAA", amount: "1" }, want: { value: "1", payto: T } }), M, A, ["offer", "OFFER_PAYTO_TREASURY"])]);
Case("offer-expiry-unsafe", M + 10, [tok("AAA", A, M - 10), P(csdOffer(), M, A, ["offer", "EXPIRY_UNSAFE"], { ee: SAFE_MAX_PLUS_1 })]);
Case("offer-expiry-past", M + 10, [tok("AAA", A, M - 10), P(csdOffer(), M, A, ["offer", "EXPIRY_PAST"], { ee: R.epochOf(M) - 1 })]);
Case("offer-duration-over-v21-cap", 40_510, [tok("AAA", A, 40_400), P(csdOffer(), 40_500, A, ["offer", "EXPIRY_TOO_LONG"], { ee: R.epochOf(40_500) + R.MAX_OFFER_EPOCHS + 1 })]);
Case("offer-csd-open-in-v13-era", 33_010, [tok("AAA", A, 32_900), P(csdOffer(), 33_000, A, ["offer", "OFFER_TAKER_REQUIRED"])]);
Case("offer-token-want-before-v12", 30_110, [tok("AAA", A, 30_000), P(R.offer({ give: { ticker: "AAA", amount: "1" }, want: { ticker: "BBB", amount: "1" } }), 30_100, A, ["offer", "GATE_NOT_ACTIVE"])]);
Case("offer-name-before-v11", R.V11_HEIGHT, [P(R.offer({ give: { name: "alice" }, want: { value: "1", payto: A } }), R.V11_HEIGHT - 10, A, ["offer", "GATE_NOT_ACTIVE"])]);
Case("offer-name-not-owner", N + 30, [register("alice", A, N), P(R.offer({ give: { name: "alice" }, want: { value: "1", payto: B } }), N + 20, B, ["offer", "NAME_NOT_OWNER"])]);
Case("offer-name-pending", N + 10, [reserve("alice", A, N), P(R.offer({ give: { name: "alice" }, want: { value: "1", payto: A } }), N + 5, A, ["offer", "NAME_PENDING"])]);
Case("offer-name-locked", N + 30, [
  register("alice", A, N),
  P(R.offer({ give: { name: "alice" }, want: { value: "1", payto: A } }), N + 20, A, CREATED),
  P(R.offer({ give: { name: "alice" }, want: { value: "2", payto: A } }), N + 21, A, ["offer", "NAME_LOCKED"]),
]);
Case("offer-name-too-young", OLD + 110, [bare("bob", OLD, A, ["name", "NAME_REGISTERED"]), P(R.offer({ give: { name: "bob" }, want: { value: "1", payto: A } }), OLD + 100, A, ["offer", "NAME_TOO_YOUNG"])]);
Case("offer-name-lease-too-short", N + 30, [register("alice", A, N), P(R.offer({ give: { name: "alice" }, want: { value: "1", payto: A } }), N + 20, A, ["offer", "OFFER_LEASE_TOO_SHORT"], { ee: paidThroughOf(N + 10) + 1 })]);
const BID = R.bid({ want: { ticker: "AAA", amount: "1" }, give: { value: "1000" } });
Case("bid-created", M + 10, [P(BID, M, B, ["bid", "BID_CREATED"])]);
Case("bid-before-v12", R.V12_HEIGHT, [P(BID, R.V12_HEIGHT - 1, B, ["bid", "GATE_NOT_ACTIVE"])]);
Case("bid-expiry-unsafe", M + 10, [P(BID, M, B, ["bid", "EXPIRY_UNSAFE"], { ee: SAFE_MAX_PLUS_1 })]);
Case("bid-expiry-past", M + 10, [P(BID, M, B, ["bid", "EXPIRY_PAST"], { ee: R.epochOf(M) - 1 })]);
Case("bid-duration-over-v21-cap", 40_510, [P(BID, 40_500, B, ["bid", "EXPIRY_TOO_LONG"], { ee: R.epochOf(40_500) + R.MAX_OFFER_EPOCHS + 1 })]);
Case("ocancel-deferred", M + 10, [tok("AAA", A, M - 10), P(csdOffer(), M, A, CREATED), P(R.offerCancelAll(), M + 1, A, ["ocancel", "OFFER_BULK_CANCELLED"])]);
Case("ocancel-immediate-before-v14", 31_010, [tok("AAA", A, 30_800), P(csdOffer(), 30_900, A, CREATED), P(R.offerCancelAll(), 31_000, A, ["ocancel", "OFFER_BULK_CANCELLED"])]);
Case("ocancel-before-v12", R.V12_HEIGHT, [P(R.offerCancelAll(), R.V12_HEIGHT - 1, A, ["ocancel", "GATE_NOT_ACTIVE"])]);
{
  // fclaim (V28+): the grant ladder
  const GRANTED = ["fclaim", "CLAIM_GRANTED"];
  const fc = (offerItem, h, who, expect, E = R.fclaimEpochFor(h, offerItem.event.expiresEpoch), pos = 1) => P(R.fclaim({ offer: idOf(offerItem) }), h, who, expect, { ee: E, pos });
  const o = () => P(csdOffer(), M, A, CREATED);
  { const x = o(); Case("fclaim-granted", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, GRANTED)]); }
  Case("fclaim-before-v28", R.V28_HEIGHT, [P(R.fclaim({ offer: HASH }), R.V28_HEIGHT - 1, B, ["fclaim", "GATE_NOT_ACTIVE"])]);
  { const x = o(); Case("fclaim-expiry-unsafe", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, ["fclaim", "EXPIRY_UNSAFE"], SAFE_MAX_PLUS_1)]); }
  Case("fclaim-unknown-offer", M + 10, [P(R.fclaim({ offer: HASH }), M, B, ["fclaim", "OFFER_UNKNOWN"], { ee: R.epochOf(M) + 1 })]);
  { const x = o(); Case("fclaim-offer-cancelled", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"]), fc(x, M + 3, B, ["fclaim", "OFFER_NOT_OPEN"])]); }
  { const x = P(csdOffer({ taker: C }), M, A, CREATED); Case("fclaim-taker-bound", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, ["fclaim", "CLAIM_TAKER_BOUND"])]); }
  { const x = P(R.offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" } }), M, A, CREATED); Case("fclaim-token-priced", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, ["fclaim", "CLAIM_TOKEN_PRICED"])]); }
  { const x = P(csdOffer(), M, A, CREATED, { ee: R.epochOf(M) + 1 }); Case("fclaim-outlives-offer", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, ["fclaim", "CLAIM_OUTLIVES_OFFER"], R.epochOf(M) + 2)]); }
  { const x = o(); Case("fclaim-too-far-ahead", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, ["fclaim", "CLAIM_TOO_FAR_AHEAD"], R.epochOf(M + 1) + R.FCLAIM_MAX_EPOCH_AHEAD + 1)]); }
  { const x = o(); Case("fclaim-expiry-past", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, ["fclaim", "EXPIRY_PAST"], R.epochOf(M + 1) - 1)]); }
  { const x = o(); Case("fclaim-hold-live", M + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, GRANTED), fc(x, M + 2, C, ["fclaim", "CLAIM_HOLD_LIVE"])]); }
  {
    const x = o(), E = R.epochOf(M + 1), end = (E + 1) * R.EPOCH_LEN;   // the hold ends at end; the cooldown runs CLAIM_COOLDOWN_BLOCKS more
    Case("fclaim-cooldown", end + 10, [tok("AAA", A, M - 10), x, fc(x, M + 1, B, GRANTED, E), fc(x, end + 1, B, ["fclaim", "CLAIM_COOLDOWN"], R.epochOf(end + 1))]);
  }
  {
    const xs = [1, 2, 3, 4].map((i) => P(csdOffer(), M, A, CREATED, { pos: i }));
    Case("fclaim-cap-live-holds", M + 10, [tok("AAA", A, M - 10), xs, xs.slice(0, 3).map((x, i) => fc(x, M + 1, B, GRANTED, undefined, i + 1)), fc(xs[3], M + 1, B, ["fclaim", "CAP_LIVE_HOLDS"], undefined, 4)]);
  }
}

// ── attests (src/resolve/attest.ts) ──
{
  const want = 100_000_000n, feeOf = (v) => R.tradeFee(v, R.FEE_BPS_V16);
  // a whole CSD fill's outputs: price to payto (A, the seller), fee to the treasury, and the maker rebate to the seller on
  // an open ask (V17+, no taker) or a taker-bound answer to a bid
  const wholePay = (rebate) => ({ [A]: String(want + (rebate ? R.makerRebate(want) : 0n)), [T]: String(feeOf(want)) });
  const FILLED = ["fill", "FILL_APPLIED"];
  const bidItem = P(BID, M, A, ["bid", "BID_CREATED"]);
  Case("bidcancel-applied", M + 10, [bidItem, X(bidItem, M + 1, A, R.SCORE_CANCEL, ["bidcancel", "BID_CANCELLED"])]);
  { const b = P(BID, M, A, ["bid", "BID_CREATED"]); Case("bidcancel-not-bidder", M + 10, [b, X(b, M + 1, B, R.SCORE_CANCEL, ["bidcancel", "BID_NOT_BIDDER"])]); }
  { const b = P(BID, M, A, ["bid", "BID_CREATED"]); Case("bidcancel-not-open", M + 10, [b, X(b, M + 1, A, R.SCORE_CANCEL, ["bidcancel", "BID_CANCELLED"]), X(b, M + 2, A, R.SCORE_CANCEL, ["bidcancel", "BID_NOT_OPEN"])]); }
  { const x = P(csdOffer(), M, A, CREATED); Case("cancel-deferred", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"])]); }
  { const x = P(csdOffer(), 30_900, A, CREATED); Case("cancel-immediate-before-v14", 31_010, [tok("AAA", A, 30_800), x, X(x, 31_000, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"])]); }
  { const x = P(csdOffer(), M, A, CREATED); Case("cancel-not-seller", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, B, R.SCORE_CANCEL, ["cancel", "OFFER_NOT_SELLER"])]); }
  { const x = P(csdOffer(), M, A, CREATED); Case("cancel-not-open", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"]), X(x, M + 3, A, R.SCORE_CANCEL, ["cancel", "OFFER_NOT_OPEN"])]); }
  { const x = P(csdOffer({ taker: B }), M, A, CREATED); Case("cancel-firm-quote", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, A, R.SCORE_CANCEL, ["cancel", "OFFER_FIRM_QUOTE"])]); }
  {
    const x = P(csdOffer(), M, A, CREATED);
    const g = P(R.fclaim({ offer: idOf(x) }), M + 1, B, ["fclaim", "CLAIM_GRANTED"], { ee: R.fclaimEpochFor(M + 1, x.event.expiresEpoch) });
    Case("cancel-frozen-by-hold", M + 10, [tok("AAA", A, M - 10), x, g, X(x, M + 2, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCEL_HOLD_LIVE"])]);
    Case("fill-through-fclaim", M + 10, [tok("AAA", A, M - 10), x, g, X(g, M + 2, B, R.SCORE_FILL, FILLED, { paid: wholePay(true) })]);
    Case("fill-offer-id-during-hold", M + 10, [tok("AAA", A, M - 10), x, g, X(x, M + 2, B, R.SCORE_FILL, ["fill", "FILL_WRONG_TARGET"], { paid: wholePay(true) })]);
  }
  { const x = P(csdOffer(), M, A, CREATED); Case("fill-open-offer-without-hold", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 2, B, R.SCORE_FILL, ["fill", "FILL_NO_LIVE_CLAIM"], { paid: wholePay(true) })]); }
  { const x = P(csdOffer(), 30_900, A, CREATED); Case("fill-open-offer-in-v13-era", 31_210, [tok("AAA", A, 30_800), x, X(x, 31_200, B, R.SCORE_FILL, ["fill", "FILL_OPEN_LANE_CLOSED"], { paid: wholePay(false) })]); }
  {
    const x = P(csdOffer({ taker: B }), M, A, CREATED);
    const y = P(csdOffer(), 50_000, A, CREATED);
    Case("cancel-two-in-a-block", 50_010, [tok("AAA", A, 49_900), y, X(y, 50_005, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"], { pos: 1 }), X(y, 50_005, A, R.SCORE_CANCEL, ["cancel", "OFFER_CLOSED_BEFORE_CANCEL"], { pos: 2 })]);
    const z = P(csdOffer({ taker: B }), 50_000, A, CREATED);
    Case("cancel-after-same-block-fill", 50_010, [tok("AAA", A, 49_900), z, X(z, 50_005, A, R.SCORE_CANCEL, ["cancel", "OFFER_CLOSED_BEFORE_CANCEL"], { pos: 1 }), X(z, 50_005, B, R.SCORE_FILL, FILLED, { pos: 2, paid: wholePay(false) })]);
    Case("fill-not-taker", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, C, R.SCORE_FILL, ["fill", "FILL_NOT_TAKER"], { paid: wholePay(false) })]);
    Case("fill-taker-bound", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, B, R.SCORE_FILL, FILLED, { paid: wholePay(false) })]);
    Case("fill-after-filled", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, B, R.SCORE_FILL, FILLED, { paid: wholePay(false) }), X(x, M + 2, B, R.SCORE_FILL, ["fill", "OFFER_NOT_OPEN"], { paid: wholePay(false) })]);
    Case("fill-underpaid", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, B, R.SCORE_FILL, ["fill", "FILL_UNDERPAID"], { paid: { [A]: String(want - 1n), [T]: String(feeOf(want)) } })]);
    Case("fill-fee-unpaid", M + 10, [tok("AAA", A, M - 10), x, X(x, M + 1, B, R.SCORE_FILL, ["fill", "TREASURY_FEE_UNPAID"], { paid: { [A]: String(want) } })]);
    const bidLinked = P(BID, M - 1, B, ["bid", "BID_CREATED"]);
    const answer = P(csdOffer({ taker: B, bid: idOf(bidLinked) }), M, A, CREATED);
    Case("fill-rebate-unpaid", M + 10, [tok("AAA", A, M - 10), bidLinked, answer, X(answer, M + 1, B, R.SCORE_FILL, ["fill", "FILL_REBATE_UNPAID"], { paid: wholePay(false) })]);
  }
  {
    // a fill on a denied fclaim pays and delivers nothing
    const x = P(csdOffer({ taker: C }), M, A, CREATED);
    const g = P(R.fclaim({ offer: idOf(x) }), M + 1, B, ["fclaim", "CLAIM_TAKER_BOUND"], { ee: R.fclaimEpochFor(M + 1, x.event.expiresEpoch) });
    Case("fill-on-denied-fclaim", M + 10, [tok("AAA", A, M - 10), x, g, X(g, M + 2, B, R.SCORE_FILL, ["fill", "FILL_FCLAIM_NOT_CURRENT"], { paid: wholePay(false) })]);
  }
  {
    // token-priced fills: 10 AAA for 5 BBB, the attester's BBB pays price and fee
    const tokenOffer = (extra = {}) => P(R.offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" }, ...extra }), M, A, CREATED);
    const setup = [tok("AAA", A, M - 10), tok("BBB", B, M - 8, "100")];
    const tf = (x, who, expect, conf = R.CONF_TOKEN_FILL, h = M + 1) => X(x, h, who, R.SCORE_FILL, expect, { conf });
    { const x = tokenOffer(); Case("token-fill", M + 10, [setup, x, tf(x, B, FILLED)]); }
    { const x = tokenOffer({ taker: B }); Case("token-fill-not-taker", M + 10, [setup, x, tf(x, C, ["fill", "FILL_NOT_TAKER"])]); }
    { const x = tokenOffer(); Case("token-fill-without-marker", M + 10, [setup, x, tf(x, B, ["fill", "FILL_NO_TOKEN_MARKER"], 0)]); }
    { const x = tokenOffer(); Case("token-fill-balance-low", M + 10, [setup, x, tf(x, C, ["fill", "TOKEN_BALANCE_LOW"])]); }
    { const x = tokenOffer(); Case("token-fill-after-cancel", M + 10, [setup, x, X(x, M + 1, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"]), tf(x, B, ["fill", "OFFER_NOT_OPEN"], R.CONF_TOKEN_FILL, M + 3)]); }
    { const x = P(R.offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "NOPE", amount: "5" } }), M, A, CREATED); Case("token-fill-want-ticker-unknown", M + 10, [setup, x, tf(x, B, ["fill", "TOKEN_UNKNOWN"])]); }
  }
  {
    // partial fills of a CSD-priced token offer, taker-bound so no hold is needed
    const pv = 1_000_000n, part = (give, min) => P(R.offer({ give: { ticker: "AAA", amount: give }, want: { value: String(pv), payto: A }, min, taker: B }), M, A, CREATED);
    const pf = (x, who, X_, expect, h = M + 1, withFee = true) => X(x, h, who, R.SCORE_FILL, expect, { paid: { [A]: String(X_), ...(withFee ? { [T]: String(feeOf(X_)) } : {}) } });
    { const x = part("100", "100000"); Case("partial-fill", M + 10, [tok("AAA", A, M - 10), x, pf(x, B, 200_000n, ["fill", "FILL_PARTIAL"])]); }
    { const x = part("100", "100000"); Case("partial-fill-below-min", M + 10, [tok("AAA", A, M - 10), x, pf(x, B, 99_999n, ["fill", "FILL_BELOW_MIN"])]); }
    { const x = part("100", "100000"); Case("partial-fill-fee-unpaid", M + 10, [tok("AAA", A, M - 10), x, pf(x, B, 200_000n, ["fill", "TREASURY_FEE_UNPAID"], M + 1, false)]); }
    { const x = part("1", "1"); Case("partial-fill-zero-delivery", M + 10, [tok("AAA", A, M - 10), x, pf(x, B, 1n, ["fill", "FILL_ZERO_DELIVERY"])]); }
    { const x = part("100", "100000"); Case("partial-fill-not-taker", M + 10, [tok("AAA", A, M - 10), x, pf(x, C, 200_000n, ["fill", "FILL_NOT_TAKER"])]); }
    { const x = part("100", "100000"); Case("partial-fill-after-filled", M + 10, [tok("AAA", A, M - 10), x, pf(x, B, pv, ["fill", "FILL_PARTIAL"]), pf(x, B, 200_000n, ["fill", "OFFER_NOT_OPEN"], M + 2)]); }
  }
  {
    // legacy claims (SCORE_CLAIM) in [V17, V28): window 40 and grace 5 since V20
    const LC = 50_000, CLAIMED = ["claim", "CLAIM_GRANTED"];
    const lc = (x, h, who, expect, pos = 2) => X(x, h, who, R.SCORE_CLAIM, expect, { pos });
    const off = (extra = {}, pos = 1) => P(csdOffer(extra), LC, A, CREATED, { pos });
    { const x = off(); Case("legacy-claim", LC + 10, [tok("AAA", A, LC - 10), x, lc(x, LC + 1, B, CLAIMED)]); }
    { const x = P(csdOffer(), M, A, CREATED); Case("legacy-claim-after-v28", M + 10, [tok("AAA", A, M - 10), x, lc(x, M + 1, B, ["claim", "CLAIM_LEGACY_SUNSET"])]); }
    { const x = off(); Case("legacy-claim-offer-cancelled", LC + 10, [tok("AAA", A, LC - 10), x, X(x, LC + 1, A, R.SCORE_CANCEL, ["cancel", "OFFER_CANCELLED"]), lc(x, LC + 3, B, ["claim", "OFFER_NOT_OPEN"])]); }
    { const x = off({ taker: C }); Case("legacy-claim-taker-bound", LC + 10, [tok("AAA", A, LC - 10), x, lc(x, LC + 1, B, ["claim", "CLAIM_TAKER_BOUND"])]); }
    { const x = P(R.offer({ give: { ticker: "AAA", amount: "10" }, want: { ticker: "BBB", amount: "5" } }), LC, A, CREATED); Case("legacy-claim-token-priced", LC + 10, [tok("AAA", A, LC - 10), x, lc(x, LC + 1, B, ["claim", "CLAIM_TOKEN_PRICED"])]); }
    { const x = off(); Case("legacy-claim-hold-live", LC + 10, [tok("AAA", A, LC - 10), x, lc(x, LC + 1, B, CLAIMED), lc(x, LC + 2, C, ["claim", "CLAIM_HOLD_LIVE"])]); }
    { const x = off(); Case("legacy-claim-cooldown", LC + 60, [tok("AAA", A, LC - 10), x, lc(x, LC + 1, B, CLAIMED), lc(x, LC + 51, B, ["claim", "CLAIM_COOLDOWN"])]); }
    {
      const xs = [1, 2, 3, 4].map((i) => off({}, i));
      Case("legacy-claim-cap-live-holds", LC + 10, [tok("AAA", A, LC - 10), xs, xs.slice(0, 3).map((x, i) => lc(x, LC + 1, B, CLAIMED, i + 1)), lc(xs[3], LC + 1, B, ["claim", "CAP_LIVE_HOLDS"], 4)]);
    }
  }
}

// ── check every expectation against the built dist, then write ──
const outcome = (code) => R.REASON_CODE_OUTCOME[code];
const fails = [];
const key = (x) => JSON.stringify(x);
const resolveCases = cases.map(({ name, tipHeight, items }) => {
  const events = items.map((i) => i.event);
  const expect = items.filter((i) => i.expect !== null).map(({ event, expect: [kind, code] }) => {
    if (outcome(code) === undefined) fails.push(`${name}: ${code} is not in the table`);
    return [event.kind === "propose" ? event.id : event.txid, kind, outcome(code) === "applied", code];
  });
  const got = R.resolve(events, tipHeight).events.map((e) => [e.id, e.kind, e.ok, e.code ?? null]);
  const want = expect.map(key).sort(), have = got.map(key).sort();
  if (key(want) !== key(have)) fails.push(`${name}: expected ${key(expect)}, resolve() wrote ${key(got)}`);
  return { name, tipHeight, events, expect };
});
const names = new Set();
for (const c of cases) { if (names.has(c.name)) fails.push(`${c.name}: repeated name`); names.add(c.name); }
if (fails.length) { for (const f of fails) console.error(`  EXPECTATION FAILED ${f}`); console.error(`\n${fails.length} expectation(s) failed: codes.json not written`); process.exit(1); }

const path = new URL("../packages/cairnx/test/vectors/codes.json", import.meta.url);
writeFileSync(path, `{"format":1,"generatedFrom":"hand-written expectations, conformance/gen-codes-vectors.mjs",\n`
  + `"resolve":[\n${resolveCases.map((c) => JSON.stringify(c)).join(",\n")}\n],\n"records":[\n]}\n`);
const codes = new Set(resolveCases.flatMap((c) => c.expect.map((e) => e[3])));
console.log(`wrote ${resolveCases.length} resolve cases (${codes.size} codes) -> codes.json (every hand-written expectation held)`);
