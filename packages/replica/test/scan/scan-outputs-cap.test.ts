// The Scanner reads at most MAX_TX_OUTPUTS outputs of an indexer's /tx answer: consensus admits no more, so an output
// listed past them belongs to no transaction and feeds no paidTo. Paired: the last output consensus admits still counts.
import assert from "node:assert/strict";
import { MAX_TX_OUTPUTS } from "@inversealtruism/csd-codec";
import { ACTIVATION_HEIGHT, DOMAIN, EPOCH_LEN, deploy } from "@inversealtruism/cairnx-core";
import { Scanner } from "../../src/scanner.js";

const A = "0x" + "aa".repeat(20), X = "0x" + "77".repeat(20);
const H = ACTIVATION_HEIGHT + 40;
const PID = "0x" + "01".padStart(64, "0");
const dep = deploy({ ticker: "CAPS", decimals: 0, supply: "1000", mint: "open", mintLimit: "1000" });

/** One proposal whose transaction lists `count` outputs, the last of them paying X. */
function indexer(count: number): typeof fetch {
  const outputs = Array.from({ length: count }, (_, i) => (i === count - 1 ? { addr: X, value: 777 } : { addr: A, value: 1 }));
  const answers: Record<string, unknown> = {
    "/blocks/tip/height": H + 20,
    [`/domain/${DOMAIN}/proposals`]: [{ txid: PID, payload_hash: dep.payloadHash, uri: dep.uri, expires_epoch: Math.floor(H / EPOCH_LEN) + 1000, proposer: A, height: H }],
    [`/proposal/${PID}/attestations`]: [],
    [`/tx/${PID}`]: { txid: PID, height: H, pos: 1, outputs },
  };
  return (async (input: string | URL | Request) => {
    const path = decodeURIComponent(new URL(String(input)).pathname);
    const body = path.startsWith("/block-height/") ? "0x" + path.slice(14).padStart(64, "0") : answers[path];
    return body === undefined ? new Response("{}", { status: 404 }) : Response.json(body);
  }) as typeof fetch;
}
const paidTo = async (count: number) => {
  const { events } = await new Scanner({ indexerUrl: "http://idx", fetch: indexer(count) }).scan();
  assert.equal(events.length, 1);
  return events[0]!.paidTo;
};

assert.equal((await paidTo(MAX_TX_OUTPUTS + 1))[X], undefined, "an output past MAX_TX_OUTPUTS feeds no paidTo");
console.log(`  ok an output listed past the ${MAX_TX_OUTPUTS} consensus admits feeds no paidTo`);
assert.equal((await paidTo(MAX_TX_OUTPUTS))[X], "777", "paired: the last output consensus admits counts");
console.log(`  ok paired: the ${MAX_TX_OUTPUTS}th output still feeds paidTo`);
console.log("scan-outputs-cap: 2 passed");
