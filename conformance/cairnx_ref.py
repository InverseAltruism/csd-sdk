#!/usr/bin/env python3
"""
META-1 (audit) — INDEPENDENT second-language reference implementation of the CairnX / CSD
determinism-critical surface. The whole trust model is "two honest resolvers, different code,
converge byte-for-byte." Until now only ONE implementation (JS) existed, so the byte-contract was
asserted, never co-signed. This Python port reproduces the fork-prone primitives — canonical JSON,
payload hash, the record-validation gate (onlyKeys / well-formed, incl. the NAME decoy), and the
registry RES-H4 decay fixed-point — from the SPEC, not from the JS. crosscheck.mjs feeds both the
same corpus and asserts byte-identity; a JS-only change that forks (Math.pow, a dropped onlyKeys,
a UTF-16-vs-codepoint sort) would diverge HERE. This is the structural half of META-1: the second
implementation. (A full resolve() port — token/name/offer ledger — is the remaining half.)
"""
import json, sys, hashlib

MAX_DEPTH = 256

def _is_wellformed(s: str) -> bool:
    # JS isWellFormed: a string is well-formed iff it has no lone UTF-16 surrogate. In Python a lone
    # surrogate (from json.loads of "\uD800") cannot encode to UTF-8 — exactly the same rejection.
    try:
        s.encode("utf-8")
        return True
    except UnicodeEncodeError:
        return False

def is_wellformed_deep(v) -> bool:
    if isinstance(v, str):
        return _is_wellformed(v)
    if isinstance(v, list):
        return all(is_wellformed_deep(x) for x in v)
    if isinstance(v, dict):
        return all(_is_wellformed(k) and is_wellformed_deep(val) for k, val in v.items())
    return True

def _json_scalar(v) -> str:
    # match JS JSON.stringify for the scalar cases canonicalJson emits
    if v is None:
        return "null"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, str):
        return json.dumps(v, ensure_ascii=False)
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # CairnX forbids floats in records; mirror JS number formatting only for completeness
        return repr(v)
    raise ValueError("unhandled scalar")

def canonical_json(v, depth: int = 0) -> str:
    """Byte-identical to csd-codec canonicalJson: UTF-16-code-unit key sort, undefined→null/dropped,
    compact, MAX_DEPTH guard. (JSON has no `undefined`; the dropped-key case can't arise from parsed
    input, so only the depth guard + sort + scalar emit matter for a parsed corpus.)"""
    if depth > MAX_DEPTH:
        raise ValueError("canonicalJson: max nesting depth exceeded")
    if v is None or not isinstance(v, (dict, list)):
        return _json_scalar(v)
    if isinstance(v, list):
        return "[" + ",".join(canonical_json(x, depth + 1) for x in v) + "]"
    # KEY ORDERING: UTF-16 code-unit order == comparing keys' UTF-16-BE byte sequences. NOT codepoint
    # / UTF-8-byte order (which diverges for astral keys) — the exact fork the audit pinned.
    keys = sorted(v.keys(), key=lambda k: k.encode("utf-16-be"))
    return "{" + ",".join(json.dumps(k, ensure_ascii=False) + ":" + canonical_json(v[k], depth + 1) for k in keys) + "}"

def payload_hash(content) -> str:
    return "0x" + hashlib.sha256(canonical_json(content).encode("utf-8")).hexdigest()

# ── record validation gate (parseRecord's onlyKeys / well-formed) for the value records ──
TICKER_RE = None  # (full ticker/addr/amount validation is the resolve half; here we pin the KEY gate)
KEYSETS = {
    "deploy":   {"v", "t", "ticker", "name", "decimals", "supply", "mint", "mintLimit"},
    "mint":     {"v", "t", "ticker", "amount"},
    "transfer": {"v", "t", "ticker", "to", "amount", "memo"},
    "name":     {"v", "t", "name", "salt"},        # the FORK-1 / DET-NAME-1 record
    "offer":    {"v", "t", "give", "want", "min"},
}

def record_keys_ok(rec: dict) -> bool:
    """The onlyKeys gate: a value record with ANY key outside its allow-set is a no-op (rejected).
    This is what closes the astral/lone-surrogate decoy-key cross-language fork (the decoy key is
    simply not in the set). Also requires the record be well-formed (no lone surrogates)."""
    if not isinstance(rec, dict) or not is_wellformed_deep(rec):
        return False
    t = rec.get("t")
    allowed = KEYSETS.get(t)
    if allowed is None:
        return True  # not a key-gated value record here (resolve half handles the rest)
    return set(rec.keys()) <= allowed

# ── RES-H4 registry decay fixed-point (exact integer 0.97^age) ──
DECAY_SCALE = 1_000_000_000_000
def decay_pow_fixed(age: int) -> int:
    a = 0 if age <= 0 else min(age, 4000)
    return (97 ** a * DECAY_SCALE) // (100 ** a)

def decay_weight_fixed(base: int, age: int) -> int:
    return base * decay_pow_fixed(age)

# ── CLI: read a JSON job from stdin, emit results for crosscheck.mjs to diff ──
def main():
    job = json.load(sys.stdin)
    out = {}
    if "canon" in job:
        out["canon"] = []
        for item in job["canon"]:
            try:
                out["canon"].append({"ok": True, "v": canonical_json(item)})
            except Exception as e:
                out["canon"].append({"ok": False, "err": str(e)})
    if "payloadHash" in job:
        out["payloadHash"] = [payload_hash(x) for x in job["payloadHash"]]
    if "records" in job:
        out["records"] = [record_keys_ok(r) for r in job["records"]]
    if "weights" in job:
        out["weights"] = [str(decay_weight_fixed(w["base"], w["age"])) for w in job["weights"]]
    json.dump(out, sys.stdout)

if __name__ == "__main__":
    main()
