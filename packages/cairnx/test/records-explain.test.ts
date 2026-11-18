// CONVENTION §40, the record codes: explainRecord against every record case of test/vectors/codes.json; parseRecord and
// explainRecord agree on every Propose of the pinned inputs and on systematic edits of the valid ones (one body serves
// both); the builders refuse with a RecordError that names the rule. Acceptance against cairnx-core 0.2.4 is the seal's
// parse differential (scripts/seal-differential.mjs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalJson, payloadHash } from "@inversealtruism/csd-codec";
import {
  REASON_CODE_OUTCOME, RecordError, explainRecord, isName, mint, nameClaim, nameProfile, parseAmount, parseRecord, transfer,
  type ChainEvent, type RecordCode,
} from "../src/index.js";

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; };
const json = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as T;

// ── the record cases ──
type RecordCase = { name: string; uri: string; payloadHash: string; code: RecordCode | null };
const vectors = json<{ resolve: { events: ChainEvent[] }[]; records: RecordCase[] }>("./vectors/codes.json");
for (const r of vectors.records) {
  const x = explainRecord(r.uri, r.payloadHash);
  ok(`codes.json ${r.name}: explainRecord gives ${r.code ?? "the record"}`, (x.ok ? null : x.code) === r.code);
  ok(`codes.json ${r.name}: parseRecord is null exactly when a code is expected`, (parseRecord(r.uri, r.payloadHash) === null) === (r.code !== null));
}

// ── agreement over the pinned inputs and edits of their valid records ──
const uris = new Map<string, { uri: string; payloadHash: string }>();
const take = (events: ChainEvent[]) => { for (const e of events) if (e.kind === "propose") uris.set(`${e.uri}\u0000${e.payloadHash}`, { uri: e.uri, payloadHash: e.payloadHash }); };
take(json<{ events: ChainEvent[] }>("./vectors/replay-corpus.json").events);
for (const f of ["cases.json", "cases-rules.json", "cases-v29.json"]) for (const c of json<{ cases: { events: ChainEvent[] }[] }>(`./vectors/${f}`).cases) take(c.events);
for (const c of vectors.resolve) take(c.events);
const inputs = [...uris.values()];
const valid = inputs.map((u) => parseRecord(u.uri, u.payloadHash)).filter((r) => r !== null) as unknown as Record<string, unknown>[];
const WRONG: unknown[] = [0, -1, 1.5, "", "x", "0", null, true, [], {}];
for (const r of valid) {
  for (const k of Object.keys(r)) {
    const { [k]: _gone, ...without } = r;
    inputs.push({ uri: canonicalJson(without), payloadHash: payloadHash(without) });
    for (const w of WRONG) { const edited = { ...r, [k]: w }; inputs.push({ uri: canonicalJson(edited), payloadHash: payloadHash(edited) }); }
  }
}
let accepted = 0;
const disagree: string[] = [];
for (const { uri, payloadHash: ph } of inputs) {
  const p = parseRecord(uri, ph), x = explainRecord(uri, ph);
  const agrees = x.ok ? p !== null && JSON.stringify(x.record) === JSON.stringify(p) : p === null && x.code.startsWith("RECORD_") && REASON_CODE_OUTCOME[x.code] === "refused";
  if (!agrees) disagree.push(uri);
  if (p !== null) accepted++;
}
ok(`parseRecord and explainRecord agree on ${inputs.length} records, ${accepted} accepted (${disagree.slice(0, 2).join("; ") || "none disagree"})`, disagree.length === 0);
ok("the edits refuse more than they accept, and both happen", accepted > 100 && inputs.length - accepted > 1_000);

// ── the builders ──
const refusal = (f: () => unknown): RecordError | null => { try { f(); return null; } catch (e) { return e instanceof RecordError ? e : null; } };
const cases: [string, () => unknown, RecordCode][] = [
  ["mint with a lower-case ticker", () => mint({ ticker: "aaa", amount: "1" }), "RECORD_BAD_TICKER"],
  ["a reserved name", () => nameClaim({ name: "admin" }), "RECORD_NAME_RESERVED"],
  ["a memo over 64 units", () => transfer({ ticker: "AAA", to: "0x" + "ab".repeat(20), amount: "1", memo: "m".repeat(65) }), "RECORD_BAD_TEXT"],
  ["a profile of 17 keys", () => nameProfile({ name: "alice", p: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, ""])) }), "RECORD_PROFILE_TOO_MANY_KEYS"],
  ["a profile over 512 bytes", () => nameProfile({ name: "alice", p: { a: "x".repeat(200), b: "x".repeat(200), c: "x".repeat(200) } }), "RECORD_TOO_LARGE"],
];
for (const [what, f, code] of cases) {
  const e = refusal(f);
  ok(`the builder refuses ${what} with ${code}`, e !== null && e.code === code && e instanceof Error && e.name === "RecordError"
    && e.message === `record does not validate against CONVENTION.md (${code})`);
}
const honest = mint({ ticker: "AAA", amount: "1" });
ok("an honest builder call returns a record that parses", parseRecord(honest.uri, honest.payloadHash) !== null && explainRecord(honest.uri, honest.payloadHash).ok);

// ── the two exported checks the record codes are read from keep their answers ──
ok("parseAmount: 0 only where zero is allowed, 2^96 - 1 the largest, no leading zero, strings only",
  parseAmount("0") === null && parseAmount("0", { allowZero: true }) === 0n && parseAmount("79228162514264337593543950335") === (1n << 96n) - 1n
  && parseAmount("79228162514264337593543950336") === null && parseAmount("007") === null && parseAmount(5) === null);
ok("isName: lower-case ASCII and not reserved", isName("alice") && isName("a-1") && !isName("admin") && !isName("Alice") && !isName("-a") && !isName(5));

console.log(`record codes: ${pass} passed (${vectors.records.length} record cases; ${inputs.length} records agree)`);
