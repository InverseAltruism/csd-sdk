// The record size bound: a record lives in a Propose `uri`, which the node caps at 512 bytes
// (MAX_URI_BYTES). parseRecord must accept a canonical record of exactly 512 UTF-8 bytes and
// no-op one of 513; a drift either way forks this resolver from the Python oracle and the chain.
// The token decimals bound: MAX_TOKEN_DECIMALS is what parseRecord enforces on a deploy.
import { MAX_TOKEN_DECIMALS, parseRecord } from "../src/index.js";
import { canonicalJson, payloadHash } from "@inversealtruism/csd-codec";

let pass = 0;
const ok = (n: string, c: boolean) => { if (!c) { console.error("  ✗ " + n); process.exitCode = 1; } else { pass++; console.log("  ✓ " + n); } };

const bytes = (s: string) => new TextEncoder().encode(s).length;
// An nprofile with two values sized so the canonical record lands on an exact byte length
// (each value stays under the 256-byte per-value cap).
const profileOf = (total: number) => {
  const base = { v: 1, t: "nprofile", name: "alice", p: { a: "", b: "" } };
  const pad = total - bytes(canonicalJson(base));
  const half = Math.floor(pad / 2);
  return { ...base, p: { a: "x".repeat(half), b: "y".repeat(pad - half) } };
};
const parse = (obj: unknown) => parseRecord(canonicalJson(obj), payloadHash(obj));

const at512 = profileOf(512), at513 = profileOf(513);
ok("the 512-byte fixture is exactly 512 bytes", bytes(canonicalJson(at512)) === 512);
ok("the 513-byte fixture is exactly 513 bytes", bytes(canonicalJson(at513)) === 513);
ok("a 512-byte record parses", parse(at512) !== null);
ok("a 513-byte record is a no-op", parse(at513) === null);
// The bound counts UTF-8 bytes, not UTF-16 code units: 2-byte characters reach 513 bytes with fewer units.
const wide = { ...at512, p: { ...at512.p, a: at512.p.a.slice(0, -2) + "é" + "x" } };
ok("a record of 512 code units but 513 bytes is a no-op", canonicalJson(wide).length === 512 && bytes(canonicalJson(wide)) === 513 && parse(wide) === null);

const deployWith = (decimals: number) => parse({ v: 1, t: "deploy", ticker: "AAA", decimals, supply: "100", mint: "issuer" });
ok("MAX_TOKEN_DECIMALS is 8", MAX_TOKEN_DECIMALS === 8);
ok("a deploy with 0 or MAX_TOKEN_DECIMALS decimals parses", deployWith(0) !== null && deployWith(MAX_TOKEN_DECIMALS) !== null);
ok("a deploy with MAX_TOKEN_DECIMALS + 1 decimals is a no-op", deployWith(MAX_TOKEN_DECIMALS + 1) === null);

console.log(`cairnx-core record bounds: ${pass}/8`);
