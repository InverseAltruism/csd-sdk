#!/usr/bin/env python3
"""
META-1 (audit) — INDEPENDENT second-language reference implementation of CairnX / CSD.

The trust model is "two honest resolvers, different code, converge byte-for-byte." This Python port
reproduces, from the spec (CONVENTION.md) and NOT transliterated from minified JS:
  * the determinism-critical primitives — canonical JSON (UTF-16-code-unit key sort), payload hash,
    well-formed (lone-surrogate) gate, the RES-H4 decay fixed-point;
  * the full record-validation gate (`parse_record`) — every `onlyKeys` allow-set + shape rule;
  * the FULL `resolve()` ledger — tokens / names (commit-reveal, lease) / offers / bids / fills /
    fees — producing a byte-identical `canonical_state` (the open half of META-1, now closed).

`crosscheck.mjs` feeds the shipping JS and this port the SAME corpus (fork-prone shapes) AND the
language-neutral vectors in `packages/cairnx/test/vectors/cases.json`, asserting byte-identity. A
JS-only fork (UTF-16-vs-codepoint sort, a dropped onlyKeys, a float, a non-pinned rounding) diverges
HERE. The canonical surface is DATA ONLY (the applied-event log is excluded — its prose is a
diagnostic, deliberately non-normative), so this port computes the ledger only.
"""
import json, sys, hashlib, re

# ── determinism helpers ──────────────────────────────────────────────────────────────────────────
MAX_DEPTH = 256

def u16key(s):
    """Sort key == JS string `<` (UTF-16 code-unit order). NOT codepoint/UTF-8-byte order (which
    diverges for astral chars — the exact fork the audit pinned). Bytes compare lexicographically =
    code-unit order."""
    return s.encode("utf-16-be")

def u16len(s):
    """JS `String.length` == count of UTF-16 code units (an astral codepoint is 2). Python `len` is
    codepoints — using it would fork at the 32-/64-unit boundaries (CONVENTION A6, records.ts:116)."""
    return len(s.encode("utf-16-le")) // 2

def lt(a, b):
    """JS string `<` (used for id/txid tiebreaks)."""
    return u16key(a) < u16key(b)

def _is_wellformed(s):
    try:
        s.encode("utf-8"); return True
    except UnicodeEncodeError:
        return False

def is_wellformed_deep(v):
    if isinstance(v, str): return _is_wellformed(v)
    if isinstance(v, list): return all(is_wellformed_deep(x) for x in v)
    if isinstance(v, dict): return all(_is_wellformed(k) and is_wellformed_deep(val) for k, val in v.items())
    return True

def _json_scalar(v):
    # match JS JSON.stringify for the scalar cases the canonical surface emits
    if v is None: return "null"
    if v is True: return "true"
    if v is False: return "false"
    if isinstance(v, bool): return "true" if v else "false"
    if isinstance(v, str): return json.dumps(v, ensure_ascii=False)
    if isinstance(v, int): return str(v)
    if isinstance(v, float):
        raise ValueError("CairnX forbids floats")  # never in the canonical surface
    raise ValueError("unhandled scalar")

def canonical_json(v, depth=0):
    """Byte-identical to csd-codec canonicalJson / JS JSON.stringify(sortKeys(...)): UTF-16-code-unit
    key sort at every depth, compact, MAX_DEPTH guard."""
    if depth > MAX_DEPTH: raise ValueError("canonicalJson: max nesting depth exceeded")
    if v is None or isinstance(v, bool) or not isinstance(v, (dict, list)):
        return _json_scalar(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x, depth + 1) for x in v) + "]"
    keys = sorted(v.keys(), key=u16key)
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(v[k], depth + 1) for k in keys) + "}"

def payload_hash(content):
    return "0x" + hashlib.sha256(canonical_json(content).encode("utf-8")).hexdigest()

# ── constants (mirror types.ts 1:1) ────────────────────────────────────────────────────────────────
ACTIVATION_HEIGHT = 29_860
V11_HEIGHT = 29_960
V12_HEIGHT = 30_300
V13_HEIGHT = 31_100
V14_HEIGHT = 31_400
V15_HEIGHT = 32_000
V16_HEIGHT = 33_600   # v1.6 fee update + maker rebate — ACTIVATION (must match types.ts/helpers.js/wallet)
V17_HEIGHT = 34_000   # v1.7 claim-to-fill — ACTIVATION (must match types.ts/helpers.js/wallet)
V18_HEIGHT = 40_000   # v1.8 simplified 2-tier name fee — ACTIVATION placeholder (must match types.ts/helpers.js/wallet)
NAME_FEE_SHORT_V18 = 670_000_000  # 6.7 CSD — names ≤ 4 chars (premium)
NAME_FEE_V18 = 300_000_000        # 3 CSD — names ≥ 5 chars
V24_HEIGHT = 49_200               # v2.4 length-graded short-name premium — HARD ADOPTION GATE (V23-class: a fee INCREASE forks STALE verifiers, see types.ts; deploy ALL mirrors + the wallet before the tip crosses it). Pre-V24 byte-identical. MUST match types.ts/helpers.js/wallet.
NAME_FEE_LEN3_V24 = 1_500_000_000 # 15 CSD — names ≤ 3 chars
NAME_FEE_LEN4_V24 = 1_000_000_000 # 10 CSD — names == 4 chars
NAME_FEE_MID_V24 = 500_000_000    # 5 CSD  — names 5–9 chars
NAME_FEE_LONG_V24 = 300_000_000   # 3 CSD  — names ≥ 10 chars
V19_HEIGHT = 36_700               # v1.9 ENS-class identity (nprofile) — ACTIVATION placeholder (must match types.ts/helpers.js/wallet)
V20_HEIGHT = 38_400              # v2.0 open-lane late-fill fix: honor the claimer's fill AND block new claims through claimUntilHeight+grace (BOUNDED hold = window 40 + grace 5; NOT until-displaced) — ACTIVATION placeholder (must match types.ts/helpers.js/wallet)
V21_HEIGHT = 40_100             # v2.1 max offer/bid duration cap — ACTIVATION (must match types.ts/helpers.js/wallet)
MAX_OFFER_EPOCHS = 168          # 7 days (1 epoch = EPOCH_LEN blocks ≈ 1h) — retained ONLY for the [V21,V22) era
V22_HEIGHT = 41_300             # v2.2 REMOVE the offer/bid duration cap from consensus (UI-only policy); keyed on the offer's ANCHOR height so [V21,V22) + pre-V21 stay byte-identical. Set 2026-06-26 at tip ~41145 (+155 safe lockstep margin); dormant under the UI cap so later activation is harmless. MUST match types.ts/helpers.js/wallet.
V23_HEIGHT = 52_000            # v2.3 nset-clear ("unset"): at EVENT height >= V23 an nset to the ZERO address clears n.addr (falls back to owner; drops out of primary). Gated on event height so all history is byte-identical; zero address is a valid addr so NO validation change. Set 2026-06-27 at tip ~41,836 (+~10,160 ≈ 14d) for wallet 0.2.36 adoption runway. MUST match types.ts/helpers.js/wallet.
ZERO_ADDR = "0x" + "00" * 20   # the nset-clear sentinel (0x + 40 hex zeros)
PROFILE_MAX_KEYS = 16             # nprofile `p`: ≤ keys ; ≤ value bytes (the 512B record is the true cap)
PROFILE_MAX_VALUE_BYTES = 256
EPOCH_LEN = 30
NAME_TERM_EPOCHS = 8_760
NAME_GRACE_EPOCHS = 720
NAME_PREMIUM_START = 20
NAME_PREMIUM_DECAY_EPOCHS = 720
MAX_RECORD_BYTES = 512
MAX_AMOUNT = (1 << 96) - 1
SCORE_FILL = 100
SCORE_CANCEL = 0
SCORE_CLAIM = 50            # v1.7 payment-free claim attest (∉ {SCORE_FILL, SCORE_CANCEL})
CLAIM_WINDOW_BLOCKS = 15
CLAIM_WINDOW_BLOCKS_V20 = 40   # v2.0 (V20): wider exclusive window (~80 min); MUST match types.ts/helpers.js/wallet
CLAIM_FILL_GRACE_BLOCKS = 5    # v2.0 (V20): bounded fill grace — fill honored + new-claim blocked through claimUntilHeight+grace
MAX_ACTIVE_CLAIMS = 3
CLAIM_COOLDOWN_BLOCKS = 15
CONF_TOKEN_FILL = 1_000_000
TREASURY_ADDR = "0x6b09ce74e6070ebc982ab0fb793a211c4d24f016"
FEE_BPS = 100
FEE_BPS_V16 = 150          # v1.6: 1.5% treasury fee on offers created at/after V16_HEIGHT
REBATE_FLAT = 25_000_000   # v1.6 maker rebate: flat 0.25 CSD
REBATE_BPS = 50            # …+ 0.5%
DEPLOY_FEE = 100_000_000
COMMIT_MAX_BLOCKS = 8 * EPOCH_LEN
# v2.5 sealed-reservation registration (payment-free reveal + winner-only nfinalize). Registration ONLY
# (lapsed recapture is a later V26). Non-retroactive + emit-gated -> pre-V25 byte-identical. HARD ADOPTION
# GATE (V24-class). 10_000_000 = far-future dev placeholder; operator sets the real activation at rollout
# (tip + ~150). MUST match types.ts/helpers.js/wallet.
V25_HEIGHT = 10_000_000
REG_COMMIT_MAX_BLOCKS = 8       # register commit->reveal window AND the displacement freeze (one value, both roles)
REG_FINALIZE_GRACE_BLOCKS = 20  # winner's window to land nfinalize before the reservation auto-expires (~36 min headroom)
MAX_PENDING_REG = 3             # per-address concurrent un-finalized reservations (anti-Sybil; excludes a re-reveal)
FINALIZE_TIP_MARGIN = 2         # wallet-side band (mirrors V17 claimBlocksLeft >= 2); resolve() does not use it
RESERVED_NAMES = {"csd", "treasury", "admin", "official", "root", "www", "support"}

