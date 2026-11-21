// ./display: a name or a balance from our API at level 1. The honest path shows what cairnx-core's nameView and the
// replica's balance give over the served state; then every option the entry takes, crossed with what a server can
// answer, must give an answer that is not verified, states level 1 and leads with LEVEL_DISPLAY; then the bases it
// refuses. Requests go to a local function, never to a network.
import { epochOf, nameView, resolve, type CairnXState } from "@inversealtruism/cairnx-core";
import { hostedBlocks, nodeBlocks } from "../src/browser.js";
import { open as openDisplay, ourApi, type DisplayAnswer, type DisplaySource } from "../src/display.js";
import { open, ReplicaConfigError, type BalanceValue, type NameValue } from "../src/index.js";
import { fixtureSource } from "../src/testing.js";
import { done, ok } from "./check.js";
import { corpus, fx } from "./core-files.js";
import { callerHeaders, all, ORIGIN } from "./hosted-harness.js";

const TIP = 30_300, s: CairnXState = resolve(corpus.events.filter((e) => e.height <= TIP), TIP);
const HOLDER = Object.keys(s.balances.CAIRN!)[0]!, ABSENT = `0x${"0b".repeat(20)}`;
const codes = (a: { why: readonly { code: string }[] }) => a.why.map((w) => w.code).join(",");
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const outcome = <T>(p: Promise<T>) => p.then((v) => ({ v, e: null as unknown }), (e: unknown) => ({ v: null, e }));

// The resolver's two routes as cairnx serves them through the front door: the NameState with its extras, the token
// with its holders, a JSON refusal with 404 for an absent one.
function route(path: string): Response {
  const [kind, arg] = path.split("/") as [string, string];
  if (kind === "name") return Object.hasOwn(s.names, arg)
    ? json(200, { ...s.names[arg], offer: null, recapture: null, tipHeight: TIP, tipEpoch: epochOf(TIP), lease: null })
    : json(404, { ok: false, error: "unregistered name" });
  if (kind === "token" && Object.hasOwn(s.tokens, arg)) return json(200, { ...s.tokens[arg], holders: s.balances[arg] ?? {} });
  return json(404, { ok: false, error: "unknown ticker" });
}
const PREFIX = "/trade/api/cairnx/";
const served = (map: (path: string) => Response | Promise<Response>, seen: string[] = []): typeof fetch => async (input, init) => {
  init?.signal?.throwIfAborted();
  const u = new URL(String(input));
  seen.push(u.pathname);
  return map(u.pathname.slice(u.pathname.indexOf(PREFIX) + PREFIX.length));
};

console.log("the honest path: every name and every CAIRN holder at 30,300, as served:");
const seen: string[] = [];
const d = await openDisplay({ source: ourApi({ origin: "https://cairn.example", fetch: served(route, seen) }) });
const names = [...Object.keys(s.names), "constructor", "csd", "nobody"], wrong: string[] = [];
for (const n of names) {
  const a = await d.name(n);
  if (JSON.stringify(a.shown) !== JSON.stringify(nameView(s.names, n)) || a.verified || codes(a) !== "LEVEL_DISPLAY") wrong.push(n);
}
ok(`${names.length} names: each shown as nameView over the served state, LEVEL_DISPLAY alone, not verified`, wrong.length === 0, wrong.join(" "));
ok("one request a read, below /trade/api/cairnx/ on the origin", seen.length === names.length && seen[0] === `${PREFIX}name/${names[0]}`);
const holders = [...Object.keys(s.balances.CAIRN!), ABSENT], badBal: string[] = [];
for (const h of holders) {
  const a = await d.balance("CAIRN", h.toUpperCase().replace("0X", "0x")), b = s.balances.CAIRN![h];
  if (a.shown?.address !== h || a.shown.available !== (b?.available ?? "0") || a.shown.locked !== (b?.locked ?? "0") || a.shown.deployId !== s.tokens.CAIRN!.deployId) badBal.push(h);
}
const zz = await d.balance("ZZZ", HOLDER);
ok(`${holders.length} CAIRN balances (one absent) equal to the state's, the address read in lower case; an unknown ticker holds none`,
  badBal.length === 0 && zz.shown?.deployId === null && zz.shown.available === "0" && codes(zz) === "LEVEL_DISPLAY");
