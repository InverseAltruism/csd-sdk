// Every walk the grammar allows over the six lists on the corpus: each order, each filter value (owners: none, the one
// with most names, one with one name, one with none; every status and kind of offers, alone and together; every
// ticker with balances, the tokens without any and an unknown ticker), limits 1, 2, 7, 100 and 200 (and 500 on
// events). A pinned walk (page 1 without `at`, then its `at` and `next`) must concatenate to the plain filter and sort
// of the state, no row twice or missing, `next` null exactly at the end, `total` the match count on every page. The
// sorts are oracles independent of the package's comparators: bytewise for names (the canonical text puts
// integer-like names first), the canonical state text's key order for bid and offer ids, tickers and holder
// addresses, then a stable sort on height alone for bids and offers and on the balance alone for holders; for events
// a stable sort on the position, then on the height.
import { canonicalState, type CairnXState } from "@inversealtruism/cairnx-core";
import { deepFreeze } from "../src/freeze.js";
import { answer, prepareView } from "../src/handlers/index.js";
import type { Page } from "../src/index.js";
import { done, ok, show } from "./check.js";
import { feedOrder, rows, state, tipHeight } from "./corpus.js";

const H = `0x${"ab".repeat(32)}`;
// The view's input holds each record map in reverse insertion order, so a list the handlers fail to sort is caught even
// where the replay's order happens to be sorted (tickers are).
// No corpus name is lapsed and none is pending at the tip, so every tenth name is marked pending and every thirteenth
// lapsed, here and in the oracle's rows alike.
const reversed = <V>(m: Record<string, V>) => Object.fromEntries(Object.entries(m).reverse());
const flagged = Object.fromEntries(Object.entries(state.names).map(([k, n], i) =>
  [k, { ...n, ...(i % 10 === 0 ? { pending: true as const } : {}), ...(i % 13 === 0 ? { expired: true as const } : {}) }]));
const input = {
  ...structuredClone(state), names: reversed(flagged), bids: reversed(state.bids), tokens: reversed(state.tokens), offers: reversed(state.offers),
  balances: reversed(Object.fromEntries(Object.entries(state.balances).map(([t, m]) => [t, reversed(m)]))),
};
const view = prepareView(deepFreeze(input), { height: tipHeight, hash: H, input: "corpus", core: "0.2.7" });
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
const canonical = JSON.parse(canonicalState(state as CairnXState)) as Record<"bids" | "tokens" | "offers", Record<string, unknown>> & { balances: Record<string, Record<string, unknown>> };
const textOrder = (m: Record<string, unknown>) => new Map(Object.keys(m).map((k, i) => [k, i]));
const bidText = textOrder(canonical.bids), tickerText = textOrder(canonical.tokens), offerText = textOrder(canonical.offers);

const byName = Object.values(flagged).sort((a, b) => bytes(a.name, b.name));
const byNewest = [...byName].sort((a, b) => b.height - a.height);          // stable: name order within a height
const byLength = [...byName].sort((a, b) => Buffer.byteLength(a.name, "ascii") - Buffer.byteLength(b.name, "ascii")); // stable: bytewise within a length
const bids = [...rows.bids].sort((a, b) => (bidText.get(a.id) ?? 0) - (bidText.get(b.id) ?? 0)).sort((a, b) => b.height - a.height);
const tokens = [...rows.tokens].sort((a, b) => (tickerText.get(a.ticker) ?? 0) - (tickerText.get(b.ticker) ?? 0));
const offers = [...rows.offers].sort((a, b) => (offerText.get(a.id) ?? 0) - (offerText.get(b.id) ?? 0)).sort((a, b) => b.height - a.height);
const events = feedOrder(state.events);
const balance = (r: { available: string; locked: string }) => BigInt(r.available) + BigInt(r.locked);
const holdersOf = (ticker: string) => {
  const text = textOrder(canonical.balances[ticker] ?? {});
  return Object.entries(state.balances[ticker] ?? {}).map(([address, bal]) => ({ address, ...bal }))
    .sort((a, b) => (text.get(a.address) ?? 0) - (text.get(b.address) ?? 0)).sort((a, b) => (balance(b) > balance(a) ? 1 : balance(b) < balance(a) ? -1 : 0));
};
const unheld = Object.keys(state.tokens).filter((t) => state.balances[t] === undefined);
const TICKERS = [...Object.keys(state.balances), ...unheld, "UNKNOWN9"];

const owners = new Map<string, number>();
for (const n of byName) owners.set(n.owner, (owners.get(n.owner) ?? 0) + 1);
const ranked = [...owners].sort((a, b) => b[1] - a[1]);
const OWNERS = [null, ranked[0]![0], ranked.find(([, c]) => c === 1)![0], `0x${"0".repeat(40)}`];
const STATUS = { held: (r: (typeof rows.names)[number]) => !r.pending && !r.expired, pending: (r: { pending?: true }) => r.pending === true, lapsed: (r: { expired?: true }) => r.expired === true };