TICKER_RE = re.compile(r"^[A-Z][A-Z0-9]{2,11}$")
ADDR_RE = re.compile(r"^0x[0-9a-f]{40}$")
AMOUNT_RE = re.compile(r"^(0|[1-9][0-9]*)$")
NAME_RE = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$")
PKEY = re.compile(r"^[a-z0-9](?:[a-z0-9.-]{0,30}[a-z0-9])?$")  # nprofile `p` keys = NAME_RE + "." ; ASCII → sort-invariant. Use .fullmatch for JS .test parity (no $-before-\n)
HASH_RE = re.compile(r"^0x[0-9a-f]{64}$")
SALT_RE = re.compile(r"^[0-9a-fA-F]{16,128}$")

def epoch_of(height): return height // EPOCH_LEN

def name_reg_fee(name, height):
    # v2.4 length-graded short-name premium at/after V24; v1.8 2-tier in [V18,V24); FROZEN ENS 5-tier below V18
    # (replay-identity). u16len == JS .length.
    if height >= V24_HEIGHT:
        n = u16len(name)
        if n <= 3: return NAME_FEE_LEN3_V24
        if n == 4: return NAME_FEE_LEN4_V24
        if n <= 9: return NAME_FEE_MID_V24
        return NAME_FEE_LONG_V24
    if height >= V18_HEIGHT:
        return NAME_FEE_SHORT_V18 if u16len(name) <= 4 else NAME_FEE_V18
    n = u16len(name)
    if n <= 3: return 500_000_000
    if n == 4: return 200_000_000
    if n == 5: return 100_000_000
    if n <= 9: return 50_000_000
    return 10_000_000

def expired_claim_fee(name, epochs_past_grace_end, height):
    base = name_reg_fee(name, height)
    if epochs_past_grace_end >= NAME_PREMIUM_DECAY_EPOCHS: return base
    left = NAME_PREMIUM_DECAY_EPOCHS - epochs_past_grace_end
    mult = 1 + ((NAME_PREMIUM_START - 1) * left) // NAME_PREMIUM_DECAY_EPOCHS
    return base * mult

def trade_fee(want, bps=FEE_BPS):  # ceil; integer; bps captured per-offer (100 pre-v1.6, 150 from v1.6)
    return (want * bps + 9999) // 10000

def maker_rebate(value):  # v1.6: flat 0.25 CSD + ceil(0.5%)
    return REBATE_FLAT + (value * REBATE_BPS + 9999) // 10000

def is_safe_int(n):
    return isinstance(n, int) and not isinstance(n, bool) and abs(n) <= (2**53 - 1)

# Read an externally-supplied paidTo/pt amount, fail-closed to 0 on any non-canonical value. MIRROR of
# resolve.ts ptAmt: BigInt(x)/int(x) accepted DISJOINT non-decimal forms (BigInt("0x10")=16 vs int("0x10")
# throws) — a latent JS<->Python fork the fuzz never reached. Gate through the SAME AMOUNT_RE record amounts
# use; byte-identical for every canonical scanner value, converges instead of value-vs-throw otherwise.
def _pt(v):
    return int(v) if isinstance(v, str) and AMOUNT_RE.fullmatch(v) else 0


# ── record validation gate (mirror records.ts parseRecord) ──────────────────────────────────────────
def parse_amount(s, allow_zero=False):
    if not isinstance(s, str) or not AMOUNT_RE.fullmatch(s): return None
    v = int(s)
    if v > MAX_AMOUNT: return None
    if v == 0 and not allow_zero: return None
    return v

def is_addr(a): return isinstance(a, str) and ADDR_RE.fullmatch(a) is not None
def is_ticker(t): return isinstance(t, str) and TICKER_RE.fullmatch(t) is not None
def is_hash(h): return isinstance(h, str) and HASH_RE.fullmatch(h) is not None
def is_name(n): return isinstance(n, str) and NAME_RE.fullmatch(n) is not None and n not in RESERVED_NAMES

def name_commit(name, salt, owner):
    return payload_hash({"t": "cairnx:name:commit:v1", "name": name, "salt": salt, "owner": owner.lower()})

DEPLOY_KEYS = {"v", "t", "ticker", "name", "decimals", "supply", "mint", "mintLimit"}
MINT_KEYS = {"v", "t", "ticker", "amount"}
TRANSFER_KEYS = {"v", "t", "ticker", "to", "amount", "memo", "ts"}
OFFER_KEYS = {"v", "t", "give", "want", "min", "bid", "taker", "memo", "ts"}
BID_KEYS = {"v", "t", "want", "give", "memo", "ts"}
NAME_KEYS = {"v", "t", "name", "salt"}
NFINALIZE_KEYS = {"v", "t", "name", "salt"}
NPROFILE_KEYS = {"v", "t", "name", "p"}

