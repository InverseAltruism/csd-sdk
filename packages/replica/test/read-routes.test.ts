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
import { NOTE_CODES, NOT_VERIFIED_CODES, type NoteCode, type NotVerifiedCode } from "../src/codes.js";
import { READ_HEADERS, Scanner, WITHHELD, WITHHELD_NOTES, indexerFeed, replicaReads } from "../src/server.js";
import { fixtureSource } from "../src/testing.js";
import { done, ok } from "./check.js";
import { fx } from "./core-files.js";
import { CAPTURE_TIME, captureIndexer } from "./indexer-capture.js";
import { cap } from "./node-harness.js";
import { all } from "./hosted-harness.js";
import { callerReader, hashAt, nodeSource, timeAt, witnessOn } from "./reader-harness.js";
import { H0, KA, KB, KC, KEYS, buildChain, defaultSpecs, timeAt as chainTime } from "./scan/scan-chain.js";

const signed = buildChain(defaultSpecs({ A: KA, B: KB, C: KC }), { keys: KEYS });
const realOf = (f: typeof fetch): typeof fetch => (async (input: string | URL | Request, init?: RequestInit) => {
  const r = (await f(input, init)) as unknown as { status: number; json(): Promise<unknown> };
  return r instanceof Response ? r : new Response(JSON.stringify(await r.json()), { status: r.status });
}) as typeof fetch;

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
    h["access-control-expose-headers"] === "x-cairnx-at, x-cairnx-why, x-cairnx-notes" && h["x-cairnx-at"] === `${base.at!.height}:${base.at!.hash}` && h["x-cairnx-why"] === "" &&
    h["x-cairnx-notes"] === "" &&
    Object.keys(READ_HEADERS).every((k) => all.every((r) => r!.headers[k] === READ_HEADERS[k])), JSON.stringify(h));
  ok("another path: null, for the host to answer", (await reads("/cairnx/tokens")) === null && (await reads("/cairnx/name/UPPER")) === null && (await reads("/cairnx/name/")) === null);
}

