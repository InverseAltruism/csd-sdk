// Event factories for tests: Propose events carrying a built record and Attest events, numbered by their own counter.
// The options are explicit arguments so that each suite's differences stay visible:
//   expiryEpochs: a Propose expires at epochOf(height) + expiryEpochs (default 1000).
//   attConfidence: an Attest's default confidence. Left undefined, the event has no `confidence` field.
//   lower: the proposer and attester in lower case, the form a scanner stores.
import { buildRecord, epochOf, type AttestEvent, type CairnXRecord, type ProposeEvent } from "@inversealtruism/cairnx-core";

export type PropOpts = {
  proposer: string; height: number; pos?: number; expiresEpoch?: number; id?: string;
  paidTo?: Record<string, string>;
};
export type AttOpts = {
  proposalId: string; attester: string; score: number; confidence?: number; height: number;
  pos?: number; paidTo?: Record<string, string>;
};

/** A fresh id counter with prop() and att() bound to one suite's options. */
export function fixtures(opts: { expiryEpochs?: number; attConfidence?: number; lower?: boolean } = {}) {
  const { expiryEpochs = 1000, attConfidence, lower = false } = opts;
  let n = 0;
  const id = () => "0x" + (++n).toString(16).padStart(64, "0");
  const prop = (record: CairnXRecord, o: PropOpts): ProposeEvent => {
    const b = buildRecord(record);
    return {
      kind: "propose", id: o.id ?? id(), proposer: lower ? o.proposer.toLowerCase() : o.proposer,
      uri: b.uri, payloadHash: b.payloadHash,
      height: o.height, pos: o.pos ?? 1,
      expiresEpoch: o.expiresEpoch ?? epochOf(o.height) + expiryEpochs, paidTo: o.paidTo ?? {},
    };
  };
  const att = (o: AttOpts): AttestEvent => {
    const conf = o.confidence ?? attConfidence;
    return {
      kind: "attest", txid: id(), proposalId: o.proposalId,
      attester: lower ? o.attester.toLowerCase() : o.attester, score: o.score,
      ...(conf === undefined ? {} : { confidence: conf }),
      height: o.height, pos: o.pos ?? 50, paidTo: o.paidTo ?? {},
    } as AttestEvent;   // without attConfidence the event has no `confidence` field (see attConfidence above)
  };
  return { id, prop, att };
}
