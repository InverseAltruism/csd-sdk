// Token records: deploy, mint, transfer and the v1.5 issuer metadata pointer.
import { parseAmount } from "../records.js";
import {
  DEPLOY_FEE, V11_HEIGHT, V15_HEIGHT,
  type DeployRecord, type MintRecord, type ProposeEvent, type TokenMetaRecord, type TransferRecord,
} from "../types.js";
import { tokenMove, type ResolveCtx } from "./context.js";

export function applyDeploy(c: ResolveCtx, ev: ProposeEvent, rec: DeployRecord, who: string, feeToTreasury: bigint): void {
  const { tokens, applied, refused } = c;
  const v11 = ev.height >= V11_HEIGHT;
  if (tokens.has(rec.ticker)) { refused(ev, ev.id, "deploy", "TOKEN_TICKER_TAKEN", "ticker taken (first anchor wins)"); return; }
  if (v11 && feeToTreasury < BigInt(DEPLOY_FEE)) { refused(ev, ev.id, "deploy", "TREASURY_FEE_UNPAID", "deploy fee unpaid"); return; }
  const supply = parseAmount(rec.supply)!;
  const mintLimit = rec.mint === "open" ? parseAmount(rec.mintLimit)! : null;
  tokens.set(rec.ticker, {
    minted: 0n, supply, mintLimit,
    meta: { ticker: rec.ticker, deployId: ev.id, deployer: who, name: rec.name, decimals: rec.decimals, supply: rec.supply, minted: "0", mint: rec.mint, mintLimit: rec.mintLimit, height: ev.height },
  });
  if (v11) c.feesPaid += BigInt(DEPLOY_FEE);
  applied(ev, ev.id, "deploy", "TOKEN_DEPLOYED");
}

export function applyMint(c: ResolveCtx, ev: ProposeEvent, rec: MintRecord, who: string): void {
  const { tokens, bal, applied, refused } = c;
  const tok = tokens.get(rec.ticker);
  if (!tok) { refused(ev, ev.id, "mint", "TOKEN_UNKNOWN", "unknown ticker"); return; }
  const remaining = tok.supply - tok.minted;
  if (remaining <= 0n) { refused(ev, ev.id, "mint", "TOKEN_SUPPLY_EXHAUSTED", "supply exhausted"); return; }
  let credit: bigint;
  if (tok.meta.mint === "issuer") {
    if (who !== tok.meta.deployer) { refused(ev, ev.id, "mint", "TOKEN_NOT_ISSUER", "issuer-only mint"); return; }
    const req = rec.amount !== undefined ? parseAmount(rec.amount) : null;
    if (req === null) { refused(ev, ev.id, "mint", "TOKEN_MINT_AMOUNT_REQUIRED", "issuer mint requires amount"); return; }
    credit = req < remaining ? req : remaining;
  } else {
    const req = rec.amount !== undefined ? parseAmount(rec.amount)! : tok.mintLimit!;
    const capped = req < tok.mintLimit! ? req : tok.mintLimit!;
    credit = capped < remaining ? capped : remaining;
  }
  tok.minted += credit;
  bal(rec.ticker, who).available += credit;
  applied(ev, ev.id, "mint", "TOKEN_MINTED", credit.toString(), [tokenMove("mint", rec.ticker, null, who, credit)]);
}

export function applyTransfer(c: ResolveCtx, ev: ProposeEvent, rec: TransferRecord, who: string): void {
  const { tokens, bal, applied, refused } = c;
  if (!tokens.has(rec.ticker)) { refused(ev, ev.id, "transfer", "TOKEN_UNKNOWN", "unknown ticker"); return; }
  const amt = parseAmount(rec.amount)!;
  const from = bal(rec.ticker, who);
  if (from.available < amt) { refused(ev, ev.id, "transfer", "TOKEN_BALANCE_LOW", "insufficient available balance"); return; }
  const to = rec.to.toLowerCase();
  from.available -= amt;
  bal(rec.ticker, to).available += amt;
  applied(ev, ev.id, "transfer", "TOKEN_TRANSFERRED", undefined, [tokenMove("xfer", rec.ticker, who, to, amt)]);
}

export function applyTmeta(c: ResolveCtx, ev: ProposeEvent, rec: TokenMetaRecord, who: string): void {
  const { tokens, applied, refused } = c;
  const v15 = ev.height >= V15_HEIGHT;
  if (!v15) { refused(ev, ev.id, "tmeta", "GATE_NOT_ACTIVE", "tmeta needs v1.5"); return; }
  const tok = tokens.get(rec.ticker);
  if (!tok) { refused(ev, ev.id, "tmeta", "TOKEN_UNKNOWN", "unknown ticker"); return; }
  if (who !== tok.meta.deployer) { refused(ev, ev.id, "tmeta", "TOKEN_NOT_ISSUER", "issuer-only metadata"); return; }
  tok.meta.tmeta = rec.hash;  // last write wins; content lives in csd-swarm (self-certifying)
  applied(ev, ev.id, "tmeta", "TOKEN_META_SET");
}