const first = await d.name("cairn");
ok("an answer: level 1, records served, the display basis as vouch (frozen), no position, value null", first.level === 1 && first.proof === "served" &&
  first.vouch.kind === "display" && Object.isFrozen(first.vouch) && first.at === null && first.value === null && first.notes.length === 0);

console.log("no option and no answer raises it:");
const good = (p: string) => route(p);
const BEHAVIOURS: Record<string, (p: string) => Response | Promise<Response>> = {
  honest: good,
  "a body claiming verified, level 3 and a value": async (p) => {
    const r = good(p), b = r.status === 200 ? await r.json() : { ok: false };
    return json(r.status === 200 ? 200 : 404, { ...b, verified: true, level: 3, value: b, why: [], proof: "inclusion", at: { height: TIP } });
  },
  "a 500": () => json(500, { ok: false }), "a 503": () => json(503, { ok: false }),
  "a 404 page that is not JSON": () => new Response("<html>not found</html>", { status: 404 }),
  "a 404 in JSON from another API (a wrong origin)": () => json(404, { error: "Not Found" }),
  "a 200 that is not JSON": () => new Response("ok", { status: 200 }),
  "a fetch that throws": () => { throw new TypeError("network down"); },
  "an owner out of form": async (p) => json(200, { ...((await good(p).json()) as object), owner: 5, holders: { [HOLDER]: { available: "-1", locked: "0" } } }),
  "another name or ticker": async (p) => json(200, { ...((await good(p).json()) as object), name: "other", ticker: "OTHER" }),
  "an array": () => json(200, []),
};
const ORIGINS = ["https://cairn.example", "https://cairn.example/", "http://127.0.0.1:7777"];
const TIMEOUTS = [undefined, 50];
const aborted = new AbortController();
aborted.abort();
const READS: [string, Record<string, unknown> | undefined][] = [["none", undefined], ["{}", {}], ["a signal", { signal: new AbortController().signal }],
  ["an aborted signal", { signal: aborted.signal }], ["the replica's options and claims", { minDepth: 0, waitMs: 1_000, verified: true, level: 3 }]];
let combos = 0;
const broken: string[] = [], expected: string[] = [];
const isDisplay = (a: DisplayAnswer<unknown>) => a.verified === false && a.value === null && a.level === 1 && a.why[0]?.code === "LEVEL_DISPLAY" &&
  a.proof === "served" && a.vouch.kind === "display" && a.at === null;
for (const [bn, b] of Object.entries(BEHAVIOURS)) for (const origin of ORIGINS) for (const timeoutMs of TIMEOUTS) {
  const r = await openDisplay({ source: ourApi({ origin, fetch: served(b), ...(timeoutMs === undefined ? {} : { timeoutMs }) }) });
  for (const [rn, ro] of READS) {
    const answers = [await r.name("cairn", ro as never), await r.name("constructor", ro as never), await r.name("Cairn", ro as never),
      await r.balance("CAIRN", HOLDER, ro as never), await r.balance("cairn", HOLDER, ro as never)];
    combos += answers.length;
    if (!answers.every(isDisplay)) broken.push(`${bn} / ${origin} / ${timeoutMs} / ${rn}`);
    // What each answer shows: the honest value when the body is in form and the read went out, else nothing.
    const out = rn === "an aborted signal" || !["honest", "a body claiming verified, level 3 and a value"].includes(bn);
    const [cairn, ctor, upper, bal, lower] = answers;
    const want = out ? cairn!.shown === null && codes(cairn!) === "LEVEL_DISPLAY,SOURCE_UNAVAILABLE" && bal!.shown === null
      : JSON.stringify(cairn!.shown) === JSON.stringify(nameView(s.names, "cairn")) && (ctor!.shown as NameValue | null)?.state === "free" &&
        (bal!.shown as BalanceValue | null)?.available === s.balances.CAIRN![HOLDER]!.available && codes(cairn!) === "LEVEL_DISPLAY";
    if (!want || codes(upper!) !== "LEVEL_DISPLAY,INPUT_INVALID" || codes(lower!) !== "LEVEL_DISPLAY,INPUT_INVALID") expected.push(`${bn} / ${origin} / ${rn}`);
  }
}
ok(`${combos} answers over ${Object.keys(BEHAVIOURS).length} server behaviours, ${ORIGINS.length} origins, ${TIMEOUTS.length} timeouts and ${READS.length} read options: none verified, each level 1 led by LEVEL_DISPLAY`,
  broken.length === 0, broken.slice(0, 3).join("; "));
