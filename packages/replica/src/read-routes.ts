// A replica's own server answering the CairnX resolver's five state reads (handlers.ts) from Reader.snapshot(): the
// resolver's statuses, bodies and headers for the same state, the server's verdict in two headers, and a 503 while
// the replica's state is not one to serve. The withhold rule lives here and not in the handlers: the hosted resolver
// imports the handlers and answers as it does today. A 404 comes only from a handler's "not registered".
import { FINAL_DEPTH, NAME_RE, canonicalState, type ChainEvent } from "@inversealtruism/cairnx-core";
import type { Answer, Snapshot } from "./answer.js";
import type { NotVerifiedCode } from "./codes.js";
import { readName, readNameHistory, readProfile, readResolve, readState, type ReadAnswer, type ReadSnapshot } from "./handlers.js";
import { appliedIds, nameHistory, type NameHistory } from "./namehist.js";
import type { Reader } from "./reader.js";

/** The codes on which the server answers 503: the state is not complete, not this chain's or not the store's to
 *  serve. BEHIND withholds too once the view is FINAL_DEPTH or more below the tip (a catch-up); under that it is served,
 *  as the resolver serves between two polls. Every other code is served and named in `x-cairnx-why`. */
export const WITHHELD: readonly NotVerifiedCode[] = Object.freeze([
  "NOT_SYNCED", "STORE_UNCONFIRMED", "PIN_DISPUTED", "PIN_MISMATCH", "PIN_OFF_CHAIN", "RULES_DIFFER", "BRANCH_UNRESOLVED",
] as const);

/** The resolver's JSON headers, and the two of the server's verdict exposed to a page on another origin. */
export const READ_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*", "x-content-type-options": "nosniff",
  "access-control-expose-headers": "x-cairnx-at, x-cairnx-why",
});

/** One answer: its status, its headers (READ_HEADERS, `x-cairnx-at` `<height>:<hash>` of the view when there is one,
 *  `x-cairnx-why` the codes of the replica's verdict, comma-separated, empty when verified) and its body. */
export interface ReadResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: string }

const bodyOf = (re: RegExp) => re.source.replace(/^\^/, "").replace(/\$$/, "");
const NAME = bodyOf(NAME_RE);
const ROUTES: readonly (readonly [RegExp, (s: ReadSnapshot, arg: string) => ReadAnswer])[] = [
  [new RegExp(`^/cairnx/name/(${NAME})$`), readName],
  [new RegExp(`^/cairnx/resolve/(${NAME})$`), readResolve],
  [new RegExp(`^/cairnx/name-history/(${NAME})$`), readNameHistory],
  [new RegExp(`^/cairnx/profile/(${NAME})$`), readProfile],
];
// The histories kept per snapshot: each is two replays of the name's records (namehist.ts).
const HISTORIES = 1024;

/** Why `a` is withheld: its codes in WITHHELD, and BEHIND once its view is FINAL_DEPTH or more below the tip. */
export function withheldBy(a: Answer<Snapshot>): NotVerifiedCode[] {
  const v = a.verified ? a.value : a.shown, codes = a.why.map((w) => w.code);
  const far = a.at !== null && v !== null && a.at.tipHeight - v.height >= FINAL_DEPTH;
  return codes.filter((c) => WITHHELD.includes(c) || (c === "BEHIND" && far));
}

/** The answer for `path` (a URL's pathname: `/cairnx/state`, or `/cairnx/{name,resolve,name-history,profile}/<name>`
 *  with the name as NAME_RE writes it), or null for any other path. Each call reads `reader.snapshot()` with
 *  `waitMs`; the derivations of a snapshot (the canonical state, the applied ids, each name's history) are kept while
 *  its key holds. */
export function replicaReads(reader: Pick<Reader, "snapshot">, o: { readonly waitMs?: number } = {}): (path: string) => Promise<ReadResponse | null> {
  let memo: { key: string; snap: ReadSnapshot } | null = null;
  const snapshotOf = (v: Snapshot): ReadSnapshot => {
    if (memo?.key === v.key) return memo.snap;
    let canonical: string | null = null, applied: Set<string> | null = null;
    const histories = new Map<string, NameHistory>();
    // The resolver's own derivations: canonicalState, and nameHistory with the published state's record and applied ids.
    const snap: ReadSnapshot = {
      state: v.state,
      canonical: (s) => (canonical ??= canonicalState(s)),
      history: (s, name) => {
        const kept = histories.get(name);
        if (kept !== undefined) return kept;
        if (histories.size >= HISTORIES) histories.clear();
        // nameHistory reads its events and changes none of them; the snapshot's are frozen, so a change would throw.
        const h = nameHistory(v.events as ChainEvent[], name, { tipHeight: s.tipHeight, fullRecord: s.names[name], fullApplied: (applied ??= appliedIds(s.events)) });
        histories.set(name, h);
        return h;
      },
    };
    memo = { key: v.key, snap };
    return snap;
  };
  return async (path) => {
    let handler: ((s: ReadSnapshot) => ReadAnswer) | null = path === "/cairnx/state" ? readState : null;
    for (const [re, f] of ROUTES) {
      const m = re.exec(path);
      if (handler === null && m !== null) handler = (s) => f(s, m[1]!);
    }
    if (handler === null) return null;
    const a = await reader.snapshot({ waitMs: o.waitMs ?? 0 }), v = a.verified ? a.value : a.shown;
    const headers = { ...READ_HEADERS, ...(a.at === null ? {} : { "x-cairnx-at": `${a.at.height}:${a.at.hash ?? ""}` }), "x-cairnx-why": a.why.map((w) => w.code).join(",") };
    const why = withheldBy(a);
    if (v === null || why.length > 0) {
      return { status: 503, headers, body: JSON.stringify({ ok: false, error: `not ready: ${(why.length > 0 ? why : a.why.map((w) => w.code)).join(", ")}; retry shortly` }) };
    }
    const r = handler(snapshotOf(v));
    return { status: r.status, headers, body: r.body };
  };
}
