// The order of every string key is bytewise whatever the runtime's locale: the same walks, run in a child process under
// LC_ALL set to a locale whose collation differs from byte order on the key alphabets (Danish "aa" after "z",
// Lithuanian "y" between "i" and "j", Czech "ch" after "h"), return the rows a bytewise oracle orders. The corpus alone
// does not show it: its names and tickers hold none of the Danish or Lithuanian pairs at a tie, so keys that do are
// added to its state at the tip height, where the names tie under `newest`, the offers and bids under their anchor
// order, and the names of one length under `length`. A child that does not collate as its locale does fails the run, so
// the check cannot pass on a runtime that ignores LC_ALL.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { CairnXState } from "@inversealtruism/cairnx-core";
import { deepFreeze } from "../src/freeze.js";
import { answer, prepareView } from "../src/handlers/index.js";
import type { Page } from "../src/index.js";
import { done, ok, show } from "./check.js";
import { state, tipHeight } from "./corpus.js";

const NAMES = ["aa", "ab", "az", "zz", "aab", "i", "j", "y", "iy", "ch", "ci", "h", "hz", "cha", "chz", "hza"];
const TICKERS = ["AAB", "ABA", "AZZ", "CHA", "CIA", "HAA", "IAA", "JAA", "YAA"];
const HEX = ["aa", "ab", "a9", "b0"];
const id = (h: string, width: number) => `0x${h}${"0".repeat(width - h.length)}`;

/** The corpus state with the keys above added at the tip height: names, tokens, the balances of AAB, offers, bids. */
function crafted(): CairnXState {
  const s = structuredClone(state);
  const name = Object.values(s.names)[0]!, token = Object.values(s.tokens)[0]!, offer = Object.values(s.offers)[0]!, bid = Object.values(s.bids)[0]!;
  for (const n of NAMES) s.names[n] = { ...name, name: n, height: tipHeight };
  for (const t of TICKERS) s.tokens[t] = { ...token, ticker: t };
  s.balances.AAB = Object.fromEntries(HEX.map((h) => [id(h, 40), { available: "5", locked: "0" }]));
  for (const h of HEX) s.offers[id(h, 64)] = { ...offer, id: id(h, 64), height: tipHeight };
  for (const h of HEX) s.bids[id(h, 64)] = { ...bid, id: id(h, 64), height: tipHeight, offers: [] };
  return s;
}

const WALKS = {
  names: ["names", "", "name"], newest: ["names", "order=newest", "name"], length: ["names", "order=length", "name"],
  tokens: ["tokens", "", "ticker"], holders: ["holders", "ticker=AAB", "address"], offers: ["offers", "", "id"], bids: ["bids", "", "id"],
} as const;
type Walk = keyof typeof WALKS;

/** Each walk's row keys, pinned and two rows a page, so every page after the first seeks by a cursor. */
function walks(): Record<Walk, string[]> {
  const view = prepareView(deepFreeze(crafted()), { height: tipHeight, hash: `0x${"ab".repeat(32)}`, input: "locale", core: "0.2.10" });
  const out = {} as Record<Walk, string[]>;
  for (const [walk, [route, query, key]] of Object.entries(WALKS) as [Walk, (typeof WALKS)[Walk]][]) {
    const keys: string[] = [];
    let at = "", next: string | null = null, pages = 0;
    do {
      const body = answer([view], route, [query, "limit=2", at, next === null ? "" : `after=${encodeURIComponent(next)}`].filter(Boolean).join("&")).body as Page<Record<string, unknown>>;
      if (!body.ok) { keys.push(`refused: ${show(body)}`); break; }
      at = `at=${body.at.height}:${body.at.hash}:${body.at.rev}`;
      keys.push(...body.rows.map((r) => String(r[key])));
      next = body.next;
    } while (next !== null && ++pages < 1000);
    out[walk] = keys;
  }
  return out;
}

const CONTROL = ["aa", "ch", "ci", "h", "i", "j", "y", "z"];
if (process.argv.includes("--child")) {
  const collated = [...CONTROL].sort((a, b) => a.localeCompare(b));
  process.stdout.write(JSON.stringify({ locale: new Intl.Collator().resolvedOptions().locale, collated, walks: walks() }));
  process.exit(0);
}

// The oracle, independent of the package's comparators: Buffer.compare on the ASCII bytes, after the order's number.
const bytes = (a: string, b: string) => Buffer.compare(Buffer.from(a, "ascii"), Buffer.from(b, "ascii"));
const s = crafted();
const byName = Object.values(s.names).sort((a, b) => bytes(a.name, b.name));
const anchor = (m: Record<string, { id: string; height: number }>) => Object.values(m).sort((a, b) => b.height - a.height || bytes(a.id, b.id)).map((r) => r.id);
const total = (b: { available: string; locked: string }) => BigInt(b.available) + BigInt(b.locked);
const ORACLE: Record<Walk, string[]> = {
  names: byName.map((r) => r.name),
  newest: [...byName].sort((a, b) => b.height - a.height).map((r) => r.name),
  length: [...byName].sort((a, b) => a.name.length - b.name.length).map((r) => r.name),
  tokens: Object.keys(s.tokens).sort(bytes),
  holders: Object.entries(s.balances.AAB!).sort(([a, x], [b, y]) => (total(y) > total(x) ? 1 : total(y) < total(x) ? -1 : bytes(a, b))).map(([a]) => a),
  offers: anchor(s.offers),
  bids: anchor(s.bids),
};
ok(`the added keys are new to the corpus state (${NAMES.length} names, ${TICKERS.length} tickers, ${HEX.length} offers and bids)`,
  NAMES.every((n) => state.names[n] === undefined) && TICKERS.every((t) => state.tokens[t] === undefined && state.balances[t] === undefined)
  && HEX.every((h) => state.offers[id(h, 64)] === undefined && state.bids[id(h, 64)] === undefined));

const here = walks();
for (const walk of Object.keys(WALKS) as Walk[]) {
  ok(`this process: the ${walk} walk (${here[walk].length} rows) is in bytewise order`, show(here[walk]) === show(ORACLE[walk]), show(here[walk].slice(0, 8)));
}

// What each locale's collation does to the control words, unlike byte order: the proof that LC_ALL reached the child.
const LOCALES: [string, string, (c: string[]) => boolean][] = [
  ["da_DK.UTF-8", "aa after z", (c) => c.indexOf("aa") > c.indexOf("z")],
  ["lt_LT.UTF-8", "y before j", (c) => c.indexOf("y") < c.indexOf("j")],
  ["cs_CZ.UTF-8", "ch after h", (c) => c.indexOf("ch") > c.indexOf("h")],
];
const self = fileURLToPath(import.meta.url);
for (const [locale, what, collates] of LOCALES) {
  const r = spawnSync(process.execPath, [...process.execArgv, self, "--child"], { encoding: "utf8", env: { ...process.env, LC_ALL: locale } });
  const got = r.status === 0 ? (JSON.parse(r.stdout) as { locale: string; collated: string[]; walks: Record<Walk, string[]> }) : null;
  ok(`LC_ALL=${locale}: the child collates as its locale (${what}; ${got?.locale ?? "no answer"})`, got !== null && collates(got.collated), got === null ? r.stderr.slice(0, 300) : show(got.collated));
  for (const walk of Object.keys(WALKS) as Walk[]) {
    ok(`LC_ALL=${locale}: the ${walk} walk is in bytewise order`, got !== null && show(got.walks[walk]) === show(ORACLE[walk]), show(got?.walks[walk].slice(0, 8)));
  }
}

done("cairnx-api locale");
