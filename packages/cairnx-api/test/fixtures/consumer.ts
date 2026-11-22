// Never run: test/package.test.ts compiles it as an outside consumer would, importing the package by its name (through
// its exports to dist/), under node16 and bundler resolution; `pnpm typecheck` includes it too. Each @ts-expect-error
// line must be an error.
import type { CairnXState } from "@inversealtruism/cairnx-core";
import { answer, prepareView, type Answered, type View } from "@inversealtruism/cairnx-api/handlers";
import { CURSORS, ERRORS, parseQuery, type Answer, type BidRow, type EventRow, type HolderKey, type NameRow, type OfferRow, type Query, type Refusal, type TokenRow } from "@inversealtruism/cairnx-api";

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
const refusal: Answer<NameRow> = { ok: false, error: { code: "SOME_LATER_CODE", message: "a code from a newer server" } };
const later: OfferRow["status"] = "a-status-added-at-a-later-gate";
void later;
// The other open sets: a value a newer server may send type-checks; and a 429 carries retryAfter.
const laterBid: BidRow["status"] = "a-bid-status-added-later", laterMint: TokenRow["mint"] = "a-mint-mode-added-later";
const laterCode: EventRow["code"] = "A_CODE_ADDED_LATER", laterKind: EventRow["kind"] = "a-record-type-added-later";
const limited: Refusal = { ok: false, error: { code: "RATE_LIMITED", message: "rate limit exceeded", retryAfter: 60 } };
const wait: number | undefined = limited.error.retryAfter;
void [laterBid, laterMint, laterCode, laterKind, wait];
// @ts-expect-error an offer row has no fills
const fills: OfferRow["fills"] = [];
void [status, key, refusal, fills];
const held: View[] = [prepareView(null as unknown as CairnXState, { height: 1, hash: "0x", input: "fp", core: "0.2.7" })];
const answered: Answered = answer(held, "names", new URLSearchParams("limit=2"));
const okStatus: number = answered.status;
// @ts-expect-error a query is a string or URLSearchParams, never a parsed record
answer(held, "names", { limit: "2" });
void okStatus;