console.log("each withheld code answers 503, never 404:");
// Written out here, not read from WITHHELD, so a code dropped from it fails below.
const WITHHOLD: readonly NotVerifiedCode[] = ["NOT_SYNCED", "STORE_UNCONFIRMED", "PIN_DISPUTED", "PIN_MISMATCH", "PIN_OFF_CHAIN", "RULES_DIFFER", "BRANCH_UNRESOLVED"];
ok("WITHHELD is these seven codes", JSON.stringify([...WITHHELD].sort()) === JSON.stringify([...WITHHOLD].sort()), WITHHELD.join(","));
for (const code of WITHHOLD) {
  const reads = given(withCode(code)), got = await Promise.all([...PATHS, ...UNREGISTERED].map((p) => reads(p)));
  ok(`${code}: 503 on all nine paths, ok false, the code in x-cairnx-why and in the error, the headers exposed`, got.every((r) => r?.status === 503 && JSON.parse(r.body).ok === false &&
    r.headers["x-cairnx-why"] === code && String(JSON.parse(r.body).error).includes(code) && r.headers["access-control-expose-headers"] === READ_HEADERS["access-control-expose-headers"]),
    got.map((r) => r?.status).join(","));
}
// Written out here, not read from WITHHELD_NOTES.
const WITHHOLD_NOTES: readonly NoteCode[] = ["SOURCES_DISAGREE", "PEER_FAR_AHEAD", "TIP_STALE_LONG", "SOURCE_FAILING"];
ok("WITHHELD_NOTES is these four notes", JSON.stringify([...WITHHELD_NOTES].sort()) === JSON.stringify([...WITHHOLD_NOTES].sort()), WITHHELD_NOTES.join(","));
for (const code of WITHHOLD_NOTES) {
  const a: Answer<Snapshot> = { ...base, notes: [{ code }] }, reads = given(a), got = await Promise.all([...PATHS, ...UNREGISTERED].map((p) => reads(p)));
  ok(`the note ${code} on a verified snapshot: 503 on all nine paths, the note in x-cairnx-notes and in the error`, got.every((r) => r?.status === 503 &&
    r.headers["x-cairnx-notes"] === code && r.headers["x-cairnx-why"] === "" && String(JSON.parse(r.body).error).includes(code)), got.map((r) => r?.status).join(","));
}
{
  const served = NOTE_CODES.filter((c) => !WITHHOLD_NOTES.includes(c)), bad: string[] = [];
  for (const code of served) {
    const r = await given({ ...base, notes: [{ code }] })(`/cairnx/resolve/${held}`);
    if (r?.status !== 200 || r.headers["x-cairnx-notes"] !== code) bad.push(code);
  }
  ok(`paired: the other ${served.length} notes (${served.join(", ")}) are served, 200, and named`, bad.length === 0 && served.includes("FINAL_VIEW"), bad.join(", "));
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

console.log("the withheld notes from real readers, each with its served neighbour:");
{
  const MIN = 60_000, BEH = TIP - 20, at = (h: number) => () => timeAt(h) * 1000 + MIN;
  const status = async (x: { r: Awaited<ReturnType<typeof open>> }) => { await x.r.advance(); const r = (await replicaReads(x.r)(`/cairnx/resolve/${held}`))!; await x.r.close(); return r; };
  // A witness's valid tip 13 and 12 blocks above the replica's (the tip it names, with a header that meets its bits).
  const lead = (n: number) => witnessOn(all, TIP, { id: `w${n}`, claim: (t) => ({ ...t, height: BEH + n }) }).witness;
  const far = await status(await callerReader(BEH, { witnesses: [witnessOn(all, BEH).witness, lead(FINAL_DEPTH + 1)], clock: at(BEH) }));
  const near = await status(await callerReader(BEH, { witnesses: [witnessOn(all, BEH).witness, lead(FINAL_DEPTH)], clock: at(BEH) }));
  ok(`a witness ${FINAL_DEPTH + 1} blocks ahead: PEER_FAR_AHEAD, 503; ${FINAL_DEPTH} ahead: TIP_BEHIND_PEER served, 200`,
    far.status === 503 && far.headers["x-cairnx-notes"]?.includes("PEER_FAR_AHEAD") === true && near.status === 200 && near.headers["x-cairnx-why"] === "TIP_BEHIND_PEER" &&
    near.headers["x-cairnx-notes"]?.includes("PEER_FAR_AHEAD") === false, `${far.status} ${far.headers["x-cairnx-notes"]} | ${near.status} ${near.headers["x-cairnx-why"]} ${near.headers["x-cairnx-notes"]}`);
  const against = await status(await callerReader(BEH, { witnesses: [witnessOn(all, BEH, { id: "other", claim: (t) => ({ ...t, hash: hashAt(BEH - 1) }) }).witness], clock: at(BEH) }));
  const agree = await status(await callerReader(BEH, { witnesses: [witnessOn(all, BEH).witness], clock: at(BEH) }));
  ok("a witness naming another block at the replica's height: SOURCES_DISAGREE, 503; one naming the replica's: 200",
    against.status === 503 && against.headers["x-cairnx-notes"]?.includes("SOURCES_DISAGREE") === true && agree.status === 200 && agree.headers["x-cairnx-notes"] === "",
    `${against.status} ${against.headers["x-cairnx-notes"]} | ${agree.status} ${agree.headers["x-cairnx-notes"]}`);
  // One's own node, its tip a header time; the clock 5 h 59 min and 6 h 1 min after it.
  const aged = async (min: number) => { const r = await open({ source: nodeSource(), clock: () => timeAt(TIP) * 1000 + min * MIN }); return status({ r }); };
  const young = await aged(5 * 60 + 59), old = await aged(6 * 60 + 1);
  ok("a tip 5 h 59 min old: TIP_STALE served, 200; 6 h 1 min old: TIP_STALE_LONG, 503", young.status === 200 && young.headers["x-cairnx-why"] === "TIP_STALE" &&
    young.headers["x-cairnx-notes"] === "" && old.status === 503 && old.headers["x-cairnx-notes"] === "TIP_STALE_LONG", `${young.status} ${young.headers["x-cairnx-notes"]} | ${old.status} ${old.headers["x-cairnx-notes"]}`);
}

console.log("a real indexerFeed with inclusion: FINAL_VIEW reaches the header:");
{
  const TT = H0 + 40, clockAt = () => (chainTime(TT - FINAL_DEPTH) + 60) * 1000;
  const r = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: realOf(signed.indexer({ tip: TT })), pageSize: 3, ...signed.verified({ verifiedTip: TT }) }), clock: clockAt,
    step: { maxBlocks: 100_000, maxRequests: 100_000 } });
  await r.advance();
  const got = (await replicaReads(r)("/cairnx/state"))!;
  ok("200, LEVEL_FEED in x-cairnx-why and FINAL_VIEW in x-cairnx-notes, at the final height", got.status === 200 && got.headers["x-cairnx-why"] === "LEVEL_FEED" &&
    got.headers["x-cairnx-notes"] === "FINAL_VIEW" && got.headers["x-cairnx-at"]?.startsWith(`${TT - FINAL_DEPTH}:`) === true, JSON.stringify(got.headers));
  await r.close();
  // An honest witness of the same chain, its tip `n` above the verified tip the feed read: the view's tip is the final
  // height, FINAL_DEPTH below that, so the witness leads by FINAL_DEPTH + n.
  const withWitness = async (n: number) => {
    const inner = witnessOn(all, cap.to, { id: `w${n}`, claim: (t) => ({ ...t, height: TT + n }) }).witness;
    const witness = { ...inner, hashAt: async (h: number) => (h <= TT + n ? signed.hashAt(h) : null) };
    const x = await open({ source: indexerFeed({ indexerUrl: "http://idx", fetch: realOf(signed.indexer({ tip: TT })), pageSize: 3, ...signed.verified({ verifiedTip: TT }) }),
      witnesses: [witness], clock: clockAt, step: { maxBlocks: 100_000, maxRequests: 100_000 } });
    await x.advance();
    const g = (await replicaReads(x)("/cairnx/state"))!;
    await x.close();
    return g;
  };
  const leads = [1, 2, FINAL_DEPTH, FINAL_DEPTH + 1];
  const seen = await Promise.all(leads.map(async (n) => ({ n, g: await withWitness(n) })));
  const shown = seen.map(({ n, g }) => `+${n} ${g.status} ${g.headers["x-cairnx-why"]} ${g.headers["x-cairnx-notes"]}`).join(" | ");
  ok(`with inclusion, a witness 1, 2 and ${FINAL_DEPTH} above the verified tip (a lead of ${FINAL_DEPTH + 1} to ${2 * FINAL_DEPTH} over the final height): TIP_BEHIND_PEER served, 200`,
    seen.slice(0, 3).every(({ g }) => g.status === 200 && g.headers["x-cairnx-why"] === "LEVEL_FEED,TIP_BEHIND_PEER" && g.headers["x-cairnx-notes"] === "FINAL_VIEW"), shown);
  ok(`with inclusion, a witness ${FINAL_DEPTH + 1} above the verified tip (a lead of ${2 * FINAL_DEPTH + 1}): PEER_FAR_AHEAD, 503`,
    seen[3]!.g.status === 503 && seen[3]!.g.headers["x-cairnx-notes"] === "FINAL_VIEW,PEER_FAR_AHEAD", shown);
}

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
