// Every walk the grammar allows over names, bids and tokens on the corpus: each order, each filter value (owners: none,
// the one with most names, one with one name, one with none), limits 1, 2, 7, 100 and 200. A pinned walk (page 1
// without `at`, then its `at` and `next`) must concatenate to the plain filter and sort of the state, no row twice or
// missing, `next` null exactly at the end, `total` the match count on every page. The sorts are oracles independent
// of the package's comparators: bytewise for names (the canonical text puts integer-like names first), the canonical
// state text's key order for bid ids and tickers, a stable sort on height alone for bids.
import { canonicalState, type CairnXState } from "@inversealtruism/cairnx-core";
import { deepFreeze } from "../src/freeze.js";
import { answer, prepareView } from "../src/handlers/index.js";
import type { Page } from "../src/index.js";
import { done, ok, show } from "./check.js";
import { rows, state, tipHeight } from "./corpus.js";

const H = `0x${"ab".repeat(32)}`;
// The view's input holds each record map in reverse insertion order, so a list the handlers fail to sort is caught even
// where the replay's order happens to be sorted (tickers are).
// No corpus name is lapsed and none is pending at the tip, so every tenth name is marked pending and every thirteenth
// lapsed, here and in the oracle's rows alike.
const reversed = <V>(m: Record<string, V>) => Object.fromEntries(Object.entries(m).reverse());
const flagged = Object.fromEntries(Object.entries(state.names).map(([k, n], i) =>
  [k, { ...n, ...(i % 10 === 0 ? { pending: true as const } : {}), ...(i % 13 === 0 ? { expired: true as const } : {}) }]));
const input = { ...structuredClone(state), names: reversed(flagged), bids: reversed(state.bids), tokens: reversed(state.tokens) };
const view = prepareView(deepFreeze(input), { height: tipHeight, hash: H, input: "corpus", core: "0.2.7" });
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
const canonical = JSON.parse(canonicalState(state as CairnXState)) as Record<"bids" | "tokens", Record<string, unknown>>;
const textOrder = (list: "bids" | "tokens") => new Map(Object.keys(canonical[list]).map((k, i) => [k, i]));
const bidText = textOrder("bids"), tickerText = textOrder("tokens");

const byName = Object.values(flagged).sort((a, b) => bytes(a.name, b.name));
const byNewest = [...byName].sort((a, b) => b.height - a.height);          // stable: name order within a height
const bids = [...rows.bids].sort((a, b) => (bidText.get(a.id) ?? 0) - (bidText.get(b.id) ?? 0)).sort((a, b) => b.height - a.height);
const tokens = [...rows.tokens].sort((a, b) => (tickerText.get(a.ticker) ?? 0) - (tickerText.get(b.ticker) ?? 0));

const owners = new Map<string, number>();
for (const n of byName) owners.set(n.owner, (owners.get(n.owner) ?? 0) + 1);
const ranked = [...owners].sort((a, b) => b[1] - a[1]);
const OWNERS = [null, ranked[0]![0], ranked.find(([, c]) => c === 1)![0], `0x${"0".repeat(40)}`];
const STATUS = { held: (r: (typeof rows.names)[number]) => !r.pending && !r.expired, pending: (r: { pending?: true }) => r.pending === true, lapsed: (r: { expired?: true }) => r.expired === true };

type Walk = { route: string; query: string; want: readonly object[] };
const walks: Walk[] = [];
for (const [order, sortedRows] of [["name", byName], ["newest", byNewest]] as const) {
  for (const owner of OWNERS) {
    for (const status of [null, "held", "pending", "lapsed"] as const) {
      const q = [order === "name" ? "" : "order=newest", owner === null ? "" : `owner=${owner}`, status === null ? "" : `status=${status}`];
      walks.push({ route: "names", query: q.filter(Boolean).join("&"), want: sortedRows.filter((r) => (owner === null || r.owner === owner) && (status === null || STATUS[status](r))) });
    }
  }
}
for (const status of [null, "open", "cancelled", "expired", "done"]) walks.push({ route: "bids", query: status === null ? "" : `status=${status}`, want: bids.filter((r) => status === null || r.status === status) });
walks.push({ route: "tokens", query: "", want: tokens });

let checked = 0, pagesRead = 0;
const bad: string[] = [];
for (const w of walks) {
  for (const limit of [1, 2, 7, 100, 200]) {
    const got: object[] = [];
    let at = "", next: string | null = null, pages = 0;
    do {
      const q = [w.query, `limit=${limit}`, at, next === null ? "" : `after=${encodeURIComponent(next)}`].filter(Boolean).join("&");
      const a = answer([view], w.route, q);
      const body = a.body as Page<object>;
      if (a.status !== 200 || !body.ok) { bad.push(`${w.route}?${q}: ${show(a.body)}`); break; }
      if (body.total !== w.want.length || (body.rows.length === 0 && pages > 0)) bad.push(`${w.route}?${q}: total ${body.total} rows ${body.rows.length}`);
      at = `at=${body.at.height}:${body.at.hash}:${body.at.rev}`;
      got.push(...body.rows);
      next = body.next;
      pages++;
    } while (next !== null && pages <= w.want.length + 1);
    pagesRead += pages;
    const want = Math.max(1, Math.ceil(w.want.length / limit));
    if (show(got) !== show(w.want) || pages !== want) bad.push(`${w.route}?${w.query} limit ${limit}: ${got.length} rows in ${pages} pages, want ${w.want.length} in ${want}`);
    checked++;
  }
}
ok(`${checked} pinned walks (${walks.length} filter and order combinations x 5 limits, ${pagesRead} pages) equal the oracle's filter and sort, next null exactly at the end`,
  bad.length === 0, bad.slice(0, 3).join("\n       "));
ok("the combinations reach non-empty and empty results, and multi-page walks", walks.some((w) => w.want.length === 0) && walks.filter((w) => w.want.length > 7).length > 5);
ok("every name status filter has rows (held, pending, lapsed, and one both pending and lapsed)", (["held", "pending", "lapsed"] as const).every((st) => byName.some(STATUS[st]))
  && byName.some((r) => r.pending === true && r.expired === true));
const keysOf = (list: readonly object[], k: string) => list.map((r) => (r as Record<string, unknown>)[k]);
ok("each oracle order differs from the order of the view's input",
  [[byName, input.names, "name"], [byNewest, input.names, "name"], [bids, input.bids, "id"], [tokens, input.tokens, "ticker"]]
    .every(([a, m, k]) => show(keysOf(a as object[], k as string)) !== show(Object.keys(m as object))));

done("cairnx-api walk");
