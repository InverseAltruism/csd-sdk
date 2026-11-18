// Never run: test/package.test.ts compiles it under node16 as a CommonJS consumer, which resolves the package's
// `require` condition (dist/index.d.cts).
import { CAIRNX_API_VERSION, parseQuery, type Page, type TokenRow } from "@inversealtruism/cairnx-api";

const r = parseQuery("tokens", "limit=2");
const limit: number | null = r.ok ? r.query.limit : null;
const page: Page<TokenRow> = { ok: true, level: 1, at: { height: 1, hash: "0x", rev: "0" }, rows: [], next: null };
// @ts-expect-error level is 1 on every answer
const claimed: Page<TokenRow> = { ...page, level: 3 };
void [CAIRNX_API_VERSION, limit, page, claimed];
