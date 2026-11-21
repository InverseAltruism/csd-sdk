// @inversealtruism/cairnx-replica/display: a page that shows a name or a balance from our API at level 1 (design section
// 5), one request per read. What it shows is the server's word at the server's tip: no record is checked and no depth
// counted. Every answer is `verified: false` by its type and by construction, whatever is served or passed, and states
// level 1 with the code of the verified rule's level condition. The values are the ones a replica reads (views.ts)
// over what was served, so a name is cairnx-core's nameView. This entry does not load resolve() or the block machinery.
import { HASH_RE, NAME_RE, TICKER_RE, nameView, type NameState } from "@inversealtruism/cairnx-core";
import type { AnswerMeta, BalanceValue, NameValue } from "./answer.js";
import { checkBasis, levelOf, proofOf } from "./basis.js";
import type { NotVerifiedCode } from "./codes.js";
import { ReplicaConfigError, messageOf } from "./errors.js";
import { cappedJson, either } from "./http.js";
import { serverBase } from "./node-address.js";
import { levelCode } from "./verdict.js";
import { addressOf, balanceOf } from "./views.js";

export type { BalanceValue, NameValue };
/** A display answer: level 1, never verified, the served value in `shown`. */
export type DisplayAnswer<T> = AnswerMeta & { readonly level: 1; readonly verified: false; readonly value: null; readonly shown: T | null };
/** A display read takes only a signal: the server answers at its own tip, so there is no depth to choose. */
export interface DisplayReadOptions { readonly signal?: AbortSignal }
/** Our API at `origin`. `get` is internal: one GET below `/trade/api/cairnx/`, its status and JSON body. */
export interface DisplaySource {
  readonly basis: { readonly kind: "display"; readonly origin: string };
  get(path: string, signal?: AbortSignal): Promise<{ readonly status: number; readonly body: unknown }>;
}
export interface DisplayReader {
  name(name: string, o?: DisplayReadOptions): Promise<DisplayAnswer<NameValue>>;
  balance(ticker: string, address: string, o?: DisplayReadOptions): Promise<DisplayAnswer<BalanceValue>>;
}

/** Our front door's CairnX reads at `origin` (an http or https URL without credentials, query or fragment):
 *  `/trade/api/cairnx/name/:name` and `/trade/api/cairnx/token/:ticker`. Redirects are refused; `timeoutMs` (default
 *  10 s) bounds each request. */
