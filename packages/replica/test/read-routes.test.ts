// replicaReads (./server): the resolver's five state reads from a replica's snapshot.
// (1) The withhold rule, on a synced snapshot given each code: every WITHHELD code, and BEHIND from FINAL_DEPTH below
// the tip, answers 503 on every route, an unregistered name included, so a 404 comes only from a handler's "not
// registered"; paired, the honest synced snapshot answers 200, and 404 with the handler's own body for an unregistered
// name; every other code is served and named in x-cairnx-why. Headers: the resolver's, the two of the verdict, and
// access-control-expose-headers naming both.
// (2) Byte equality with the hosted resolver on cairnx-core's recorded fixture to 117,000: the replica's answers over
// fixtureSource against the resolver's computation of the same routes (its Scanner over the capture as a csd-indexer,
// resolve() of the scan's events at its tip, nameHistory with the state's record and applied ids), for /cairnx/state
// and each of the four name routes for every name in the state and an unregistered one.
import { FINAL_DEPTH, canonicalState, resolve, type CairnXState } from "@inversealtruism/cairnx-core";
import { appliedIds, nameHistory, open, readName, readNameHistory, readProfile, readResolve, readState, type Answer, type ReadSnapshot, type Snapshot } from "../src/index.js";
import { NOT_VERIFIED_CODES, type NotVerifiedCode } from "../src/codes.js";
import { READ_HEADERS, Scanner, WITHHELD, replicaReads } from "../src/server.js";
import { fixtureSource } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { CAPTURE_TIME, captureIndexer } from "./indexer-capture.js";
import { cap } from "./node-harness.js";
import { nodeSource, timeAt } from "./reader-harness.js";

const TIP = cap.to;
const synced = await open({ source: nodeSource(), clock: () => timeAt(TIP) * 1000 + 60_000 });
await synced.advance();
const base = await synced.snapshot();
if (!base.verified) throw new Error("the recorded node's replica is not synced");
const held = Object.keys(base.value.state.names).find((n) => base.value.state.names[n]!.pending !== true)!;
const PATHS = ["/cairnx/state", `/cairnx/name/${held}`, `/cairnx/resolve/${held}`, `/cairnx/name-history/${held}`, `/cairnx/profile/${held}`];
const UNREGISTERED = ["/cairnx/name/zzcontracttest", "/cairnx/resolve/zzcontracttest", "/cairnx/name-history/zzcontracttest", "/cairnx/profile/zzcontracttest"];
const given = (a: Answer<Snapshot>) => replicaReads({ snapshot: async () => a });
const withCode = (code: NotVerifiedCode, tipAbove = 0): Answer<Snapshot> =>
  ({ ...base, verified: false, value: null, shown: base.value, why: [{ code }], at: { ...base.at!, tipHeight: base.at!.tipHeight + tipAbove, depth: tipAbove } });

console.log("the honest synced path, and the headers:");
{
  const reads = given(base), direct = { state: base.value.state, canonical: canonicalState,
    history: (s: CairnXState, name: string) => nameHistory([...base.value.events], name, { tipHeight: s.tipHeight, fullRecord: s.names[name], fullApplied: appliedIds(s.events) }) };
  const all = await Promise.all([...PATHS, ...UNREGISTERED].map((p) => reads(p)));
  ok("200 on each of the five routes for a held name", all.slice(0, 5).every((r) => r?.status === 200), all.map((r) => r?.status).join(","));
  const hand = [readName, readResolve, readNameHistory, readProfile].map((f) => f(direct, "zzcontracttest"));
  ok("an unregistered name: 404 on each name route, the handler's own body", all.slice(5).every((r, i) => r?.status === 404 && r.body === hand[i]!.body));
  const h = all[0]!.headers;
  ok("the resolver's headers, x-cairnx-at naming the view's block, x-cairnx-why empty, both exposed to another origin",
    h["content-type"] === "application/json; charset=utf-8" && h["access-control-allow-origin"] === "*" && h["x-content-type-options"] === "nosniff" &&
    h["access-control-expose-headers"] === "x-cairnx-at, x-cairnx-why" && h["x-cairnx-at"] === `${base.at!.height}:${base.at!.hash}` && h["x-cairnx-why"] === "" &&
    Object.keys(READ_HEADERS).every((k) => all.every((r) => r!.headers[k] === READ_HEADERS[k])), JSON.stringify(h));
  ok("another path: null, for the host to answer", (await reads("/cairnx/tokens")) === null && (await reads("/cairnx/name/UPPER")) === null && (await reads("/cairnx/name/")) === null);
}