def _only_keys(r, allowed): return set(r.keys()) <= allowed

def parse_record(uri, payload_hash_hex):
    # PARITY (audit): a raw lone-surrogate uri must fail CLOSED — JS records.ts uses TextEncoder (surrogate-
    # tolerant, never throws), so the reference must REJECT (return None), not raise UnicodeEncodeError, or it
    # crashes the differential on exactly the fork-prone input it exists to police.
    try:
        if len(uri.encode("utf-8")) > MAX_RECORD_BYTES: return None
    except UnicodeEncodeError:
        return None
    try: obj = json.loads(uri)
    except Exception: return None
    if not isinstance(obj, dict): return None  # rejects null/list/scalar
    try:
        if canonical_json(obj) != uri: return None
        if payload_hash(obj).lower() != payload_hash_hex.lower(): return None
    except Exception:
        return None
    if not is_wellformed_deep(obj): return None
    if obj.get("v") != 1 or not isinstance(obj.get("t"), str): return None
    t = obj["t"]
    r = obj

    if t == "deploy":
        if not _only_keys(r, DEPLOY_KEYS): return None
        if not is_ticker(r.get("ticker")): return None
        if "name" in r and (not isinstance(r["name"], str) or u16len(r["name"]) > 32): return None
        d = r.get("decimals")
        if not isinstance(d, int) or isinstance(d, bool) or d < 0 or d > 8: return None
        if parse_amount(r.get("supply")) is None: return None
        if r.get("mint") not in ("open", "issuer"): return None
        if r["mint"] == "open" and parse_amount(r.get("mintLimit")) is None: return None
        if r["mint"] == "issuer" and "mintLimit" in r: return None
        return r
    if t == "mint":
        if not _only_keys(r, MINT_KEYS): return None
        if not is_ticker(r.get("ticker")): return None
        if "amount" in r and parse_amount(r["amount"]) is None: return None
        return r
    if t == "transfer":
        if not _only_keys(r, TRANSFER_KEYS): return None
        if not is_ticker(r.get("ticker")) or not is_addr(r.get("to")) or parse_amount(r.get("amount")) is None: return None
        if "memo" in r and (not isinstance(r["memo"], str) or u16len(r["memo"]) > 64): return None
        if "ts" in r and not is_safe_int(r["ts"]): return None
        return r
    if t == "offer":
        if not _only_keys(r, OFFER_KEYS): return None
        g = r.get("give"); w = r.get("want")
        if not isinstance(g, dict) or not isinstance(w, dict): return None
        gkeys = ",".join(sorted(g.keys()))
        if gkeys == "amount,ticker":
            if not is_ticker(g.get("ticker")) or parse_amount(g.get("amount")) is None: return None
        elif gkeys == "name":
            if not is_name(g.get("name")): return None
        else: return None
        wkeys = ",".join(sorted(k for k in w.keys() if k != "payto"))
        if wkeys == "value":
            if parse_amount(w.get("value"), allow_zero=True) is None: return None
        elif wkeys == "amount,ticker":
            if not is_ticker(w.get("ticker")) or parse_amount(w.get("amount"), allow_zero=True) is None: return None
            if gkeys == "amount,ticker" and w.get("ticker") == g.get("ticker"): return None
            if "min" in r: return None
        else: return None
        if "payto" in w and not is_addr(w["payto"]): return None
        if "min" in r:
            if gkeys != "amount,ticker" or wkeys != "value": return None
            mn = parse_amount(r["min"])
            if mn is None or mn > parse_amount(w.get("value"), allow_zero=True): return None
        if "bid" in r and not is_hash(r["bid"]): return None
        if "taker" in r and not is_addr(r["taker"]): return None
        if "memo" in r and (not isinstance(r["memo"], str) or u16len(r["memo"]) > 64): return None
        if "ts" in r and not is_safe_int(r["ts"]): return None
        return r
    if t == "ocancel":
        if "ticker" in r and "name" in r: return None
        if "ticker" in r and not is_ticker(r["ticker"]): return None
        if "name" in r and not is_name(r["name"]): return None
        n = len(r.keys())
        if n != 2 + (1 if "ticker" in r else 0) + (1 if "name" in r else 0): return None
        return r
    if t == "bid":
        if not _only_keys(r, BID_KEYS): return None
        w = r.get("want"); g = r.get("give")
        if not isinstance(w, dict) or not isinstance(g, dict): return None
        wkeys = ",".join(sorted(w.keys()))
        if wkeys == "amount,ticker":
            if not is_ticker(w.get("ticker")) or parse_amount(w.get("amount")) is None: return None
        elif wkeys == "name":
            if not is_name(w.get("name")): return None
        else: return None
        if ",".join(sorted(g.keys())) != "value" or parse_amount(g.get("value")) is None: return None
        if "memo" in r and (not isinstance(r["memo"], str) or u16len(r["memo"]) > 64): return None
        if "ts" in r and not is_safe_int(r["ts"]): return None
        return r
    if t == "ncommit":
        if not is_hash(r.get("commit")): return None
        if len(r.keys()) != 3: return None
        return r
    if t == "name":
        if not _only_keys(r, NAME_KEYS): return None
        if not is_name(r.get("name")): return None
        if "salt" in r and (not isinstance(r["salt"], str) or not SALT_RE.fullmatch(r["salt"])): return None
        return r
    if t == "nfinalize":
        # v2.5 winner-only register finalize; salt MANDATORY (self-contained re-derivation of the deep commit).
        # Parse height-agnostic; the resolve handler is V25-gated -> below V25 a no-op in both impls.
        if not _only_keys(r, NFINALIZE_KEYS): return None
        if not is_name(r.get("name")): return None
        if not isinstance(r.get("salt"), str) or not SALT_RE.fullmatch(r["salt"]): return None
        return r
    if t == "nxfer":
        if not is_name(r.get("name")) or not is_addr(r.get("to")): return None
        if len(r.keys()) != 4: return None
        return r
    if t == "nset":
        if not is_name(r.get("name")) or not is_addr(r.get("addr")): return None
        if len(r.keys()) != 4: return None
        return r
    if t == "nrenew":
        if not is_name(r.get("name")): return None
        if len(r.keys()) != 3: return None
        return r
    if t == "nprofile":
        # v1.9 ENS-class identity (doc 36). INERT shape+determinism validation only; semantics-agnostic.
        if not _only_keys(r, NPROFILE_KEYS): return None
        if not is_name(r.get("name")): return None
        p = r.get("p")
        if not isinstance(p, dict): return None
        if len(p) > PROFILE_MAX_KEYS: return None                       # empty p valid (= clear)
        for k, val in p.items():
            if PKEY.fullmatch(k) is None: return None                  # ASCII charset; fullmatch = JS .test parity
            if not isinstance(val, str): return None                   # string→string only
            if len(val.encode("utf-8")) > PROFILE_MAX_VALUE_BYTES: return None
        return r
    if t == "tmeta":
        if not is_ticker(r.get("ticker")): return None
        if not isinstance(r.get("hash"), str) or not HASH_RE.fullmatch(r["hash"]): return None
        if len(r.keys()) != 4: return None
        return r
    return None

