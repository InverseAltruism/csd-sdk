// A check of served name hints written from cairnx-core's replay rules, not from the selector: in a replay of exactly
// the hints, an applied nset (nprofile) is superseded when a later applied record writes the same field whole or
// clears it: an nset (nprofile), an nxfer, or a fill of an offer giving the name (resolve/names.ts applyNset,
// applyNprofile, applyNxfer; resolve/attest.ts deliverNameToBuyer). Order is cairnx-core's applyOrder.
import { applyOrder, eventId, isNameGive, parseRecord, resolve, SCORE_FILL, type ChainEvent } from "@inversealtruism/cairnx-core";

type Field = "addr" | "profile";

/** The ids among `txids` of the nset and nprofile records the hints' own replay supersedes. */
export function supersededHints(events: readonly ChainEvent[], tip: number, name: string, txids: readonly string[]): string[] {
  const want = new Set(txids.map((t) => t.toLowerCase()));
  const evs = events.filter((e) => want.has(eventId(e).toLowerCase())).sort(applyOrder);
  const applied = new Set(resolve(evs, tip).events.filter((l) => l.ok).map((l) => l.id.toLowerCase()));
  const offersOfName = new Set<string>();
  const writes = (e: ChainEvent): { own?: Field; fields: Field[] } => {
    if (e.kind === "attest") {
      return e.score === SCORE_FILL && offersOfName.has(e.proposalId.toLowerCase()) ? { fields: ["addr", "profile"] } : { fields: [] };
    }
    const rec = parseRecord(e.uri, e.payloadHash);
    if (rec?.t === "offer" && isNameGive(rec.give) && rec.give.name === name) offersOfName.add(e.id.toLowerCase());
    if (rec?.t === "nset" && rec.name === name) return { own: "addr", fields: ["addr"] };
    if (rec?.t === "nprofile" && rec.name === name) return { own: "profile", fields: ["profile"] };
    if (rec?.t === "nxfer" && rec.name === name) return { fields: ["addr", "profile"] };
    return { fields: [] };
  };
  const kinds = evs.map(writes);   // forward, so every offer is known before its fills
  const written = new Set<Field>(), out: string[] = [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const id = eventId(evs[i]!).toLowerCase(), w = kinds[i]!;
    if (!applied.has(id)) continue;
    if (w.own && written.has(w.own)) out.push(id);
    for (const f of w.fields) written.add(f);
  }
  return out;
}
