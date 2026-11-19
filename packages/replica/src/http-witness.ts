// Witnesses over HTTP (design section 4): another origin than the header source, asked for its tip with its header
// and for the hash of a block. A witness vouches for no record, so any http or https URL without credentials, query
// or fragment is accepted. Its answers pass the checks of block-read.ts: a header must hash to the hash served at
// the height asked; a tip whose header is not the block its /tip names is no answer. Neither has `rules`: no route
// for a gate table is fixed yet.
import type { Witness, WitnessTip } from "./answer.js";
import { rowsOf } from "./anchor-root.js";
import { headerOf, readHead } from "./block-read.js";
import { httpSessions, type HttpOptions } from "./http.js";
import { serverBase } from "./node-address.js";

/** A node's /tip and /block/height/:h, such as a visitor's own node. */
export function nodeWitness(o: HttpOptions & { readonly node: string }): Witness {
  const base = serverBase(o.node, "node"), session = httpSessions(base, o);
  const block = async (signal: AbortSignal, height: number) => headerOf(await session(signal).client.blockByHeight(height), height, null);
  return {
    id: `node ${base}`, origin: base,
    async tip(signal): Promise<WitnessTip | null> {
      const h = await readHead(session(signal), "the witness"), b = await block(signal, h.height);
      return b.hash === h.hash ? { height: h.height, hash: b.hash, time: Number(b.header.time), header: b.header } : null;
    },
    hashAt: async (height, signal) => (await block(signal, height)).hash,
  };
}

/** Our front door's /api/rpc/tip and /api/headers/:h/1, the routes hostedBlocks reads, such as our second host. */
export function hostedWitness(o: HttpOptions & { readonly origin: string }): Witness {
  const base = serverBase(o.origin, "origin"), session = httpSessions(base, o, "/api/rpc");
  const header = async (signal: AbortSignal, height: number) => rowsOf(height, 1)(await session(signal).json(`/api/headers/${height}/1`, false))[0]!;
  return {
    id: `hosted ${base}`, origin: base,
    async tip(signal): Promise<WitnessTip | null> {
      const h = await readHead(session(signal), "the witness"), r = await header(signal, h.height);
      return r.hash === h.hash ? { height: h.height, hash: r.hash, time: Number(r.header.time), header: r.header } : null;
    },
    hashAt: async (height, signal) => (await header(signal, height)).hash,
  };
}
