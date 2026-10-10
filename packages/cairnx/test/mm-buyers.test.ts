// priorBuyers: the one "returning buyer" rule the maker and the site share.
import assert from "node:assert/strict";
import type { OfferState } from "../src/types.js";
import { priorBuyers } from "../src/mm/index.js";

let pass = 0;
const t = (name: string, fn: () => void) => {
  const r = fn() as unknown;
  if (r !== undefined) throw new Error(`test "${name}" returned a value - use assert`);
  pass++; console.log("  ok", name);
};

const MAKER = "0x" + "aa".repeat(20);
const OTHER = "0x" + "bb".repeat(20);
const buyer = (n: number) => "0x" + n.toString(16).padStart(40, "0");
let id = 0;
const fillOf = (b: string) => ({ buyer: b, txid: "0x" + (++id).toString(16).padStart(64, "0"), height: 100, paid: "1000", fee: "15" });
const offer = (seller: string, fills: { fill?: string; fills?: string[] }): OfferState => ({
  id: "0x" + (++id).toString(16).padStart(64, "0"), seller, give: { ticker: "CAIRN", amount: "1" },
  want: { value: "1000", payto: seller }, status: "filled", expiresEpoch: 10, height: 1, feeBps: 150,
  ...(fills.fill ? { fill: fillOf(fills.fill) } : {}),
  ...(fills.fills ? { fills: fills.fills.map(fillOf) } : {}),
} as unknown as OfferState);

t("a buyer of the maker's own offer is returning, whole or partial fill, case-insensitive", () => {
  const book = [offer(MAKER.toUpperCase().replace("0X", "0x"), { fill: buyer(1).toUpperCase().replace("0X", "0x") }), offer(MAKER, { fills: [buyer(2), buyer(3)] })];
  const p = priorBuyers(book, MAKER);
  assert.deepEqual([...p].sort(), [buyer(1), buyer(2), buyer(3)]);
});

t("red-first: a fill of another seller's offer does not make a returning buyer", () => {
  const p = priorBuyers([offer(OTHER, { fill: buyer(4) }), offer(MAKER, { fill: buyer(5) })], MAKER);
  assert.equal(p.has(buyer(4)), false, "a third-party fill must not count");
  assert.equal(p.has(buyer(5)), true, "paired: the maker's own fill counts");
});

t("record and array books give the same set; no maker or no book gives an empty set", () => {
  const list = [offer(MAKER, { fill: buyer(6) }), offer(OTHER, { fill: buyer(7) })];
  const record = Object.fromEntries(list.map((o) => [o.id, o]));
  assert.deepEqual([...priorBuyers(record, MAKER)], [...priorBuyers(list, MAKER)]);
  assert.equal(priorBuyers(list, "").size, 0);
  assert.equal(priorBuyers(null, MAKER).size, 0);
});

console.log(`mm-buyers: ${pass} passed`);