ok("each shows the served value only from a body in form (claims ignored), else SOURCE_UNAVAILABLE with nothing shown; a name or ticker out of form is INPUT_INVALID",
  expected.length === 0, expected.slice(0, 3).join("; "));
const hang = await openDisplay({ source: ourApi({ origin: "https://cairn.example", timeoutMs: 20, fetch: (_i, init) => new Promise((_go, stop) => init?.signal?.addEventListener("abort", () => stop(init.signal!.reason))) }) });
const keep = setTimeout(() => undefined, 5_000);   // AbortSignal.timeout's timer does not hold the process open
const late = await hang.name("cairn");
clearTimeout(keep);
ok("a server that never answers: SOURCE_UNAVAILABLE at the timeout, not verified", isDisplay(late) && codes(late) === "LEVEL_DISPLAY,SOURCE_UNAVAILABLE");

console.log("the bases it refuses, and the root entry's refusal of it:");
const fake = (basis: unknown): DisplaySource => ({ basis: basis as DisplaySource["basis"], get: async () => ({ status: 200, body: {} }) });
const others = [
  ["nodeBlocks", { ...nodeBlocks({ node: "http://127.0.0.1:8789" }), get: async () => ({ status: 200, body: {} }) }],
  ["hostedBlocks", { ...hostedBlocks({ origin: ORIGIN, root: { kind: "caller", headers: callerHeaders({ answers: all, tip: TIP }).headers } }), get: async () => ({ status: 200, body: {} }) }],
  ["a feed", { ...fixtureSource(fx), get: async () => ({ status: 200, body: {} }) }],
  ["a pinned basis", fake({ kind: "pinned", pin: { height: 1, hash: `0x${"0".repeat(64)}` }, logSha256: `0x${"0".repeat(64)}`, above: { kind: "blocks", root: { kind: "own-node", node: "n" }, bodies: "b" } })],
  ["a display without an origin", fake({ kind: "display" })],
] as const;
const refused = await Promise.all(others.map(([, src]) => outcome(openDisplay({ source: src as unknown as DisplaySource }))));
ok(`./display's open refuses ${others.map(([n]) => n).join(", ")}: ReplicaConfigError`, refused.every((x) => x.e instanceof ReplicaConfigError));
const root = await outcome(open({ source: ourApi({ origin: "https://cairn.example", fetch: served(route) }) as never }));
ok("the root entry's open refuses ourApi(): ReplicaConfigError", root.e instanceof ReplicaConfigError);
ok("ourApi refuses an origin with credentials, a query or not http(s)", ["https://u:p@cairn.example", "https://cairn.example/?a=1", "ftp://cairn.example"]
  .every((origin) => { try { ourApi({ origin }); return false; } catch (e) { return e instanceof ReplicaConfigError; } }));

// The type admits no verified answer: this line fails the typecheck if DisplayAnswer ever does.
const typeAdmitsNone: [Extract<DisplayAnswer<NameValue>, { verified: true }>] extends [never] ? true : false = true;
ok("DisplayAnswer's type has no verified: true member", typeAdmitsNone);

done("cairnx-replica display");
