// primary.test.ts — pins the promoted reverse/primary-name selector (src/primary.ts). Two layers:
// (1) INLINE core cases so this package's CI pins the contract with no sibling checkouts;
// (2) the canonical golden vectors, VENDORED at test/fixtures/primary-vectors.json (REQUIRED: a missing
//     fixture is a hard fail, never a skip); the sibling cairnx service checkout, when present, is a
//     byte-parity tripwire so the vendored copy cannot silently drift from the canonical source.
// The promoted selector lowercases the QUERY address (record fields are canonical lowercase on
// chain); the uppercase-query case below pins that, killing the old copies' documented nuance.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pickPrimaryName, primaryRankBefore, type NameState } from "../src/index.js";

let pass = 0;
const t = (name: string, fn: () => void) => {
  const r = fn() as unknown;
  if (r !== undefined) throw new Error(`test "${name}" returned a value - use assert`);
  pass++; console.log("  ok", name);
};

const A = "0x" + "11".repeat(20), B = "0x" + "22".repeat(20);
const n = (o: Partial<NameState> & { name: string }): NameState =>
  ({ owner: A, addr: A, effectiveHeight: 100, claimId: "0xaa", height: 100, locked: false, ...o } as NameState);

t("no names -> null", () => assert.equal(pickPrimaryName([], A), null));
t("owner without self-pointer -> null (no reverse-map without the nset round-trip)", () =>
  assert.equal(pickPrimaryName([n({ name: "elsewhere", addr: B })], A), null));
t("self-pointer owned by someone else -> null (no spoofing)", () =>
  assert.equal(pickPrimaryName([n({ name: "spoof", owner: B, addr: A })], A), null));
t("oldest self-pointing wins regardless of order", () =>
  assert.equal(pickPrimaryName([
    n({ name: "aaa", effectiveHeight: 300 }), n({ name: "zzz", effectiveHeight: 100 }), n({ name: "mmm", effectiveHeight: 200 }),
  ], A), "zzz"));
t("effectiveHeight tie -> lower code-unit claimId wins", () =>
  assert.equal(pickPrimaryName([
    n({ name: "bee", claimId: "0xbbbbbbbb" }), n({ name: "ay", claimId: "0xaaaaaaaa" }),
  ], A), "ay"));
t("expired and locked candidates are excluded", () =>
  assert.equal(pickPrimaryName([
    n({ name: "lapsed", expired: true }), n({ name: "held", locked: true, effectiveHeight: 50 }), n({ name: "live", effectiveHeight: 200 }),
  ], A), "live"));
t("UPPERCASE query address resolves identically (query is lowercased, records are canonical)", () => {
  // MUST use an address with a-f hex letters: an all-digit address uppercases to itself, so it would
  // pass with or without the defensive .toLowerCase() and pin nothing. This C-bearing address exercises
  // the case-fold for real - drop the lowercase in pickPrimaryName and this fails.
  const C = "0x" + "cd".repeat(20);
  const rec = n({ name: "casefold", owner: C, addr: C });
  assert.equal(pickPrimaryName([rec], C.toUpperCase().replace("0X", "0x")), "casefold");
  assert.equal(pickPrimaryName([rec], C), "casefold");   // lowercase query still works (idempotent)
});
t("primaryRankBefore: the exported comparator matches the selection order", () => {
  assert.equal(primaryRankBefore(n({ name: "x", effectiveHeight: 1 }), n({ name: "y", effectiveHeight: 2 })), true);
  assert.equal(primaryRankBefore(n({ name: "x", claimId: "0xaa" }), n({ name: "y", claimId: "0xbb" })), true);
  assert.equal(primaryRankBefore(n({ name: "x", claimId: "0xbb" }), n({ name: "y", claimId: "0xaa" })), false);
});

// ── canonical golden vectors: vendored copy REQUIRED, sibling checkout is a byte-parity tripwire ──
const here = dirname(fileURLToPath(import.meta.url));
const vendoredPath = join(here, "fixtures/primary-vectors.json");
if (!existsSync(vendoredPath)) {
  throw new Error(`canonical primary-vectors fixture MISSING at ${vendoredPath}: the golden vectors are load-bearing (12 of 20 assertions); a missing fixture is a hard fail, never a skip`);
}
const siblingPath = join(here, "../../../../cairnx/test/fixtures/primary-vectors.json");
if (existsSync(siblingPath) && readFileSync(vendoredPath, "utf8") !== readFileSync(siblingPath, "utf8")) {
  throw new Error(`primary-vectors DRIFT: ${vendoredPath} differs from canonical ${siblingPath}; byte-copy the canonical file over the vendored one in the same change as the upstream edit`);
}
const fx = JSON.parse(readFileSync(vendoredPath, "utf8"));
assert.ok(Array.isArray(fx.cases) && fx.cases.length >= 11, `fixture truncated (${fx.cases?.length ?? 0} cases)`);
const addr = (x: string | null | undefined) => (x == null ? undefined : (fx.addresses[x] ?? x));
for (const c of fx.cases) {
  t(`vector: ${c.desc}`, () => {
    const names = c.names.map((v: Record<string, unknown>) => ({ ...v, owner: addr(v.owner as string), addr: addr(v.addr as string) }) as NameState);
    assert.equal(pickPrimaryName(names, addr(c.addr)!), c.expected);
  });
}

console.log(`\nprimary: ${pass} passed`);
