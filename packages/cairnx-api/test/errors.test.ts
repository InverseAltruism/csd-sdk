// The error table: each code with its one status, as section 3 of the design lists them, and no code inside a family
// of cairnx-core's reason codes (CONVENTION section 40.1), read both from the spec's text and from the code table.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { REASON_CODES } from "@inversealtruism/cairnx-core";
import { ERRORS, ERROR_CODES, statusOf } from "../src/index.js";
import { done, ok, show } from "./check.js";

const DESIGN: Record<string, number> = {
  INVALID_QUERY: 400, INVALID_PATH: 400, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, SNAPSHOT_NOT_HELD: 409,
  RATE_LIMITED: 429, INTERNAL: 500, UPSTREAM_UNAVAILABLE: 502, RESPONSE_TOO_LARGE: 502, NOT_READY: 503,
};
const statuses = Object.fromEntries(ERROR_CODES.map((c) => [c, statusOf(c)]));
ok("the codes and statuses are the design's table", isDeepStrictEqual(statuses, DESIGN), show(statuses));
ok("ERROR_CODES lists every code of ERRORS once", isDeepStrictEqual([...ERROR_CODES], Object.keys(ERRORS)) && new Set(ERROR_CODES).size === ERROR_CODES.length);
ok("every status is an integer 4xx or 5xx", ERROR_CODES.every((c) => Number.isInteger(statusOf(c)) && statusOf(c) >= 400 && statusOf(c) < 600));
ok("each code names the side that answers it", ERROR_CODES.every((c) => ["service", "proxy", "both"].includes(ERRORS[c].from)));
ok("the table and its entries are frozen", Object.isFrozen(ERRORS) && Object.isFrozen(ERROR_CODES) && ERROR_CODES.every((c) => Object.isFrozen(ERRORS[c])));

const core = join(dirname(createRequire(import.meta.url).resolve("@inversealtruism/cairnx-core")), "..");
const spec = /family prefix: ([A-Z, ]+?),? or ([A-Z]+)\./.exec(readFileSync(join(core, "CONVENTION.md"), "utf8").replace(/\s+/g, " "));
const specFamilies = spec ? [...spec[1]!.split(", "), spec[2]!] : [];
const codeFamilies = [...new Set(REASON_CODES.map((c) => c.split("_")[0]!))];
ok(`CONVENTION 40.1 names ${specFamilies.length} families and the core's codes use only those`,
  specFamilies.length >= 12 && codeFamilies.every((f) => specFamilies.includes(f)), `${show(specFamilies)} ${show(codeFamilies)}`);
const families = new Set([...specFamilies, ...codeFamilies]);
for (const c of ERROR_CODES) {
  ok(`${c} (${statusOf(c)}) is no reason code and its prefix ${c.split("_")[0]} is no family`, !(REASON_CODES as readonly string[]).includes(c) && !families.has(c.split("_")[0]!));
}
ok("every code is upper snake case of at most 40 characters", ERROR_CODES.every((c) => /^[A-Z]+(?:_[A-Z]+)*$/.test(c) && c.length <= 40));

done("cairnx-api errors");