def is_name_give(g): return isinstance(g.get("name"), str)
def is_token_want(w): return isinstance(w.get("ticker"), str)

# ── the full resolver (mirror resolve.ts; canonical DATA surface only, no event log) ────────────────
def resolve(events, tip_height):
    def sort_key(e):
        ident = e["id"] if e["kind"] == "propose" else e["txid"]
        return (e["height"], 1 if e["kind"] == "attest" else 0, e["pos"], u16key(ident))
    ordered = sorted(events, key=sort_key)

    tokens = {}      # ticker -> {meta, minted, supply, mintLimit}
    balances = {}    # ticker -> addr -> {available, locked}
    names = {}       # name -> rec
    commits = {}     # commitHash -> earliest height
    offers = {}      # id -> OfferState (output shape, mutated in place)
    offer_lock = {}  # id -> int
    bids = {}        # id -> BidState
    fees_paid = 0

    pending_cancels = []
    pending_block = [-1]

    def apply_pending():
        for f in pending_cancels: f()
        pending_cancels.clear()

    def bal(ticker, addr):
        m = balances.setdefault(ticker, {})
        return m.setdefault(addr, {"available": 0, "locked": 0})

    def release_give(o):
        if is_name_give(o["give"]):
            n = names.get(o["give"]["name"])
            if n: n["locked"] = False
        else:
            amt = offer_lock.get(o["id"], 0)
            b = bal(o["give"]["ticker"], o["seller"])
            b["locked"] -= amt; b["available"] += amt

    def eff_expiry(e, height):  # v2.1 ([V21,V22)): cap at anchor + MAX_OFFER_EPOCHS; v2.2 (offer ANCHORED >= V22): uncapped (raw binds). Keyed on the offer's ANCHOR height so [V21,V22) stays byte-identical.
        if e["height"] >= V22_HEIGHT: return e["expiresEpoch"]
        return min(e["expiresEpoch"], epoch_of(e["height"]) + MAX_OFFER_EPOCHS) if height >= V21_HEIGHT else e["expiresEpoch"]
    def sweep_expired(height):
        ep = epoch_of(height)
        for o in offers.values():
            if o["status"] == "open" and ep > eff_expiry(o, height):
                release_give(o); o["status"] = "expired"
        for b in bids.values():
            if b["status"] == "open" and ep > eff_expiry(b, height):
                b["status"] = "expired"
        # v2.5: drop un-finalized reservations past their finalize window (abandoned) so the name reopens and
        # canonical state does not accumulate dead reservations. Below V25 no name is `pending` -> no-op.
        for nm in [k for k, n in names.items() if n.get("pending") and n.get("finalizeBy") is not None and height > n["finalizeBy"]]:
            del names[nm]

    V15_EPOCH = epoch_of(V15_HEIGHT)
    def paid_through(n): return n["paidThroughEpoch"] if n.get("paidThroughEpoch") is not None else (V15_EPOCH + NAME_TERM_EPOCHS)
    def lapsed(n, ep): return ep > paid_through(n) + NAME_GRACE_EPOCHS
    def in_grace(n, ep): return ep > paid_through(n) and not lapsed(n, ep)

    def mark_bid_done(o, buyer):
        if not o.get("bid"): return
        b = bids.get(o["bid"])
        if b and b["status"] == "open" and b["bidder"] == buyer: b["status"] = "done"

    # v1.7/v2.0: a claim grants an EXCLUSIVE HOLD = window (+ V20 fill grace). Within the hold the claimer's
    # fill is honored AND no other address may claim (same interval) → a slightly-late in-window fill still
    # delivers, with no displacement race. Below V20: window 15, grace 0 (byte-identical). The grace is
    # derived from the claim's ERA (a V20 claim has claimUntilHeight >= V20+40; [V20+15,V20+40) is unreachable).
    def claim_grace(o):
        cu = o.get("claimUntilHeight")
        return CLAIM_FILL_GRACE_BLOCKS if (cu is not None and cu - CLAIM_WINDOW_BLOCKS_V20 >= V20_HEIGHT) else 0
    def claim_held(o, height):  # still exclusively held (window + grace) at `height`?
        return o.get("claimedBy") is not None and o.get("claimUntilHeight") is not None and height < o["claimUntilHeight"] + claim_grace(o)
    def claim_window_at(height):  # exclusivity window a claim placed at `height` gets
        return CLAIM_WINDOW_BLOCKS_V20 if height >= V20_HEIGHT else CLAIM_WINDOW_BLOCKS

    # ── shared SCORE_FILL helpers (mirrors resolve.ts — dedup of the three fill paths) ──
    def open_fill_blocked(o, height, who):
        # v1.7 open-fill gate: an untaken CSD offer (≥V13) is fillable only by the live-claim holder; [V13,V17) banned.
        if not (height >= V13_HEIGHT and not o.get("taker")): return False
        if height < V17_HEIGHT: return True
        return not (claim_held(o, height) and who == o.get("claimedBy"))
    def deliver_name_to_buyer(n, who, ev):
        # name sale: transfer to buyer, clear addr+profile, and (v1.3+) re-stamp a displacement-immune viaFill basis
        n["owner"] = who; n["locked"] = False; n["addr"] = None; n["profile"] = None
        if ev["height"] >= V13_HEIGHT:
            n["effHeight"] = ev["height"]; n["pos"] = ev["pos"]; n["id"] = ev["txid"]; n["height"] = ev["height"]; n["viaFill"] = True
    def release_give_lock(o, who, amt):  # release a token offer's FULL locked give to the buyer; consume the lock
        t = o["give"]["ticker"]
        bal(t, o["seller"])["locked"] -= amt
        bal(t, who)["available"] += amt
        offer_lock.pop(o["id"], None)

    for ev in ordered:
        if ev["height"] < ACTIVATION_HEIGHT: continue
        if ev["height"] != pending_block[0]:
            apply_pending(); pending_block[0] = ev["height"]
        sweep_expired(ev["height"])
        v11 = ev["height"] >= V11_HEIGHT
        v12 = ev["height"] >= V12_HEIGHT
        v15 = ev["height"] >= V15_HEIGHT
        v16 = ev["height"] >= V16_HEIGHT
        v19 = ev["height"] >= V19_HEIGHT
        v23 = ev["height"] >= V23_HEIGHT
        v25 = ev["height"] >= V25_HEIGHT
        fee_to_treasury = _pt((ev.get("paidTo") or {}).get(TREASURY_ADDR)) if ev["kind"] == "propose" else 0

        if ev["kind"] == "propose":
            rec = parse_record(ev["uri"], ev["payloadHash"])
            if not rec: continue
            who = ev["proposer"].lower()
            t = rec["t"]

            if t == "deploy":
                if rec["ticker"] in tokens: continue
                if v11 and fee_to_treasury < DEPLOY_FEE: continue
                supply = parse_amount(rec["supply"])
                mint_limit = parse_amount(rec["mintLimit"]) if rec["mint"] == "open" else None
                meta = {"ticker": rec["ticker"], "deployId": ev["id"], "deployer": who,
                        "decimals": rec["decimals"], "supply": rec["supply"], "minted": "0",
                        "mint": rec["mint"], "height": ev["height"]}
                if "name" in rec: meta["name"] = rec["name"]
                if "mintLimit" in rec: meta["mintLimit"] = rec["mintLimit"]
                tokens[rec["ticker"]] = {"meta": meta, "minted": 0, "supply": supply, "mintLimit": mint_limit}
                if v11: fees_paid += DEPLOY_FEE

            elif t == "mint":
                tok = tokens.get(rec["ticker"])
                if not tok: continue
                remaining = tok["supply"] - tok["minted"]
                if remaining <= 0: continue
                if tok["meta"]["mint"] == "issuer":
                    if who != tok["meta"]["deployer"]: continue
                    req = parse_amount(rec["amount"]) if "amount" in rec else None
                    if req is None: continue
                    credit = req if req < remaining else remaining
                else:
                    req = parse_amount(rec["amount"]) if "amount" in rec else tok["mintLimit"]
                    capped = req if req < tok["mintLimit"] else tok["mintLimit"]
                    credit = capped if capped < remaining else remaining
                tok["minted"] += credit
                bal(rec["ticker"], who)["available"] += credit

            elif t == "transfer":
                if rec["ticker"] not in tokens: continue
                amt = parse_amount(rec["amount"])
                frm = bal(rec["ticker"], who)
                if frm["available"] < amt: continue
                frm["available"] -= amt
                bal(rec["ticker"], rec["to"].lower())["available"] += amt

            elif t == "ncommit":
                if not v11: continue
                prev = commits.get(rec["commit"])
                if prev is None or ev["height"] < prev: commits[rec["commit"]] = ev["height"]

            elif t == "name":
                if not v11: continue
                # v2.5 couples the reveal window to REG_COMMIT_MAX_BLOCKS (the freeze); below V25 unchanged.
                reg_window = REG_COMMIT_MAX_BLOCKS if v25 else COMMIT_MAX_BLOCKS
                eff_height = ev["height"]
                if "salt" in rec:
                    ch = name_commit(rec["name"], rec["salt"], who)
                    c_h = commits.get(ch)
                    if c_h is None or c_h >= ev["height"] or ev["height"] - c_h > reg_window: continue
                    eff_height = c_h
                cur = names.get(rec["name"])
                ep_claim = epoch_of(ev["height"])
                # v2.5: a pending reservation past finalizeBy auto-expires (lazy reopen). Below V25 curActive == cur.
                cur_active = None if (cur and cur.get("pending") and cur.get("finalizeBy") is not None and ev["height"] > cur["finalizeBy"]) else cur
                # v1.5 lapsed recapture (UNCHANGED; pay-now until V26). A pending reservation holds no lease -> never lapsed.
                if cur_active and not cur_active.get("pending") and v15 and lapsed(cur_active, ep_claim):
                    fee = expired_claim_fee(rec["name"], ep_claim - (paid_through(cur_active) + NAME_GRACE_EPOCHS), ev["height"])
                    if fee_to_treasury < fee: continue
                    for o in offers.values():
                        if o["status"] == "open" and is_name_give(o["give"]) and o["give"]["name"] == rec["name"]:
                            release_give(o); o["status"] = "cancelled"
                    names[rec["name"]] = {"owner": who, "effHeight": eff_height, "pos": ev["pos"], "id": ev["id"],
                                          "height": ev["height"], "locked": False, "viaFill": True,
                                          "paidThroughEpoch": ep_claim + NAME_TERM_EPOCHS}
                    fees_paid += fee
                    continue
                # v2.5 SEALED RESERVATION: payment-free reveal -> pending reservation; the reg fee moves to nfinalize.
                if v25:
                    if "salt" not in rec: continue   # v2.5: registration requires a commit-reveal (salt)
                    better = (cur_active is None) or ((not cur_active.get("viaFill")) and (
                        eff_height < cur_active["effHeight"] or
                        (eff_height == cur_active["effHeight"] and (ev["pos"] < cur_active["pos"] or (ev["pos"] == cur_active["pos"] and lt(ev["id"], cur_active["id"]))))))
                    if not better: continue
                    my_pending = sum(1 for nm, n in names.items()
                                     if n.get("pending") and n["owner"] == who and nm != rec["name"]
                                     and n.get("finalizeBy") is not None and ev["height"] <= n["finalizeBy"])
                    if my_pending >= MAX_PENDING_REG: continue
                    if cur_active:
                        for o in offers.values():
                            if o["status"] == "open" and is_name_give(o["give"]) and o["give"]["name"] == rec["name"]:
                                release_give(o); o["status"] = "cancelled"
                    names[rec["name"]] = {"owner": who, "effHeight": eff_height, "pos": ev["pos"], "id": ev["id"],
                                          "height": ev["height"], "locked": False, "pending": True,
                                          "finalizeBy": eff_height + REG_COMMIT_MAX_BLOCKS + REG_FINALIZE_GRACE_BLOCKS}
                    continue
                if fee_to_treasury < name_reg_fee(rec["name"], ev["height"]): continue
                cand = {"owner": who, "effHeight": eff_height, "pos": ev["pos"], "id": ev["id"],
                        "height": ev["height"], "locked": False}
                if v15: cand["paidThroughEpoch"] = ep_claim + NAME_TERM_EPOCHS
                better = (cur_active is None) or ((not cur_active.get("viaFill")) and (
                    eff_height < cur_active["effHeight"] or
                    (eff_height == cur_active["effHeight"] and (ev["pos"] < cur_active["pos"] or (ev["pos"] == cur_active["pos"] and lt(ev["id"], cur_active["id"]))))))
                if not better: continue
                if cur_active:
                    for o in offers.values():
                        if o["status"] == "open" and is_name_give(o["give"]) and o["give"]["name"] == rec["name"]:
                            release_give(o); o["status"] = "cancelled"
                names[rec["name"]] = cand
                fees_paid += name_reg_fee(rec["name"], ev["height"])

            elif t == "nfinalize":
                # v2.5 winner-only register finalize: pay the reg fee AFTER the displacement contest freezes.
                # Promote the reservation to a NORMAL registered name (NOT viaFill — already displacement-immune
                # via the freeze-window math; viaFill would trip the wallet's namespv caution on every fresh name).
                if not v25: continue
                n = names.get(rec["name"])
                if not n or not n.get("pending") or n["owner"] != who: continue
                c_h = commits.get(name_commit(rec["name"], rec["salt"], who))
                if c_h is None or c_h != n["effHeight"]: continue
                if not (ev["height"] > n["effHeight"] + REG_COMMIT_MAX_BLOCKS): continue
                if n.get("finalizeBy") is not None and ev["height"] > n["finalizeBy"]: continue
                if fee_to_treasury < name_reg_fee(rec["name"], ev["height"]): continue
                # parity note: JS mirror sets these to undefined (key kept); we pop (key removed). SAFE only
                # because every reader tests truthiness, never key-presence, and a finalized name never hits the
                # pending materialization branch. Keep both sides key-presence-agnostic.
                n.pop("pending", None); n.pop("finalizeBy", None)
                n["paidThroughEpoch"] = epoch_of(ev["height"]) + NAME_TERM_EPOCHS
                fees_paid += name_reg_fee(rec["name"], ev["height"])

            elif t == "nxfer":
                n = names.get(rec["name"])
                if not n or n["owner"] != who: continue
                if n.get("pending"): continue
                if v15 and lapsed(n, epoch_of(ev["height"])): continue
                if n["locked"]: continue
                n["owner"] = rec["to"].lower(); n["addr"] = None; n["profile"] = None  # ownership change clears the profile (doc 36)

            elif t == "nset":
                n = names.get(rec["name"])
                if not n or n["owner"] != who: continue
                if n.get("pending"): continue
                if v15 and lapsed(n, epoch_of(ev["height"])): continue
                if v23 and rec["addr"].lower() == ZERO_ADDR: n["addr"] = None   # v2.3 unset: clear -> falls back to owner
                else: n["addr"] = rec["addr"].lower()

            elif t == "nprofile":
                # v1.9 ENS-class identity (doc 36). INERT — owner-gated, last-write-wins; empty p clears.
                if not v19: continue
                n = names.get(rec["name"])
                if not n or n["owner"] != who: continue
                if n.get("pending"): continue
                if v15 and lapsed(n, epoch_of(ev["height"])): continue
                n["profile"] = dict(rec["p"]) if rec["p"] else None

            elif t == "offer":
                want_is_token = is_token_want(rec["want"])
                if (want_is_token or "min" in rec or "bid" in rec) and not v12: continue
                if V13_HEIGHT <= ev["height"] < V17_HEIGHT and not want_is_token and "taker" not in rec: continue  # v1.7 re-allows open CSD offers (claim-gated)
                payto = (rec["want"].get("payto") or who).lower()
                if payto == TREASURY_ADDR: continue
                if not is_safe_int(ev.get("expiresEpoch")): continue  # PARITY: missing -> is_safe_int(None)=False -> reject (match JS Number.isSafeInteger(undefined))
                if epoch_of(ev["height"]) > ev["expiresEpoch"]: continue
                if ev["height"] >= V21_HEIGHT and ev["height"] < V22_HEIGHT and ev["expiresEpoch"] - epoch_of(ev["height"]) > MAX_OFFER_EPOCHS: continue  # v2.1 cap — [V21,V22) era only; v2.2 (anchor >= V22) removes it
                give = rec["give"]
                if is_name_give(give):
                    if not v11: continue
                    n = names.get(give["name"])
                    if not n or n["owner"] != who: continue
                    if n.get("pending"): continue
                    if n["locked"]: continue
                    if ev["height"] >= V13_HEIGHT and not n.get("viaFill") and ev["height"] - n["effHeight"] <= COMMIT_MAX_BLOCKS: continue
                    if v15 and paid_through(n) < ev["expiresEpoch"]: continue
                    n["locked"] = True
                else:
                    if give["ticker"] not in tokens: continue
                    amt = parse_amount(give["amount"])
                    s = bal(give["ticker"], who)
                    if s["available"] < amt: continue
                    s["available"] -= amt; s["locked"] += amt; offer_lock[ev["id"]] = amt
                o = {"id": ev["id"], "seller": who, "give": give,
                     "want": ({"ticker": rec["want"]["ticker"], "amount": rec["want"]["amount"], "payto": payto}
                              if want_is_token else {"value": rec["want"]["value"], "payto": payto}),
                     "status": "open", "expiresEpoch": ev["expiresEpoch"], "height": ev["height"],
                     "feeBps": ((FEE_BPS_V16 if v16 else FEE_BPS) if v11 else 0)}
                if "taker" in rec: o["taker"] = rec["taker"].lower()
                if "min" in rec: o.update({"min": rec["min"], "paid": "0", "delivered": "0", "fills": []})
                if "bid" in rec: o["bid"] = rec["bid"]
                offers[ev["id"]] = o
                if "bid" in rec:
                    linked = bids.get(rec["bid"])
                    if linked: linked["offers"].append(ev["id"])

            elif t == "bid":
                if not v12: continue
                if not is_safe_int(ev.get("expiresEpoch")): continue  # PARITY: missing -> is_safe_int(None)=False -> reject (match JS Number.isSafeInteger(undefined))
                if epoch_of(ev["height"]) > ev["expiresEpoch"]: continue
                if ev["height"] >= V21_HEIGHT and ev["height"] < V22_HEIGHT and ev["expiresEpoch"] - epoch_of(ev["height"]) > MAX_OFFER_EPOCHS: continue  # v2.1 cap — [V21,V22) era only; v2.2 (anchor >= V22) removes it
                bids[ev["id"]] = {"id": ev["id"], "bidder": who, "want": rec["want"], "give": rec["give"],
                                  "status": "open", "expiresEpoch": ev["expiresEpoch"], "height": ev["height"], "offers": []}

            elif t == "ocancel":
                if not v12: continue
                targets = []
                for o in offers.values():
                    if o["status"] != "open" or o["seller"] != who: continue
                    if "ticker" in rec and not (not is_name_give(o["give"]) and o["give"]["ticker"] == rec["ticker"]): continue
                    if "name" in rec and not (is_name_give(o["give"]) and o["give"]["name"] == rec["name"]): continue
                    targets.append(o)
                if ev["height"] >= V14_HEIGHT:
                    def mk(targets):
                        def f():
                            for o in targets:
                                if o["status"] == "open": release_give(o); o["status"] = "cancelled"
                        return f
                    pending_cancels.append(mk(targets))
                else:
                    for o in targets: release_give(o); o["status"] = "cancelled"

            elif t == "nrenew":
                if not v15: continue
                n = names.get(rec["name"]); ep = epoch_of(ev["height"])
                if n and n.get("pending"): continue
                if not n or lapsed(n, ep): continue
                if in_grace(n, ep) and who != n["owner"]: continue
                if fee_to_treasury < name_reg_fee(rec["name"], ev["height"]): continue
                n["paidThroughEpoch"] = paid_through(n) + NAME_TERM_EPOCHS
                fees_paid += name_reg_fee(rec["name"], ev["height"])

            elif t == "tmeta":
                if not v15: continue
                tok = tokens.get(rec["ticker"])
                if not tok: continue
                if who != tok["meta"]["deployer"]: continue
                tok["meta"]["tmeta"] = rec["hash"]

        else:  # attest
            o = offers.get(ev["proposalId"])
            who = ev["attester"].lower()
            if not o:
                b = bids.get(ev["proposalId"])
                if b and ev.get("score") == SCORE_CANCEL:
                    if who != b["bidder"]: continue
                    if b["status"] != "open": continue
                    b["status"] = "cancelled"
                continue

            if ev.get("score") == SCORE_CANCEL:
                if who != o["seller"]: continue
                if o["status"] != "open": continue
                if ev["height"] >= V14_HEIGHT:
                    def mk(o):
                        def f():
                            if o["status"] == "open": release_give(o); o["status"] = "cancelled"
                        return f
                    pending_cancels.append(mk(o))
                else:
                    release_give(o); o["status"] = "cancelled"

            elif ev.get("score") == SCORE_FILL and is_token_want(o["want"]):
                if o["status"] != "open": continue
                if o.get("taker") and who != o["taker"]: continue
                if ev.get("confidence") != CONF_TOKEN_FILL: continue  # PARITY: missing confidence -> skip (match JS ev.confidence undefined), never KeyError
                if o["want"]["ticker"] not in tokens: continue
                amt = int(o["want"]["amount"])
                fee = trade_fee(amt, o["feeBps"]) if o["feeBps"] else 0
                buyer = bal(o["want"]["ticker"], who)
                if buyer["available"] < amt + fee: continue
                give_name = names.get(o["give"]["name"]) if is_name_give(o["give"]) else None
                if is_name_give(o["give"]) and not give_name: continue
                give_lock = None if is_name_give(o["give"]) else offer_lock.get(o["id"])
                if not is_name_give(o["give"]) and give_lock is None: continue
                buyer["available"] -= amt + fee
                bal(o["want"]["ticker"], o["want"]["payto"])["available"] += amt
                if fee > 0: bal(o["want"]["ticker"], TREASURY_ADDR)["available"] += fee
                if is_name_give(o["give"]):
                    deliver_name_to_buyer(give_name, who, ev)
                else:
                    release_give_lock(o, who, give_lock)
                o["status"] = "filled"
                o["fill"] = {"buyer": who, "txid": ev["txid"], "height": ev["height"], "paid": str(amt), "fee": str(fee)}
                mark_bid_done(o, who)

            elif ev.get("score") == SCORE_FILL and o.get("min") is not None and not is_name_give(o["give"]):
                if o["status"] != "open": continue
                if o.get("taker") and who != o["taker"]: continue
                if open_fill_blocked(o, ev["height"], who): continue
                pt = ev.get("paidTo") or {}
                want = int(o["want"]["value"])
                paid_so_far = int(o.get("paid") or "0")
                remaining = want - paid_so_far
                X = _pt(pt.get(o["want"]["payto"]))
                min_v = int(o["min"])
                eff_min = remaining if remaining < min_v else min_v
                if X < eff_min: continue
                x = X if X < remaining else remaining
                fee = trade_fee(x, o["feeBps"]) if o["feeBps"] else 0  # partial fills carry NO maker rebate in v1.6
                if _pt(pt.get(TREASURY_ADDR)) < fee: continue
                give_total = int(o["give"]["amount"])
                new_paid = paid_so_far + x
                delivered_so_far = int(o.get("delivered") or "0")
                new_delivered = (give_total * new_paid) // want
                out = new_delivered - delivered_so_far
                if out == 0: continue
                lock = offer_lock.get(o["id"])
                if lock is None: continue
                bal(o["give"]["ticker"], o["seller"])["locked"] -= out
                bal(o["give"]["ticker"], who)["available"] += out
                offer_lock[o["id"]] = lock - out
                o["paid"] = str(new_paid); o["delivered"] = str(new_delivered)
                entry = {"buyer": who, "txid": ev["txid"], "height": ev["height"], "paid": str(x), "fee": str(fee), "got": str(out)}
                o.setdefault("fills", []).append(entry)
                fees_paid += fee
                if new_paid == want:
                    o["status"] = "filled"; o["fill"] = entry; offer_lock.pop(o["id"], None)
                    mark_bid_done(o, who)

            elif ev.get("score") == SCORE_FILL:
                if o["status"] != "open": continue
                if o.get("taker") and who != o["taker"]: continue
                if open_fill_blocked(o, ev["height"], who): continue
                pt = ev.get("paidTo") or {}
                want = int(o["want"]["value"])
                fee = trade_fee(want, o["feeBps"]) if o["feeBps"] else 0
                # v1.6 maker rebate on a BID-ANSWERED whole fill (derived from creation height + bid link)
                # RESTING-LIQUIDITY lanes only (MED-2 fix): taker-bound bid-answer OR a v1.7 open ask
                resting = (o.get("taker") is not None and o.get("bid") is not None) or (o["height"] >= V17_HEIGHT and o.get("taker") is None)
                rebate = maker_rebate(want) if (o["height"] >= V16_HEIGHT and resting) else 0
                # combined same-tx output gate (handles payto==o.seller by SUMMING; payto!=treasury always)
                need = {}
                def _addn(a, v): need[a] = need.get(a, 0) + v
                _addn(o["want"]["payto"], want); _addn(TREASURY_ADDR, fee)
                if rebate > 0: _addn(o["seller"], rebate)  # ACCUMULATE — coinciding recipients SUM, never overwrite
                if any(_pt(pt.get(a)) < amt for a, amt in need.items()): continue
                paid = _pt(pt.get(o["want"]["payto"]))
                if is_name_give(o["give"]):
                    n = names.get(o["give"]["name"])
                    if not n: continue
                    deliver_name_to_buyer(n, who, ev)
                else:
                    amt = offer_lock.get(o["id"])
                    if amt is None: continue
                    release_give_lock(o, who, amt)
                fees_paid += fee
                o["status"] = "filled"
                o["fill"] = {"buyer": who, "txid": ev["txid"], "height": ev["height"], "paid": str(paid), "fee": str(fee)}
                mark_bid_done(o, who)

            elif ev["height"] >= V17_HEIGHT and ev.get("score") == SCORE_CLAIM:
                # v1.7 claim-to-fill: reserve an OPEN CSD offer for the first claimer for a short window
                if o["status"] != "open": continue
                if o.get("taker"): continue
                if is_token_want(o["want"]): continue
                if claim_held(o, ev["height"]): continue
                # anti-recycle (KNOWN BOUND, identical to resolve.ts so NOT a fork): keys on being the LAST
                # claimer, so a 2nd-address intervening claim resets it (A→B→A recycle). Bounded by
                # MAX_ACTIVE_CLAIMS + payment-free claims → single-offer griefing, never value loss.
                if o.get("claimedBy") == who and o.get("claimUntilHeight") is not None and ev["height"] < o["claimUntilHeight"] + claim_grace(o) + CLAIM_COOLDOWN_BLOCKS: continue  # anti-recycle (from hold end)
                liveN = sum(1 for x in offers.values() if x.get("claimedBy") == who and claim_held(x, ev["height"]))
                if liveN >= MAX_ACTIVE_CLAIMS: continue
                o["claimedBy"] = who; o["claimUntilHeight"] = ev["height"] + claim_window_at(ev["height"])

    apply_pending()
    sweep_expired(tip_height + 1)

    # ── materialize canonical DATA surface ──
    tokens_out = {}
    for tk in sorted(tokens.keys(), key=u16key):
        meta = dict(tokens[tk]["meta"]); meta["minted"] = str(tokens[tk]["minted"]); tokens_out[tk] = meta
    balances_out = {}
    for tk in sorted(balances.keys(), key=u16key):
        inner = {}
        for a in sorted(balances[tk].keys(), key=u16key):
            b = balances[tk][a]
            if b["available"] == 0 and b["locked"] == 0: continue
            inner[a] = {"available": str(b["available"]), "locked": str(b["locked"])}
        if inner: balances_out[tk] = inner
    names_out = {}
    tip_v15 = tip_height >= V15_HEIGHT
    tip_v19 = tip_height >= V19_HEIGHT
    tip_v25 = tip_height >= V25_HEIGHT
    tip_epoch = epoch_of(tip_height)
    for nm in sorted(names.keys(), key=u16key):
        n = names[nm]
        if tip_v25 and n.get("pending"):
            # v2.5 reservation: minimal shape (no addr/viaFill/profile/lease). The closing sweep drops any
            # reservation past finalizeBy, so a materialized pending name is always still finalizable.
            names_out[nm] = {"name": nm, "owner": n["owner"], "claimId": n["id"], "height": n["height"],
                             "effectiveHeight": n["effHeight"], "locked": n["locked"],
                             "pending": True, "finalizeBy": n["finalizeBy"]}
            continue
        ns = {"name": nm, "owner": n["owner"], "claimId": n["id"], "height": n["height"],
              "effectiveHeight": n["effHeight"], "locked": n["locked"]}
        if n.get("addr"): ns["addr"] = n["addr"]
        if n.get("viaFill"): ns["viaFill"] = True
        if tip_v19 and n.get("profile"): ns["profile"] = n["profile"]  # v1.9 at v1.9+ tips only → pre-v1.9 hash byte-identical
        if tip_v15:
            ns["paidThroughEpoch"] = paid_through(n)
            if lapsed(n, tip_epoch): ns["expired"] = True
        names_out[nm] = ns
    offers_out = {oid: offers[oid] for oid in sorted(offers.keys(), key=u16key)}
    bids_out = {bid: bids[bid] for bid in sorted(bids.keys(), key=u16key)}

    return {"tipHeight": tip_height, "tokens": tokens_out, "balances": balances_out,
            "names": names_out, "offers": offers_out, "bids": bids_out, "feesPaid": str(fees_paid)}

