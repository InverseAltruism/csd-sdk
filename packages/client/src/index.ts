// @inversealtruism/csd-client — a typed HTTP client over the Compute Substrate node RPC. Pluggable base URL
// (a direct node, the Cairn proxy `…/api/rpc`, or — later — a csd:gateways-discovered endpoint)
// and a pluggable fetch (for tests / non-DOM runtimes). Read + broadcast; no trust assumptions
// (the light client in @inversealtruism/csd-light verifies what this returns).
import type { Tx, BlockHeader } from "@inversealtruism/csd-codec";

export interface RpcHeaderJson { version: number; prev: string; merkle: string; time: number; bits: number; nonce: number }
export interface RpcTxJson {
  txid: string;
  version: number;
  inputs: { prev_txid: string; vout: number; script_sig: string; script_sig_text?: string | null }[];
  outputs: { value: number; script_pubkey: string }[];
  locktime: number;
  app: { type: "None" } | { type: "Propose"; domain: string; payload_hash: string; uri: string; expires_epoch: number } | { type: "Attest"; proposal_id: string; score: number; confidence: number };
}
export interface RpcBlock { ok: boolean; hash: string; height?: number; chainwork?: string; header: RpcHeaderJson; txs: RpcTxJson[] }
export interface RpcTip { tip: string; height: number; chainwork: string }
export interface RpcUtxo { txid: string; vout: number; value: number; height: number; confirmations: number; coinbase: boolean }
export interface RpcUtxos { ok: boolean; addr20: string; count: number; confirmed_balance: number; utxos: RpcUtxo[] }
export interface RpcSubmit { ok: boolean; txid: string; mempool_len?: number; err?: string | null }

export interface ClientOptions { baseUrl: string; fetch?: typeof fetch; timeoutMs?: number }

export class CsdClient {
  private readonly base: string;
  private readonly f: typeof fetch;
  private readonly timeoutMs: number;
  constructor(opts: ClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.f = opts.fetch ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    if (!this.f) throw new Error("no fetch available — pass opts.fetch");
  }

  private async get<T>(path: string): Promise<T> {
    const r = await this.f(`${this.base}${path}`, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!r.ok) throw new Error(`GET ${path} → HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }
  private async post<T>(path: string, body: unknown): Promise<T> {
    const r = await this.f(`${this.base}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!r.ok) throw new Error(`POST ${path} → HTTP ${r.status}`);
    return r.json() as Promise<T>;
  }

  // The node returns application errors as `{ok:false, err}` with HTTP **200**, so a bare `get()`
  // can't see them. For endpoints whose `{ok:false}` result is useless to the caller (a missing
  // block), surface it as a thrown error — otherwise a beyond-tip/not-found block flows downstream
  // as a malformed object and crashes opaquely (e.g. the light client reading `header.prev`).
  private async getOk<T extends { ok: boolean; err?: string | null }>(path: string): Promise<T> {
    const j = await this.get<T>(path);
    if (j && j.ok === false) throw new Error(`GET ${path} → node error: ${j.err ?? "ok:false"}`);
    return j;
  }

  tip(): Promise<RpcTip> { return this.get("/tip"); }
  health(): Promise<any> { return this.get("/health"); }
  blockByHeight(h: number): Promise<RpcBlock> { return this.getOk(`/block/height/${h}`); }
  blockByHash(hash: string): Promise<RpcBlock> { return this.getOk(`/block/${hash}`); }
  tx(id: string): Promise<{ ok: boolean; txid: string; block_hash?: string; height?: number; time?: number; tx?: RpcTxJson; err?: string }> { return this.get(`/tx/${id}`); }
  utxos(addr: string): Promise<RpcUtxos> { return this.get(`/utxos/${addr}`); }
  proposal(id: string): Promise<any> { return this.get(`/proposal/${id}`); }
  proposals(domain: string, limit = 40): Promise<any> { return this.get(`/proposals/${encodeURIComponent(domain)}/${limit}`); }
  topDomain(domain: string, epoch?: number): Promise<any> { return this.get(epoch == null ? `/top/${encodeURIComponent(domain)}` : `/top/${encodeURIComponent(domain)}/${epoch}`); }
  domains(): Promise<any> { return this.get("/domains"); }
  mempool(): Promise<any> { return this.get("/mempool"); }

  /**
   * Broadcast a node-JSON tx (from @inversealtruism/csd-tx `txToNodeJson`).
   * ⚠ The node returns `{ok:false, err}` with HTTP 200 on REJECTION — and **`txid` is populated even
   * then** (it's the computed id of the rejected tx). Callers MUST check `.ok`; reading `.txid`
   * alone mistakes a rejected tx for a broadcast one. Use `submitOrThrow` if you want a hard failure.
   */
  submit(nodeJsonTx: unknown): Promise<RpcSubmit> { return this.post("/tx/submit", { tx: nodeJsonTx }); }
  /** As `submit`, but throws on node rejection (`ok:false`) instead of returning a misleading txid. */
  async submitOrThrow(nodeJsonTx: unknown): Promise<RpcSubmit> {
    const r = await this.submit(nodeJsonTx);
    if (!r.ok) throw new Error(`tx rejected by node: ${r.err ?? "unknown error"}`);
    return r;
  }
  templatePropose(body: unknown): Promise<any> { return this.post("/tx/template/propose", body); }
  templateAttest(body: unknown): Promise<any> { return this.post("/tx/template/attest", body); }
}

/** Convert a node /tx or /block tx JSON back into the codec's Tx struct (for re-verification). */
export function rpcTxToTx(j: RpcTxJson): Tx {
  const app = j.app.type === "None"
    ? { type: "None" as const }
    : j.app.type === "Propose"
      ? { type: "Propose" as const, domain: j.app.domain, payloadHash: j.app.payload_hash, uri: j.app.uri, expiresEpoch: j.app.expires_epoch }
      : { type: "Attest" as const, proposalId: j.app.proposal_id, score: j.app.score, confidence: j.app.confidence };
  return {
    version: j.version, locktime: j.locktime, app,
    inputs: j.inputs.map((i) => ({ prevTxid: i.prev_txid, vout: i.vout, scriptSig: i.script_sig })),
    outputs: j.outputs.map((o) => ({ value: o.value, scriptPubkey: o.script_pubkey })),
  };
}

/** Convert a node /block header JSON into the codec's BlockHeader. */
export function rpcHeaderToHeader(h: RpcHeaderJson): BlockHeader {
  return { version: h.version, prev: h.prev, merkle: h.merkle, time: h.time, bits: h.bits, nonce: h.nonce };
}
