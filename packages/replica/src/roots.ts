// The header roots of hostedBlocks, which does not trust the server it reads blocks from (design section 2): what a
// root does before a step's pages and with each page's headers. The anchor root is anchor-root.ts.
import type { SourceError } from "./errors.js";
import type { Head } from "./fork.js";
import type { Session } from "./http.js";
import type { HeaderRoot, StepContext, Step, TipView } from "./types.js";
import type { HeaderRow } from "./window.js";

/** Internal. How many leading rows of a page are verified, and the error that ends them, if any. */
export type Checked = { readonly verified: number; readonly error: SourceError | null };

/** Internal. `begin` runs before the pages: the step to return instead (a reorg, idle or cannot), or how far to try
 *  to read (the server's unverified claim, never a tip). `check` takes a page's rows from the first unread height: a
 *  step (a reorg below the store's cursor), or how many leading rows are verified and the error to throw once they
 *  are bound; with `final` false a row that differs from the root throws BRANCH_MOVED, so the page is read again
 *  past caches before a refusal. `hashAt` is the verified hash at a height, or null. `tipView` is the tip the root
 *  vouches for (types.ts, TipView), null before it has one; `tip` may read the root for it. Each throws
 *  SourceError. */
export interface Root {
  readonly root: HeaderRoot;
  begin(s: Session, ctx: StepContext, server: Head): Promise<Step | { readonly to: number }>;
  check(s: Session, ctx: StepContext, server: Head, rows: readonly HeaderRow[], final: boolean): Promise<Step | Checked>;
  hashAt(height: number): Promise<string | null>;
  tipView(): TipView | null;
  tip(signal: AbortSignal): Promise<TipView | null>;
}
