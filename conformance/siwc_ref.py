#!/usr/bin/env python3
# Independent Python reference for the SIWC (Sign in with CSD) byte-contract — the cross-language
# oracle for @inversealtruism/csd-siwc. Reads {"cases":[fields,...]} from stdin, emits
# {"results":[{"message","digest"},...]}. A drift between this and the JS impl is a cross-language
# fork: two honest relying parties would disagree on what was signed. SIWC has NO object-key sorting
# (it is positional line assembly), so the canonical-JSON UTF-16 traps do not apply here; the only
# determinism surfaces are exact line layout + UTF-8 hashing, both replicated below.
import sys, json, hashlib

SIWC_TAG = "CSD-SIWC-v1"
HEADER_SUFFIX = " wants you to sign in with your Compute Substrate account:"

def sha256(b: bytes) -> bytes: return hashlib.sha256(b).digest()
def sha256d(b: bytes) -> bytes: return sha256(sha256(b))
def tagged_hash(tag: str, msg: bytes) -> bytes:
    t = sha256(tag.encode("utf-8"))
    return sha256(t + t + msg)
def siwc_digest(message: str) -> str:
    return "0x" + sha256d(tagged_hash(SIWC_TAG, message.encode("utf-8"))).hex()

def build(f: dict) -> str:
    lines = [f["domain"] + HEADER_SUFFIX, f["account"], ""]
    stmt = f.get("statement")
    if stmt is not None and stmt != "":
        lines.append(stmt)
    lines.append("")
    lines.append("URI: " + f["uri"])
    lines.append("Version: " + f["version"])
    lines.append("Chain ID: " + f["chainId"])
    lines.append("Nonce: " + f["nonce"])
    lines.append("Issued At: " + f["issuedAt"])
    if f.get("expirationTime") is not None: lines.append("Expiration Time: " + f["expirationTime"])
    if f.get("notBefore") is not None: lines.append("Not Before: " + f["notBefore"])
    if f.get("requestId") is not None: lines.append("Request ID: " + f["requestId"])
    if f.get("resources") is not None:
        lines.append("Resources:")
        for r in f["resources"]:
            lines.append("- " + r)
    return "\n".join(lines)

def main():
    job = json.load(sys.stdin)
    out = [{"message": (m := build(f)), "digest": siwc_digest(m)} for f in job["cases"]]
    json.dump({"results": out}, sys.stdout, ensure_ascii=False)

main()