type Walk = { route: string; query: string; want: readonly object[] };
const walks: Walk[] = [];
for (const [order, sortedRows] of [["name", byName], ["newest", byNewest], ["length", byLength]] as const) {
  for (const owner of OWNERS) {
    for (const status of [null, "held", "pending", "lapsed"] as const) {
      const q = [order === "name" ? "" : `order=${order}`, owner === null ? "" : `owner=${owner}`, status === null ? "" : `status=${status}`];
      walks.push({ route: "names", query: q.filter(Boolean).join("&"), want: sortedRows.filter((r) => (owner === null || r.owner === owner) && (status === null || STATUS[status](r))) });
    }
  }
}
for (const status of [null, "open", "cancelled", "expired", "done"]) walks.push({ route: "bids", query: status === null ? "" : `status=${status}`, want: bids.filter((r) => status === null || r.status === status) });
walks.push({ route: "tokens", query: "", want: tokens });
const KIND = { name: (r: (typeof offers)[number]) => "name" in r.give, token: (r: (typeof offers)[number]) => "ticker" in r.give };
for (const status of [null, "open", "filled", "cancelled", "expired"]) {
  for (const kind of [null, "name", "token"] as const) {
    const q = [status === null ? "" : `status=${status}`, kind === null ? "" : `kind=${kind}`].filter(Boolean).join("&");
    walks.push({ route: "offers", query: q, want: offers.filter((r) => (status === null || r.status === status) && (kind === null || KIND[kind](r))) });
  }
}
for (const t of TICKERS) walks.push({ route: "holders", query: `ticker=${t}`, want: holdersOf(t) });
walks.push({ route: "events", query: "", want: events });

let checked = 0, pagesRead = 0;
const bad: string[] = [];
for (const w of walks) {
  for (const limit of w.route === "events" ? [1, 2, 7, 100, 200, 500] : [1, 2, 7, 100, 200]) {
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
ok(`${checked} pinned walks (${walks.length} filter and order combinations x 5 limits, 6 on events, ${pagesRead} pages) equal the oracle's filter and sort, next null exactly at the end`,
  bad.length === 0, bad.slice(0, 3).join("\n       "));
ok("the combinations reach non-empty and empty results, and multi-page walks", walks.some((w) => w.want.length === 0) && walks.filter((w) => w.want.length > 7).length > 5);
ok("every name status filter has rows (held, pending, lapsed, and one both pending and lapsed)", (["held", "pending", "lapsed"] as const).every((st) => byName.some(STATUS[st]))
  && byName.some((r) => r.pending === true && r.expired === true));
const tieClasses = [...new Set(byName.map((r) => r.name.length))].filter((l) => {
  const group = byName.filter((r) => r.name.length === l).map((r) => r.name);
  return group.some((n) => /^[0-9]/.test(n)) && group.some((n) => /^[a-z]/.test(n)) && group.some((n) => n.includes("-"));
});
ok(`the length walks cross ties: lengths ${tieClasses.join(", ")} each hold names opening with a digit and a letter and one with a hyphen`, tieClasses.length > 0);
const keysOf = (list: readonly object[], k: string) => list.map((r) => (r as Record<string, unknown>)[k]);
const pairs: [readonly object[], readonly string[], string][] = [[byName, Object.keys(input.names), "name"], [byNewest, Object.keys(input.names), "name"], [byLength, Object.keys(input.names), "name"],
  [bids, Object.keys(input.bids), "id"], [tokens, Object.keys(input.tokens), "ticker"], [offers, Object.keys(input.offers), "id"],
  [holdersOf("CAIRN"), Object.keys(input.balances.CAIRN ?? {}), "address"], [events, input.events.map((e) => e.id), "txid"]];
ok("each oracle order differs from the order of the view's input", pairs.every(([a, inputKeys, k]) => show(keysOf(a, k)) !== show(inputKeys)));
const tied = TICKERS.filter((t) => new Set(holdersOf(t).map((r) => String(balance(r)))).size < holdersOf(t).length);
ok(`the offer walks reach both kinds (${offers.filter(KIND.name).length} name offers); the holder walks ${TICKERS.length} tickers (${unheld.length} tokens without balances, one unknown; equal balances under ${tied.join(", ")})`,
  unheld.length > 0 && offers.some(KIND.name) && offers.some(KIND.token) && TICKERS.some((t) => holdersOf(t).length > 7) && tied.length > 0);

done("cairnx-api walk");