_ARRAY_INDEX_RE = re.compile(r"^(0|[1-9][0-9]*)$")
def _is_array_index(k):
    """ECMAScript array-index key: the canonical decimal string of an integer in [0, 2^32-2].
    Such keys enumerate FIRST, in ascending numeric order, in every JS object (and thus in
    JSON.stringify output) — BEFORE string keys, regardless of insertion/sort order."""
    if not _ARRAY_INDEX_RE.fullmatch(k): return False
    return int(k) < 4294967295  # 2^32 - 1

def _js_obj_key_order(keys):
    idx = sorted((k for k in keys if _is_array_index(k)), key=lambda k: int(k))
    rest = sorted((k for k in keys if not _is_array_index(k)), key=u16key)
    return idx + rest

def _js_stringify(v, depth=0):
    """Byte-identical to JS `JSON.stringify(sortKeys(v))`: object keys emitted as ECMAScript
    enumerates them — integer-index keys ascending-numeric first, then the remaining keys in
    code-unit (UTF-16) order. (canonicalState uses JSON.stringify, NOT the codec canonicalJson, so
    it inherits this object-key ordering — a real cross-language fork point for numeric names.)"""
    if depth > MAX_DEPTH: raise ValueError("max nesting depth exceeded")
    if v is None or isinstance(v, bool) or not isinstance(v, (dict, list)):
        return _json_scalar(v)
    if isinstance(v, list):
        return "[" + ",".join(_js_stringify(x, depth + 1) for x in v) + "]"
    keys = _js_obj_key_order(list(v.keys()))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + _js_stringify(v[k], depth + 1) for k in keys) + "}"

