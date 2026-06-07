// Cryptographic binding checks shared by resolvers and publishers. A registry record
// is only counted if the proposing ADDRESS actually signed the thing it claims — so a
// peer_id / gateway url / identity handle is bound to a key, not just asserted.
import { addrFromPub, verifyDigest, signDigest } from "@inversealtruism/csd-crypto";
import { payloadHash } from "@inversealtruism/csd-codec";
import type { ChainRecord, PeerContent, GatewayContent, IdentityRevealContent } from "./types.js";

/** Deterministic 32-byte digest binding a claim to an address (sha256 of canonical JSON). */
export function bindDigest(kind: string, obj: Record<string, unknown>): string {
  return payloadHash({ t: `csd:bind:${kind}`, ...obj });
}

/** Commit value published one epoch before an identity reveal (defeats fee-front-running). */
export function commitHash(handle: string, salt: string, address: string): string {
  return payloadHash({ t: "csd:identity:commit", handle, salt, address: address.toLowerCase() });
}

/** Sign a binding with a private key — used by the publish flows (CLI/wallet). */
export function signBinding(kind: string, obj: Record<string, unknown>, priv: string): { sig64: string; pub33: string } {
  return signDigest(bindDigest(kind, obj), priv);
}

const eq = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function verifyPeer(r: ChainRecord): boolean {
  const c = r.content as PeerContent | null;
  if (!c || c.t !== "peer" || !c.pub || !c.sig || !c.peer_id) return false;
  if (!eq(addrFromPub(c.pub), r.proposer)) return false; // key must hash to the proposer
  return verifyDigest(c.sig, c.pub, bindDigest("peer", { peer_id: c.peer_id, address: r.proposer.toLowerCase() }));
}

export function verifyGateway(r: ChainRecord): boolean {
  const c = r.content as GatewayContent | null;
  if (!c || c.t !== "gateway" || !c.pub || !c.sig || !c.url || !c.url.includes("{hash}")) return false;
  if (!eq(addrFromPub(c.pub), r.proposer)) return false;
  return verifyDigest(c.sig, c.pub, bindDigest("gateway", { url: c.url, address: r.proposer.toLowerCase() }));
}

export function verifyIdentitySig(r: ChainRecord): boolean {
  const c = r.content as IdentityRevealContent | null;
  if (!c || c.t !== "identity-reveal" || !c.pub || !c.sig || !c.handle || !c.address) return false;
  // the bound address must equal both the key's address AND the proposing address
  if (!eq(addrFromPub(c.pub), c.address) || !eq(c.address, r.proposer)) return false;
  return verifyDigest(c.sig, c.pub, bindDigest("identity", { handle: c.handle, address: c.address.toLowerCase() }));
}