export function ourApi(o: { readonly origin: string; readonly fetch?: typeof fetch; readonly timeoutMs?: number }): DisplaySource {
  const base = serverBase(o.origin, "origin"), f = o.fetch ?? globalThis.fetch.bind(globalThis), timeoutMs = o.timeoutMs ?? 10_000;
  return {
    basis: { kind: "display", origin: base },
    async get(path, signal) {
      const t = AbortSignal.timeout(timeoutMs), r = await f(`${base}/trade/api/cairnx/${path}`, { redirect: "error", signal: signal ? either(signal, t) : t });
      return { status: r.status, body: await cappedJson(r, path) };
    },
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const absentOr = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || ok(v);
const strings = (v: unknown): boolean => isObject(v) && Object.values(v).every((x) => typeof x === "string");
const amount = (v: unknown): boolean => typeof v === "string" && /^(0|[1-9][0-9]*)$/.test(v);
const isAddress = (v: unknown): boolean => typeof v === "string" && addressOf(v) === v;
// The fields of a served NameState that nameView reads, each in its type's form.
const servedName = (b: unknown, name: string): b is NameState => isObject(b) && b.name === name && isAddress(b.owner) &&
  absentOr(b.addr, isAddress) && absentOr(b.pending, (x) => x === true) && absentOr(b.expired, (x) => x === true) &&
  absentOr(b.profile, strings) && absentOr(b.paidThroughEpoch, (x) => Number.isSafeInteger(x) && (x as number) >= 0);
const servedToken = (b: unknown, ticker: string, address: string): b is { deployId: string; holders: Record<string, { available: string; locked: string }> } =>
  isObject(b) && b.ticker === ticker && typeof b.deployId === "string" && HASH_RE.test(b.deployId) && isObject(b.holders) &&
  absentOr(b.holders[address], (h) => isObject(h) && amount(h.available) && amount(h.locked));

// The resolver's 404 bodies for an absent record, the only 404s read as an answer. NAME_ABSENT: /cairnx/name/:name
// when `names` holds no such own key; TICKER_ABSENT: /cairnx/token/:ticker for a ticker with no token (cairnx
// src/service.ts at a0d3f27). Any other 404 (the resolver's catch-all "not found", the front door's "not a cairnx read
// endpoint", a reworded refusal) is no answer, so an origin set to the wrong server shows nothing rather than "free".
const NAME_ABSENT = "unregistered name";
const TICKER_ABSENT = "unknown ticker";
const refusal = (b: unknown, error: string): boolean => isObject(b) && Object.keys(b).length === 2 && b.ok === false && b.error === error;

/** A reader of a display source. Throws ReplicaConfigError for any other basis: a replica is read through `open` of
 *  the root entry, and nothing here can report its level. */
export async function open(o: { readonly source: DisplaySource }): Promise<DisplayReader> {
  const basis = Object.freeze(checkBasis(o.source.basis));
  if (basis.kind !== "display") throw new ReplicaConfigError(`./display: a ${basis.kind} basis is read through open() of the root entry`);
  const source = o.source, lv = levelCode(levelOf(basis), false), proof = proofOf(basis);
  const answer = <T>(shown: T | null, code?: NotVerifiedCode, detail?: string): DisplayAnswer<T> => ({
    level: 1, proof, vouch: basis, notes: [], at: null, verified: false, value: null, shown,
    why: [...(lv === null ? [] : [{ code: lv }]), ...(code === undefined ? [] : [detail === undefined ? { code } : { code, detail }])],
  });
  // `f` gets the body of a 200, or null for a 404 that is the read's `absent` refusal; anything else is no answer.
  async function served<T>(path: string, absent: string, ro: DisplayReadOptions, f: (got: { readonly body: unknown } | null) => T | null): Promise<DisplayAnswer<T>> {
    try {
      const r = await source.get(path, ro.signal);
      if (r.status !== 200 && !(r.status === 404 && refusal(r.body, absent))) return answer<T>(null, "SOURCE_UNAVAILABLE", `${path} answered ${r.status}`);
      const v = f(r.status === 200 ? { body: r.body } : null);
      return v === null ? answer<T>(null, "SOURCE_UNAVAILABLE", `${path}: the answer is out of form`) : answer(v);
    } catch (e) {
      return answer<T>(null, "SOURCE_UNAVAILABLE", messageOf(e));
    }
  }
  return {
    async name(name, ro = {}) {
      if (typeof name !== "string" || !NAME_RE.test(name)) return answer<NameValue>(null, "INPUT_INVALID");
      return served(`name/${name}`, NAME_ABSENT, ro, (got) => {
        if (got === null) return nameView({}, name);
        const b = got.body;
        return servedName(b, name) ? nameView({ [name]: b }, name) : null;
      });
    },
    async balance(ticker, address, ro = {}) {
      const a = addressOf(address);
      if (a === null || typeof ticker !== "string" || !TICKER_RE.test(ticker)) return answer<BalanceValue>(null, "INPUT_INVALID");
      return served(`token/${ticker}`, TICKER_ABSENT, ro, (got) => {
        const s = got === null ? { tokens: {}, balances: {} }
          : servedToken(got.body, ticker, a) ? { tokens: { [ticker]: got.body }, balances: { [ticker]: got.body.holders } } : null;
        if (s === null) return null;
        const v = balanceOf(s, ticker, a);
        return { ticker, address: a, deployId: v.deployId, available: v.available, locked: v.locked };
      });
    },
  };
}
