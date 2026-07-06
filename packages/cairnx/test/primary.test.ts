// primary.test.ts — pins the promoted reverse/primary-name selector (src/primary.ts). Two layers:
// (1) INLINE core cases so this package's CI pins the contract with no sibling checkouts;
// (2) the canonical golden vectors from the cairnx service repo (sibling checkout), the SAME file
//     that pins the service shim and the cairn UI adapter — when present, every case must agree.
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
t("UPPERCASE query address resolves identically (query is lowercased, records are canonical)", () =>
  assert.equal(pickPrimaryName([n({ name: "casefold" })], A.toUpperCase().replace("0X", "0x")), "casefold"));
t("primaryRankBefore: the exported comparator matches the selection order", () => {
  assert.equal(primaryRankBefore(n({ name: "x", effectiveHeight: 1 }), n({ name: "y", effectiveHeight: 2 })), true);
  assert.equal(primaryRankBefore(n({ name: "x", claimId: "0xaa" }), n({ name: "y", claimId: "0xbb" })), true);
  assert.equal(primaryRankBefore(n({ name: "x", claimId: "0xbb" }), n({ name: "y", claimId: "0xaa" })), false);
});

// ── canonical golden vectors (sibling cairnx service repo) — the cross-consumer lock ──
const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "../../../../cairnx/test/fixtures/primary-vectors.json");
if (!existsSync(fixturePath)) {
  console.warn("  ! sibling cairnx checkout absent - canonical primary-vectors cross-check SKIPPED (inline cases still pinned)");
} else {
  const fx = JSON.parse(readFileSync(fixturePath, "utf8"));
  assert.ok(Array.isArray(fx.cases) && fx.cases.length >= 11, `fixture truncated (${fx.cases?.length ?? 0} cases)`);
  const addr = (x: string | null | undefined) => (x == null ? undefined : (fx.addresses[x] ?? x));
  for (const c of fx.cases) {
    t(`vector: ${c.desc}`, () => {
      const names = c.names.map((v: Record<string, unknown>) => ({ ...v, owner: addr(v.owner as string), addr: addr(v.addr as string) }) as NameState);
      assert.equal(pickPrimaryName(names, addr(c.addr)!), c.expected);
    });
  }
}

console.log(`\nprimary: ${pass} passed`);
