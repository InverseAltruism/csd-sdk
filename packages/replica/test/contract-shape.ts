// The shape rules of cairn's wallet contract (its fixture's shapeSyntax, in test/fixtures/wallet-contract-subset.json),
// as cairn's own test/wallet-contract.test.mjs reads them: `a.b` a member, `a[]` every element, `a.*` every value of a
// map, `?` tolerated absent, types integer, number, string, boolean, object, array, null, hex20, hex32, digits joined by
// |, `=<json>` a value, `one-of:a,b` one of those strings.
import { isDeepStrictEqual } from "node:util";

const HEX = (n: number) => new RegExp(`^0x[0-9a-fA-F]{${n}}$`);
const TYPES: Record<string, (v: unknown) => boolean> = {
  integer: (v) => Number.isInteger(v), number: (v) => typeof v === "number" && Number.isFinite(v), string: (v) => typeof v === "string",
  boolean: (v) => typeof v === "boolean", object: (v) => v !== null && typeof v === "object" && !Array.isArray(v), array: Array.isArray,
  null: (v) => v === null, hex20: (v) => typeof v === "string" && HEX(40).test(v), hex32: (v) => typeof v === "string" && HEX(64).test(v),
  digits: (v) => typeof v === "string" && /^\d+$/.test(v),
};
function typeOk(spec: string, v: unknown): boolean {
  if (spec.startsWith("=")) return isDeepStrictEqual(v, JSON.parse(spec.slice(1)));
  if (spec.startsWith("one-of:")) return spec.slice(7).split(",").includes(v as string);
  return spec.split("|").every((t) => TYPES[t]) && spec.split("|").some((t) => TYPES[t]!(v));
}
type Seg = { key: string; opt: boolean; each: boolean };
function segments(path: string): Seg[] {
  if (path === "") return [];
  return path.split(".").map((s) => {
    const m = /^([^?[\]]*)(\?)?(\[\])?$/.exec(s);
    if (!m) throw new Error(`bad shape key segment ${s} in ${path}`);
    return { key: m[1]!, opt: m[2] === "?", each: m[3] === "[]" };
  });
}
type Hit = { at: string; v?: unknown; missing?: true; notArray?: true };
export function walk(body: unknown, path: string): Hit[] {
  let cur: Hit[] = [{ at: "", v: body }];
  const out: Hit[] = [];
  for (const seg of segments(path)) {
    const next: Hit[] = [];
    for (const { at, v } of cur) {
      const owner = v !== null && typeof v === "object" && !Array.isArray(v), o = v as Record<string, unknown>;
      const kids: [string, unknown][] = seg.key === "*" ? (owner ? Object.entries(o).map(([k, x]) => [`${at}.${k}`, x]) : [])
        : seg.key === "" ? [[at, v]] : owner && Object.hasOwn(o, seg.key) ? [[`${at}.${seg.key}`, o[seg.key]]] : [];
      if (!kids.length && seg.key !== "*") { if (!seg.opt) out.push({ at: `${at}.${seg.key}`, missing: true }); continue; }
      for (const [k, x] of kids) {
        if (!seg.each) { next.push({ at: k, v: x }); continue; }
        if (!Array.isArray(x)) { out.push({ at: k, notArray: true }); continue; }
        x.forEach((el, i) => next.push({ at: `${k}[${i}]`, v: el }));
      }
    }
    cur = next;
  }
  return [...out, ...cur];
}
/** Every way `body` departs from `shape`. */
export function shapeErrors(body: unknown, shape: Record<string, string>): string[] {
  const errs: string[] = [];
  for (const [path, spec] of Object.entries(shape)) {
    const got = walk(body, path), vals = got.filter((g) => !g.missing && !g.notArray);
    for (const g of got) if (g.missing) errs.push(`${g.at || "body"} missing`); else if (g.notArray) errs.push(`${g.at} not an array`);
    for (const g of vals) if (!typeOk(spec, g.v)) errs.push(`${g.at || "body"} is ${JSON.stringify(g.v)?.slice(0, 60)}, wanted ${spec}`);
    if (!segments(path).some((s) => s.opt) && !vals.length && !got.some((g) => g.missing || g.notArray)) errs.push(`${path || "body"} matched no value`);
  }
  return errs;
}
