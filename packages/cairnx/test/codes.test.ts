// CONVENTION §40, the reason codes: the table's shape; every hand-written resolve case of test/vectors/codes.json against
// src, and the file's reach; over every pinned input, every entry carries a code whose outcome is its `ok`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CAP_CODES, REASON_CODES, REASON_CODE_OUTCOME, resolve, type AppliedEvent, type ChainEvent } from "../src/index.js";

let pass = 0;
const ok = (name: string, cond: boolean) => { assert.ok(cond, name); pass++; };
const json = <T>(rel: string): T => JSON.parse(readFileSync(new URL(rel, import.meta.url), "utf8")) as T;

// ── the table ──
ok("the table holds 113 codes", REASON_CODES.length === 113);
ok("no code is repeated", new Set(REASON_CODES).size === REASON_CODES.length);
const NAMING = /^(RECORD|GATE|TOKEN|NAME|OFFER|BID|FILL|CLAIM|EXPIRY|TREASURY|CAP|INVARIANT)_[A-Z0-9_]{2,}$/;
const misnamed = REASON_CODES.filter((c) => !NAMING.test(c) || c.length > 40);
ok(`every code has a family prefix, upper snake case, at most 40 characters (${misnamed.join(", ") || "none off"})`, misnamed.length === 0);
ok("the outcome map has exactly the listed codes", JSON.stringify(Object.keys(REASON_CODE_OUTCOME)) === JSON.stringify(REASON_CODES));
const applied = REASON_CODES.filter((c) => REASON_CODE_OUTCOME[c] === "applied");
const refused = REASON_CODES.filter((c) => REASON_CODE_OUTCOME[c] === "refused");
ok("26 applied and 87 refused codes, nothing else", applied.length === 26 && refused.length === 87);
ok("every record code is a refusal", REASON_CODES.filter((c) => c.startsWith("RECORD_")).every((c) => REASON_CODE_OUTCOME[c] === "refused"));
ok("CAP_CODES are exactly the CAP_ codes, all refusals", JSON.stringify([...CAP_CODES]) === JSON.stringify(REASON_CODES.filter((c) => c.startsWith("CAP_")))
  && CAP_CODES.length === 3 && CAP_CODES.every((c) => REASON_CODE_OUTCOME[c] === "refused"));
ok("the list, the map and the caps are frozen", Object.isFrozen(REASON_CODES) && Object.isFrozen(REASON_CODE_OUTCOME) && Object.isFrozen(CAP_CODES));

// ── the hand-written vectors ──
type Expected = [string, string, boolean, string];
type ResolveCase = { name: string; tipHeight: number; events: ChainEvent[]; expect: Expected[] };
const vectors = json<{ format: number; resolve: ResolveCase[]; records: { name: string; code: string | null }[] }>("./vectors/codes.json");
ok("codes.json is format 1", vectors.format === 1);
const key = (x: unknown) => JSON.stringify(x);
for (const c of vectors.resolve) {
  const got = resolve(c.events, c.tipHeight).events.map((e) => [e.id, e.kind, e.ok, e.code ?? null]);
  ok(`codes.json ${c.name}: the log holds exactly the expected entries`, key(got.map(key).sort()) === key(c.expect.map(key).sort()));
}
// Codes no event can produce; each guards a state the rules around it rule out:
//   NAME_RECLAIMED: the pay-now reclaim of a lapsed name below V26, while the earliest lapse falls far above V26;
//   NAME_RESERVATION_EXPIRED: the sweep before each event drops a reservation past finalizeBy, so a late finalize finds
//     none (the cases nfinalize-after-finalize-by and recapture-finalize-after-finalize-by pin NAME_NO_RESERVATION);
//   NAME_NOT_LAPSED: nothing renews, re-registers or re-anchors a lapsed record before its recapture finalize;
//   INVARIANT_BROKEN: an open offer's name or give lock is never missing.
const UNREACHABLE = new Set(["NAME_RECLAIMED", "NAME_RESERVATION_EXPIRED", "NAME_NOT_LAPSED", "INVARIANT_BROKEN"]);
// The record cases are checked against explainRecord in records-explain.test.ts; here they count toward the reach.
const reached = new Set([...vectors.resolve.flatMap((c) => c.expect.map((e) => e[3])), ...vectors.records.flatMap((r) => (r.code === null ? [] : [r.code]))]);
const unreached = REASON_CODES.filter((c) => !reached.has(c) && !UNREACHABLE.has(c));
ok(`codes.json reaches every code but the ${UNREACHABLE.size} unreachable ones (${unreached.join(", ") || "none missing"})`, unreached.length === 0);
ok("no unreachable code is reached", [...UNREACHABLE].every((c) => !reached.has(c)));

// ── every pinned input ──
type Case = { name: string; events: ChainEvent[]; tipHeight: number };
const inputs: Case[] = [];
const corpus = json<{ events: ChainEvent[]; tipHeight: number }>("./vectors/replay-corpus.json");
inputs.push({ name: "replay corpus at its tip", events: corpus.events, tipHeight: corpus.tipHeight });
for (const f of ["cases.json", "cases-rules.json", "cases-v29.json"]) for (const c of json<{ cases: Case[] }>(`./vectors/${f}`).cases) inputs.push({ ...c, name: `${f}:${c.name}` });
for (const c of vectors.resolve) inputs.push({ ...c, name: `codes.json:${c.name}` });
let entries = 0, coded = 0;
const contradicting: string[] = [], missing: string[] = [];
for (const c of inputs) {
  for (const e of resolve(c.events, c.tipHeight).events as AppliedEvent[]) {
    entries++;
    if (e.code !== undefined) {
      coded++;
      if (REASON_CODE_OUTCOME[e.code] !== (e.ok ? "applied" : "refused")) contradicting.push(`${c.name}: ${e.id} ${e.kind} ok ${e.ok} ${e.code}`);
    } else missing.push(`${c.name}: ${e.id} ${e.kind}`);
  }
}
ok(`over ${inputs.length} inputs every code's outcome is its entry's ok (${contradicting.slice(0, 3).join("; ") || "none contradict"})`, contradicting.length === 0);
ok(`over ${inputs.length} inputs every entry carries a code (${missing.slice(0, 3).join("; ") || "none missing"})`, missing.length === 0);

console.log(`reason codes: ${pass} passed (${vectors.resolve.length} codes.json cases; ${entries} log entries over ${inputs.length} inputs, ${coded} coded)`);