def canonical_state(state):
    # canonicalState = JS JSON.stringify(sortKeys(data)) — replicate the JS object-key enumeration
    # order (integer-index keys first), which differs from the codec's pure code-unit canonicalJson.
    return _js_stringify(state)

# ── RES-H4 registry decay fixed-point (kept for the primitive crosscheck) ──
DECAY_SCALE = 1_000_000_000_000
def decay_pow_fixed(age):
    a = 0 if age <= 0 else min(age, 4000)
    return (97 ** a * DECAY_SCALE) // (100 ** a)
def decay_weight_fixed(base, age): return base * decay_pow_fixed(age)

def record_keys_ok(rec):
    """Backward-compat for the primitive crosscheck: the onlyKeys gate (now subsumed by parse_record)."""
    if not isinstance(rec, dict) or not is_wellformed_deep(rec): return False
    allowed = {"deploy": DEPLOY_KEYS, "mint": MINT_KEYS, "transfer": TRANSFER_KEYS,
               "name": NAME_KEYS, "offer": OFFER_KEYS, "bid": BID_KEYS}.get(rec.get("t"))
    if allowed is None: return True
    return set(rec.keys()) <= allowed

# ── CLI: read a JSON job from stdin, emit results for crosscheck.mjs to diff ──
def main():
    job = json.load(sys.stdin)
    out = {}
    if "canon" in job:
        out["canon"] = []
        for item in job["canon"]:
            try: out["canon"].append({"ok": True, "v": canonical_json(item)})
            except Exception as e: out["canon"].append({"ok": False, "err": str(e)})
    if "payloadHash" in job:
        out["payloadHash"] = [payload_hash(x) for x in job["payloadHash"]]
    if "records" in job:
        out["records"] = [record_keys_ok(r) for r in job["records"]]
    if "weights" in job:
        out["weights"] = [str(decay_weight_fixed(w["base"], w["age"])) for w in job["weights"]]
    if "resolve" in job:
        out["resolve"] = [canonical_state(resolve(j["events"], j["tipHeight"])) for j in job["resolve"]]
    if "parseFull" in job:
        # FULL parse_record cross-check (canonical uri + hash + the per-record schema) — stronger than
        # the `records` job, which uses the simplified onlyKeys gate. Used by the nprofile vectors.
        out["parseFull"] = [parse_record(canonical_json(r), payload_hash(r)) is not None for r in job["parseFull"]]
    if "consts" in job:
        # H1/M5: expose the gate heights + key consensus constants so the JS side can assert PARITY
        # (a V19_HEIGHT or other gate drift between impls is otherwise invisible to scenarios that
        # derive their heights from the JS constant). Emitted as strings to dodge any int transport quirk.
        out["consts"] = {
            "V11_HEIGHT": V11_HEIGHT, "V12_HEIGHT": V12_HEIGHT, "V13_HEIGHT": V13_HEIGHT,
            "V14_HEIGHT": V14_HEIGHT, "V15_HEIGHT": V15_HEIGHT, "V16_HEIGHT": V16_HEIGHT,
            "V17_HEIGHT": V17_HEIGHT, "V18_HEIGHT": V18_HEIGHT, "V19_HEIGHT": V19_HEIGHT, "V20_HEIGHT": V20_HEIGHT,
            "CLAIM_WINDOW_BLOCKS": CLAIM_WINDOW_BLOCKS, "CLAIM_WINDOW_BLOCKS_V20": CLAIM_WINDOW_BLOCKS_V20, "CLAIM_FILL_GRACE_BLOCKS": CLAIM_FILL_GRACE_BLOCKS,
            "EPOCH_LEN": EPOCH_LEN, "TREASURY_ADDR": TREASURY_ADDR,
            "PROFILE_MAX_KEYS": PROFILE_MAX_KEYS, "PROFILE_MAX_VALUE_BYTES": PROFILE_MAX_VALUE_BYTES,
        }
    if "regex" in job:
        # C2: DIRECT regex-vs-regex differential over raw strings (the corpus the builder-based fuzzer
        # can never reach). fullmatch mirrors JS .test on ^...$ regexes — it rejects the trailing-\n the
        # old .match accepted (C1). A future drift on any field surfaces here, not silently on-chain.
        _FIELD_RE = {"amount": AMOUNT_RE, "addr": ADDR_RE, "ticker": TICKER_RE,
                     "hash": HASH_RE, "name": NAME_RE, "salt": SALT_RE, "pkey": PKEY}
        out["regex"] = [_FIELD_RE[it["field"]].fullmatch(it["s"]) is not None for it in job["regex"]]
    json.dump(out, sys.stdout)

if __name__ == "__main__":
    main()
