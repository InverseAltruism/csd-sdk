// Level 3, proof pinned: a .csd name from the release's pin (@inversealtruism/cairnx-pin) and our hosted blocks above
// it, their headers verified from the pin's block (the README, "Pins"), and the site the name's profile points to: its
// `contenthash`, an ipfs:// URI (CONVENTION section 36.2), for any IPFS gateway or a browser that opens ipfs:// links.
// Without a witness on another origin no answer is verified (NOT_WITNESSED); one's own node can be that witness.
//   node pinned.mjs <front door origin> <name> [<node url>]
//   node pinned.mjs https://cairn-substrate.com m http://127.0.0.1:8789
import { PIN } from "@inversealtruism/cairnx-pin";
import { hosted, nodeWitness, open } from "@inversealtruism/cairnx-replica/server";

const [origin, name, witness] = process.argv.slice(2);
if (!origin || !name) { console.error("usage: node pinned.mjs <front door origin> <name> [<node url>]"); process.exit(2); }

const replica = await open(hosted({ pin: PIN, origin, ...(witness ? { witness: nodeWitness({ node: witness }) } : {}) }));
await replica.advance();
const a = await replica.name(name);
const record = a.verified ? a.value : a.shown;
const contenthash = record?.profile?.contenthash;
console.log(JSON.stringify({
  name, level: a.level, proof: a.proof, verified: a.verified, why: a.why.map((w) => w.code),
  at: a.at && { height: a.at.height, tipHeight: a.at.tipHeight }, record,
  site: typeof contenthash === "string" && contenthash.startsWith("ipfs://") ? contenthash : null,
}, null, 2));
await replica.close();
