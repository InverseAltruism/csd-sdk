// SIWC REFUSAL-PARITY vectors (Plan 75-A section 7.3), csd-siwc copy = the CANONICAL twin.
//
// The SIWC byte contract is hand-maintained in THREE places: this package, cairn/src/lib/siwc.ts and
// cairn-wallet/src/core/siwc.ts. Nothing forced the three to refuse the same inputs, so a guard added
// to one copy could sit missing in another for a release cycle and nobody would see it.
//
// Mechanism (exactly as 7.3 mandates): ONE committed JSON vector file, DUPLICATED byte-for-byte into
// each repo (a cross-repo checkout does not exist in CI, the MF-27 lesson), and each repo's test
// asserts BOTH
//   (a) sha256(vectors.json) == the pinned constant, so a DRIFTED COPY of the vector file reds, and
//   (b) the LOCAL twin refuses every refusal vector and accepts every acceptance vector.
// This pins test DATA across repos. It is deliberately NOT a cross-repo byte-identity test on the
// implementations: three models vetoed that, and merging the twins is out of scope here.
//
// Mutations executed at authoring (observed RED, restored):
//   - flip hasLoneSurrogate to `() => false` in src/index.ts  -> SIWC-R1 build+verify legs go RED.
//   - flip one byte of test/siwc-refusal-parity.vectors.json  -> the sha pin goes RED.
//
// Run: tsx test/refusal-parity.test.ts
import { buildSiwcMessage, siwcDigest, verifySiwc } from "../src/index.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

declare const process: { exit(code: number): void };
let pass = 0, fail = 0;
// Vacuous-assertion guard (G6 referee R1): tsx does not typecheck, so a future `ok(name, () => ...)`
// would be truthy-always. Throw on a function condition so that regression goes RED, never green.
const ok = (n: string, c: boolean) => {
  if (typeof c === "function") throw new Error(`vacuous assertion (function passed as cond): ${n}`);
  c ? (pass++, console.log("  ✅ " + n)) : (fail++, console.log("  ❌ " + n));
};

// (a) THE VECTOR-FILE PIN. Identical constant in all three repos: whichever copy drifts, that repo reds.
// Regenerating the vectors is therefore a deliberate three-repo edit, never a silent one-repo edit.
const VECTORS_SHA256 = "d8c0f4ee8106cc567bbda0aa6cb1874b6a1ffda52bae089dbac43399c9cac593";
const VECTORS_PATH = new URL("./siwc-refusal-parity.vectors.json", import.meta.url);

// This twin implements BOTH surfaces (it is the canonical build + parse + digest + verify library).
const LOCAL_SURFACES = ["build", "verify"];
// The exact number of vector legs this twin must execute. A leg that stops running (a surface dropped,
// a vector silently unmatched) must red rather than shrink the corpus in silence.
const EXPECTED_LEGS = 9;
// Vectors this twin cannot carry at all. Empty here: the canonical twin carries every surface.
const EXPECTED_SKIPPED: string[] = [];

interface Leg { message: string; sig64: string; pub33: string; expected: { domain: string; nonce: string; chainId: string; now: number }; reason?: string; account?: string }
interface Vector { id: string; kind: "refusal" | "accept"; label: string; build?: { fields: any; message?: string; digest?: string }; verify?: Leg }

console.log("=== (a) the committed vector file is the one this repo was pinned against ===");
const raw = readFileSync(VECTORS_PATH);
const got = createHash("sha256").update(raw).digest("hex");
ok(`sha256(siwc-refusal-parity.vectors.json) == the pinned constant (got ${got.slice(0, 16)}...)`, got === VECTORS_SHA256);
const V = JSON.parse(raw.toString("utf8")) as { family: string; revision: number; vectors: Vector[] };
ok("the vector file is the siwc family at the pinned revision", V.family === "siwc" && V.revision === 1);

console.log("=== (b) the LOCAL twin refuses every refusal vector and accepts every acceptance vector ===");
const safeVerify = (l: Leg): { ok: boolean; reason?: string; account?: string } => {
  try { return verifySiwc({ message: l.message, sig64: l.sig64, pub33: l.pub33 }, l.expected) as any; }
  catch (e) { return { ok: false, reason: `threw: ${(e as Error)?.message}` }; }
};

let legs = 0;
const skipped: string[] = [];
for (const v of V.vectors) {
  let ran = false;
  if (v.build && LOCAL_SURFACES.includes("build")) {
    ran = true; legs++;
    if (v.kind === "refusal") {
      let threw = false, why = "";
      try { buildSiwcMessage(v.build.fields); } catch (e) { threw = true; why = String((e as Error)?.message); }
      ok(`${v.id} build REFUSES: ${v.label}${threw ? ` [${why}]` : ""}`, threw);
    } else {
      let m: string | null = null, d: string | null = null, err = "";
      try { m = buildSiwcMessage(v.build.fields); d = siwcDigest(m); } catch (e) { err = String((e as Error)?.message); }
      ok(`${v.id} build ACCEPTS and reproduces the pinned canonical bytes + digest: ${v.label}${err ? ` [threw ${err}]` : ""}`,
        m === v.build.message && d === v.build.digest);
    }
  }
  if (v.verify && LOCAL_SURFACES.includes("verify")) {
    ran = true; legs++;
    const r = safeVerify(v.verify);
    if (v.kind === "refusal") {
      ok(`${v.id} verify REFUSES with reason "${v.verify.reason}": ${v.label} [got ${r.ok ? "ok:true" : r.reason}]`,
        r.ok === false && r.reason === v.verify.reason);
    } else {
      ok(`${v.id} verify ACCEPTS and returns the key-derived account: ${v.label} [got ${r.ok ? r.account : r.reason}]`,
        r.ok === true && r.account === v.verify.account);
    }
  }
  if (!ran) skipped.push(v.id);
}

console.log("=== the corpus was actually exercised (a gate that runs nothing is not a gate) ===");
ok(`executed exactly the pinned number of vector legs (${EXPECTED_LEGS}, got ${legs})`, legs === EXPECTED_LEGS);
ok(`skipped exactly the pinned vector ids (${JSON.stringify(EXPECTED_SKIPPED)}, got ${JSON.stringify(skipped)})`,
  JSON.stringify(skipped) === JSON.stringify(EXPECTED_SKIPPED));

console.log(`\nsiwc refusal-parity: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