console.log("each withheld code answers 503, never 404:");
// Written out here, not read from WITHHELD, so a code dropped from it fails below.
const WITHHOLD: readonly NotVerifiedCode[] = ["NOT_SYNCED", "STORE_UNCONFIRMED", "PIN_DISPUTED", "PIN_MISMATCH", "PIN_OFF_CHAIN", "RULES_DIFFER", "BRANCH_UNRESOLVED"];
ok("WITHHELD is these seven codes", JSON.stringify([...WITHHELD].sort()) === JSON.stringify([...WITHHOLD].sort()), WITHHELD.join(","));
for (const code of WITHHOLD) {
  const reads = given(withCode(code)), got = await Promise.all([...PATHS, ...UNREGISTERED].map((p) => reads(p)));
  ok(`${code}: 503 on all nine paths, ok false, the code in x-cairnx-why and in the error`, got.every((r) => r?.status === 503 && JSON.parse(r.body).ok === false &&
    r.headers["x-cairnx-why"] === code && String(JSON.parse(r.body).error).includes(code)), got.map((r) => r?.status).join(","));
}
{
  const none: Answer<Snapshot> = { ...base, verified: false, value: null, shown: null, why: [{ code: "NOT_SYNCED" }], at: null };
  const r = await given(none)("/cairnx/resolve/zzcontracttest");
  ok("nothing shown (NOT_SYNCED before a step): 503 and no x-cairnx-at", r?.status === 503 && r.headers["x-cairnx-at"] === undefined);
  const near = await given(withCode("BEHIND", FINAL_DEPTH - 1))(`/cairnx/resolve/${held}`), far = await given(withCode("BEHIND", FINAL_DEPTH))(`/cairnx/resolve/${held}`);
  ok(`BEHIND ${FINAL_DEPTH - 1} below the tip: served, 200, named; ${FINAL_DEPTH} below: 503`, near?.status === 200 && near.headers["x-cairnx-why"] === "BEHIND" && far?.status === 503);
}

console.log("every other code is served:");
{
  const served = NOT_VERIFIED_CODES.filter((c) => !WITHHOLD.includes(c) && c !== "BEHIND");
  const bad: string[] = [];
  for (const code of served) {
    const r = await given(withCode(code))(`/cairnx/resolve/${held}`), honest = await given(base)(`/cairnx/resolve/${held}`);
    if (r?.status !== 200 || r.body !== honest!.body || r.headers["x-cairnx-why"] !== code) bad.push(code);
  }
  ok(`${served.length} codes (${served.join(", ")}): 200 with the honest body and the code named`, bad.length === 0 && served.includes("LEVEL_FEED") && served.includes("TIP_STALE"), bad.join(", "));
}
await synced.close();

console.log("byte for byte the hosted resolver's, on the recorded fixture to 117,000:");
{
  const r = await open({ source: fixtureSource(fx, { tipTime: CAPTURE_TIME }), clock: () => CAPTURE_TIME * 1000 + 60_000, step: { maxBlocks: 100_000, maxRequests: 100_000 } });
  const s = await r.advance();
  const reads = replicaReads(r);
  const scan = await new Scanner({ indexerUrl: "http://idx", fetch: captureIndexer(fx) }).scan();
  const events = scan.events.filter((e) => e.height <= scan.tipHeight), state = resolve(events, scan.tipHeight), applied = appliedIds(state.events);
  const theirs: ReadSnapshot = { state, canonical: canonicalState, history: (st, name) => nameHistory(events, name, { tipHeight: st.tipHeight, fullRecord: st.names[name], fullApplied: applied }) };
  const names = [...Object.keys(state.names), "zzcontracttest"], differ: string[] = [];
  let compared = 0, notFound = 0;
  const one = async (path: string, want: { status: number; body: string }) => {
    const got = await reads(path);
    compared++;
    if (want.status === 404) notFound++;
    if (got?.status !== want.status || got.body !== want.body) differ.push(path);
  };
  await one("/cairnx/state", readState(theirs));
  for (const n of names) {
    await one(`/cairnx/name/${n}`, readName(theirs, n));
    await one(`/cairnx/resolve/${n}`, readResolve(theirs, n));
    await one(`/cairnx/name-history/${n}`, readNameHistory(theirs, n));
    await one(`/cairnx/profile/${n}`, readProfile(theirs, n));
  }
  ok(`the replica at the fixture's tip ${fx.to}, the resolver's scan at ${scan.tipHeight}`, s.cursor?.height === fx.to && scan.tipHeight === fx.to);
  ok(`${compared} answers over ${names.length - 1} names and an unregistered one (${notFound} of them 404): ${differ.length} differ`,
    differ.length === 0 && names.length > 1 && compared === 1 + 4 * names.length, differ.slice(0, 5).join(" "));
  await r.close();
}

done("cairnx-replica read routes");
