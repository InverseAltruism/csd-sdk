// The header window of a self-verified root (design section 2): csd-light's LightClient seeded with the
// LWMA_WINDOW headers ending at workRoot (seedTrusted: PoW and links, the last hashing to workRoot's hash), then
// verified forward header by header (ingest: link, time rules, LWMA bits, PoW) and holding only the last
// LWMA_WINDOW + `depth` headers, or more while `keep` asks. Every header check is csd-light's. `work` is the work of
// the held chain above workRoot; a window seeded from the same headers counts it from the same place, so two
// windows compare. A branch forks from a held header with its LWMA_WINDOW headers of context held (`low` or above),
// and csd-light's tryReorg adopts it only with more work than the tip.
import { LWMA_WINDOW, type BlockHeader } from "@inversealtruism/csd-codec";
import { LightClient, type VerifiedHeader } from "@inversealtruism/csd-light";
import { SourceError, messageOf } from "./errors.js";
import type { Cursor } from "./types.js";

export interface HeaderRow { readonly height: number; readonly header: BlockHeader; readonly hash: string }

export class HeaderWindow {
  private constructor(private readonly lc: LightClient, readonly depth: number, readonly root: Cursor, private readonly rootWork: bigint) {}

  /** A window at `at` from `seed`, the LWMA_WINDOW headers ending there. `at` is workRoot itself, or a block the
   *  caller verified from workRoot with `work` above it, so `work` keeps counting from workRoot. A seed that does
   *  not end at workRoot's hash is PIN_OFF_CHAIN; one that fails a PoW or link check, or a later seed that does not
   *  end at its block, HEADER_INVALID. */
  static seed(seed: readonly HeaderRow[], at: Cursor, depth: number, from: { readonly root: Cursor; readonly work: bigint } = { root: at, work: 0n }): HeaderWindow {
    const lc = new LightClient();
    if (seed.length !== LWMA_WINDOW || seed.at(-1)?.height !== at.height) {
      throw new SourceError("SOURCE_MALFORMED", `the headers below ${at.height} are not the ${LWMA_WINDOW} ending there`);
    }
    try {
      lc.seedTrusted(seed.map((r) => ({ height: r.height, header: r.header, hash: r.hash })), at.hash);
    } catch (e) {
      const offRoot = at.height === from.root.height && /checkpoint hash mismatch/.test(messageOf(e));
      throw new SourceError(offRoot ? "PIN_OFF_CHAIN" : "HEADER_INVALID", `the headers ending at ${at.height}: ${messageOf(e)}`);
    }
    return new HeaderWindow(lc, depth, from.root, lc.chainwork - from.work);
  }

  get tip(): VerifiedHeader { return this.lc.tip!; }
  get work(): bigint { return this.lc.chainwork - this.rootWork; }
  get low(): number { return this.lc.baseHeight + LWMA_WINDOW - 1; }
  at(height: number): VerifiedHeader | undefined { return height >= this.lc.baseHeight ? this.lc.chain[height - this.lc.baseHeight] : undefined; }
  hashAt(height: number): string | null { return this.at(height)?.hash.toLowerCase() ?? null; }

  /** The reseed rule (design section 2): a window seeded from the same headers replaces one whose work is `held`
   *  only when its own exceeds it; a tie keeps the held chain. */
  outworks(held: bigint): boolean { return this.work > held; }

  /** Appends rows from tip + 1, each verified, keeping `keep` at or above `low` so the window can rewind to it. Throws at the first that
   *  fails, the rows before it kept: PIN_OFF_CHAIN when the header above workRoot names another parent, else
   *  HEADER_INVALID. */
  extend(rows: readonly HeaderRow[], keep = Number.POSITIVE_INFINITY): void {
    for (const r of rows) {
      try {
        this.lc.ingest(r.height, r.header, r.hash);
      } catch (e) {
        const offRoot = r.height === this.root.height + 1 && /broken prev link/.test(messageOf(e));
        throw new SourceError(offRoot ? "PIN_OFF_CHAIN" : "HEADER_INVALID", `the header at ${r.height}: ${messageOf(e)}`);
      }
      this.trim(keep);
    }
  }

  /** Adopts `rows`, a branch forking at rows[0].height - 1, at or above `low`, when it has more work than the tip,
   *  keeping the fork block at or above `low`; else LESS_WORK, the window unchanged. HEADER_INVALID when a header of
   *  it fails. */
  branch(rows: readonly HeaderRow[]): void {
    const fork = (rows[0]?.height ?? 0) - 1;
    if (fork < this.low || fork > this.tip.height) throw new RangeError(`window: a branch from ${fork} is outside ${this.low} to ${this.tip.height}`);
    const r = this.lc.tryReorg(rows.map((x) => ({ height: x.height, header: x.header, hash: x.hash })));
    if (r.adopted) { this.trim(fork); return; }
    throw new SourceError(/^alt work/.test(r.reason ?? "") ? "LESS_WORK" : "HEADER_INVALID", `the branch above ${fork}: ${r.reason ?? ""}`);
  }

  /** Drops the headers above `height`, which must be `low` or above. */
  rewind(height: number): void {
    if (height < this.low || height > this.tip.height) throw new RangeError(`window: cannot rewind to ${height}`);
    this.lc.chain.length = height - this.lc.baseHeight + 1;
  }

  private trim(keep: number): void {
    const extra = Math.min(this.lc.chain.length - LWMA_WINDOW - this.depth, keep - LWMA_WINDOW + 1 - this.lc.baseHeight);
    if (extra > 0) { this.lc.chain.splice(0, extra); this.lc.baseHeight += extra; }
  }
}
