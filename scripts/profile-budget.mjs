#!/usr/bin/env node
// The nprofile byte budget of CONVENTION.md section 36.4: each row is the record cairnx-core's own builder makes for a
// 32-character name, measured in UTF-8 bytes against MAX_RECORD_BYTES. test/profile-budget.test.ts keeps the table in
// CONVENTION.md equal to these rows. Needs the built package (pnpm -r build).
// Run: node scripts/profile-budget.mjs
import {
  MAX_RECORD_BYTES, PROFILE_MAX_KEYS, canonicalJson, nameProfile,
} from "../packages/cairnx/dist/index.js";

export const NAME = "abcdefghijklmnopqrstuvwxyz012345";
// Example values of a realistic length, the same as the site's integrators page: a CIDv1 in base32, a multiaddr with
// an Ed25519 peer id, an https base URL. The gateway is a WebRTC-direct multiaddr with a certificate hash and a peer
// id, on a documentation address (RFC 3849), 158 bytes.
export const VALUES = {
  contenthash: "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi",
  "csd.p2p": "/dns4/node.example.org/tcp/17999/p2p/12D3KooWNgeSkKAs4ibFjKbwbwzzPAL2XUSrBEAh95EAPPvpGhVm",
  "csd.rpc": "https://node.example.org",
};
export const GATEWAY =
  "/ip6/2001:db8::a:220/udp/18001/webrtc-direct/certhash/uEiA0yN24VOmjrxkOjekydWWZ3Ycz6lGOZl_iTjfEsyIctQ" +
  "/p2p/12D3KooWNgeSkKAs4ibFjKbwbwzzPAL2XUSrBEAh95EAPPvpGhVm";
// The keys the reference site's profile editor writes (section 36.2), each given a 12-byte value here.
export const EDITOR_KEYS = [
  "display", "description", "avatar", "header", "url", "email", "location",
  "com.twitter", "com.github", "com.discord", "org.telegram", "com.linkedin", "com.reddit",
];
const EDITOR_VALUE = "x".repeat(12);
const editor = () => Object.fromEntries(EDITOR_KEYS.map((k) => [k, EDITOR_VALUE]));

/** @type {Array<[string, () => Record<string, string>]>} */
const ROWS = [
  ["empty", () => ({})],
  ["contenthash", () => ({ contenthash: VALUES.contenthash })],
  ["contenthash, csd.p2p", () => ({ contenthash: VALUES.contenthash, "csd.p2p": VALUES["csd.p2p"] })],
  ["contenthash, csd.p2p, csd.rpc (https URL)", () => ({ ...VALUES })],
  ["contenthash, csd.p2p, csd.rpc (gateway multiaddr)", () => ({ ...VALUES, "csd.rpc": GATEWAY })],
  ["13 editor keys, contenthash, csd.p2p", () => ({ ...editor(), contenthash: VALUES.contenthash, "csd.p2p": VALUES["csd.p2p"] })],
];

/** @param {string} s */
const utf8 = (s) => new TextEncoder().encode(s).length;

/**
 * One row per profile shape: the record's bytes, what is left of MAX_RECORD_BYTES (negative: over the cap), and
 * whether nameProfile builds it. A record over the cap is measured with canonicalJson, the builder's own serializer,
 * because the builder refuses it.
 * @returns {Array<{ label: string, keys: number, bytes: number, left: number, builds: boolean }>}
 */
export function budgetRows() {
  return ROWS.map(([label, make]) => {
    const p = make();
    const bytes = utf8(canonicalJson({ v: 1, t: "nprofile", name: NAME, p }));
    let uri = null;
    try {
      uri = nameProfile({ name: NAME, p }).uri;
    } catch {
      uri = null;
    }
    if (uri !== null && utf8(uri) !== bytes) throw new Error(`${label}: the builder's record has other bytes`);
    const builds = uri !== null;
    return { label, keys: Object.keys(p).length, bytes, left: MAX_RECORD_BYTES - bytes, builds };
  });
}

/** The keys of the 13 editor keys and the three registered keys together, against PROFILE_MAX_KEYS. */
export const keyCount = () => new Set([...EDITOR_KEYS, ...Object.keys(VALUES)]).size;

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`name ${NAME} (${NAME.length} characters), record cap ${MAX_RECORD_BYTES} bytes`);
  for (const [k, v] of Object.entries(VALUES)) console.log(`  ${k} = ${v} (${utf8(v)} bytes)`);
  console.log(`  csd.rpc gateway = ${GATEWAY} (${utf8(GATEWAY)} bytes)`);
  console.log(`  editor keys: ${EDITOR_KEYS.length}, each value ${utf8(EDITOR_VALUE)} bytes`);
  for (const r of budgetRows()) {
    const rest = r.left >= 0 ? `${r.left} left` : `${-r.left} over`;
    const built = r.builds ? "nameProfile builds it" : "nameProfile refuses it";
    console.log(`${r.label.padEnd(50)} ${String(r.keys).padStart(2)} keys ${String(r.bytes).padStart(4)} bytes, ${rest}, ${built}`);
  }
  console.log(`13 editor keys and the three registered keys: ${keyCount()} keys, PROFILE_MAX_KEYS ${PROFILE_MAX_KEYS}`);
}
