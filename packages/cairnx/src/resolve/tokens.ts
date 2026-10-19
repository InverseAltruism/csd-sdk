// Token records: deploy, mint, transfer and the v1.5 issuer metadata pointer.
import { parseAmount } from "../records.js";
import {
  DEPLOY_FEE, V11_HEIGHT, V15_HEIGHT,
  type DeployRecord, type MintRecord, type ProposeEvent, type TokenMetaRecord, type TransferRecord,
} from "../types.js";
import type { ResolveCtx } from "./context.js";

export function applyDeploy(c: ResolveCtx, ev: ProposeEvent, rec: DeployRecord, who: string, feeToTreasury: bigint): void {
  const { tokens, note } = c;
  const v11 = ev.height >= V11_HEIGHT;
  if (tokens.has(rec.ticker)) { note(ev, ev.id, "deploy", false, "ticker taken (first anchor wins)"); return; }
  if (v11 && feeToTreasury < BigInt(DEPLOY_FEE)) { note(ev, ev.id, "deploy", false, "deploy fee unpaid"); return; }
  const supply = parseAmount(rec.supply)!;
  const mintLimit = rec.mint === "open" ? parseAmount(rec.mintLimit)! : null;
  tokens.set(rec.ticker, {
    minted: 0n, supply, mintLimit,
    meta: { ticker: rec.ticker, deployId: ev.id, deployer: who, name: rec.name, decimals: rec.decimals, supply: rec.supply, minted: "0", mint: rec.mint, mintLimit: rec.mintLimit, height: ev.height },
  });
  if (v11) c.feesPaid += BigInt(DEPLOY_FEE);
  note(ev, ev.id, "deploy", true);
}

export function applyMint(c: ResolveCtx, ev: ProposeEvent, rec: MintRecord, who: string): void {
  const { tokens, bal, note } = c;
  const tok = tokens.get(rec.ticker);
  if (!tok) { note(ev, ev.id, "mint", false, "unknown ticker"); return; }
  const remaining = tok.supply - tok.minted;
  if (remaining <= 0n) { note(ev, ev.id, "mint", false, "supply exhausted"); return; }
  let credit: bigint;
  if (tok.meta.mint === "issuer") {
    if (who !== tok.meta.deployer) { note(ev, ev.id, "mint", false, "issuer-only mint"); return; }
    const req = rec.amount !== undefined ? parseAmount(rec.amount) : null;
    if (req === null) { note(ev, ev.id, "mint", false, "issuer mint requires amount"); return; }
    credit = req < remaining ? req : remaining;
  } else {
    const req = rec.amount !== undefined ? parseAmount(rec.amount)! : tok.mintLimit!;
    const capped = req < tok.mintLimit! ? req : tok.mintLimit!;
    credit = capped < remaining ? capped : remaining;
  }
  tok.minted += credit;
  bal(rec.ticker, who).available += credit;
  note(ev, ev.id, "mint", true, credit.toString());
}

export function applyTransfer(c: ResolveCtx, ev: ProposeEvent, rec: TransferRecord, who: string): void {
  const { tokens, bal, note } = c;
  if (!tokens.has(rec.ticker)) { note(ev, ev.id, "transfer", false, "unknown ticker"); return; }
  const amt = parseAmount(rec.amount)!;
  const from = bal(rec.ticker, who);
  if (from.available < amt) { note(ev, ev.id, "transfer", false, "insufficient available balance"); return; }
  from.available -= amt;
  bal(rec.ticker, rec.to.toLowerCase()).available += amt;
  note(ev, ev.id, "transfer", true);
}

export function applyTmeta(c: ResolveCtx, ev: ProposeEvent, rec: TokenMetaRecord, who: string): void {
  const { tokens, note } = c;
  const v15 = ev.height >= V15_HEIGHT;
  if (!v15) { note(ev, ev.id, "tmeta", false, "tmeta needs v1.5"); return; }
  const tok = tokens.get(rec.ticker);
  if (!tok) { note(ev, ev.id, "tmeta", false, "unknown ticker"); return; }
  if (who !== tok.meta.deployer) { note(ev, ev.id, "tmeta", false, "issuer-only metadata"); return; }
  tok.meta.tmeta = rec.hash;  // last write wins; content lives in csd-swarm (self-certifying)
  note(ev, ev.id, "tmeta", true);
}
