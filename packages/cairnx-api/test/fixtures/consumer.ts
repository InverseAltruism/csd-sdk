// Never run: test/package.test.ts compiles it as an outside consumer would, importing the package by its name (through
// its exports to dist/), under node16 and bundler resolution; `pnpm typecheck` includes it too. Each @ts-expect-error
// line must be an error.
import { CURSORS, ERRORS, parseQuery, type Answer, type HolderKey, type NameRow, type OfferRow, type Query } from "@inversealtruism/cairnx-api";

const r = parseQuery("names", "order=newest&after=1:a");
if (r.ok) {
  const q: Query<"names"> = r.query;
  if (q.order === "newest" && q.after !== null) { const h: number = q.after.height; void h; }
  if (q.order === "name" && q.after !== null) { const n: string = q.after.name; void n; }
  const s: "held" | "pending" | "lapsed" | null = q.filters.status;
  void s;
  // @ts-expect-error names take no ticker
  void q.filters.ticker;
} else {
  const param: string = r.error.param;
  void param;
}
const h = parseQuery("holders", "ticker=CAIRN");
if (h.ok) {
  const ticker: string = h.query.filters.ticker;
  const amount: bigint | undefined = h.query.after?.amount;
  void [ticker, amount];
}
// @ts-expect-error not a route
parseQuery("tuple", "");

const status: 400 = ERRORS.INVALID_QUERY.status;
const key: HolderKey = CURSORS.holder.of({ address: "0x", available: "1", locked: "2" });
const answer: Answer<NameRow> = { ok: false, error: { code: "SOME_LATER_CODE", message: "a code from a newer server" } };
const later: OfferRow["status"] = "a-status-added-at-a-later-gate";
void later;
// @ts-expect-error an offer row has no fills
const fills: OfferRow["fills"] = [];
void [status, key, answer, fills];
