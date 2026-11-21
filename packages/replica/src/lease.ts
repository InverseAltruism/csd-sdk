// One writer per store directory: a lease on the file `lock`, which holds its holder's random token. The holder sets
// its modification time every TOUCH_MS from an unref'd timer; a lock not touched for STALE_MS is stale and may be taken
// over. A takeover moves the stale lock aside by rename and goes on only when the file it moved is the one it judged
// stale (its token), so of two takers one wins. Node's core library has no advisory file lock, and a lease also holds
// for a container restarted on the same volume. Times come from `clock`, written into the file's mtime, so a test
// moves time without sleeping.
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, linkSync, openSync, readFileSync, renameSync, unlinkSync, utimesSync, writeSync } from "node:fs";
import { codeOf } from "./errors.js";

/** How often a holder touches its lock, and how long an untouched lock stays live. */
export const TOUCH_MS = 5_000, STALE_MS = 20_000;

export interface Lease {
  /** Whether `lock` still holds this lease's token; once false it stays false. */
  holds(): boolean;
  /** Stops the touches and removes `lock` when it is still this lease's. */
  release(): void;
}

const touch = (path: string, ms: number): void => utimesSync(path, ms / 1000, ms / 1000);
function tokenAt(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch (e) { if (codeOf(e) === "ENOENT") return null; throw e; }
}
function create(path: string, token: string, ms: number): boolean {
  let fd: number;
  try { fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600); } catch (e) { if (codeOf(e) === "EEXIST") return false; throw e; }
  try { writeSync(fd, token); } finally { closeSync(fd); }
  touch(path, ms);
  return true;
}

/** The lease on `path`, or null while another holder's lease is live. Throws what the filesystem throws otherwise.
 *  `judged`, for tests, runs between judging a lock stale and moving it aside, where another taker can act. */
export function takeLease(path: string, clock: () => number = Date.now, judged?: () => void): Lease | null {
  const token = randomBytes(16).toString("hex");
  if (!create(path, token, clock())) {
    // The lock's time and token through one descriptor, so both are of one file whatever another taker does meanwhile.
    let fd: number, mtime: number, stale: string;
    try { fd = openSync(path, "r"); } catch (e) { if (codeOf(e) === "ENOENT") return create(path, token, clock()) ? lease(path, token, clock) : null; throw e; }
    try { mtime = fstatSync(fd).mtimeMs; stale = readFileSync(fd, "utf8"); } finally { closeSync(fd); }
    if (clock() - mtime <= STALE_MS) return null;
    const aside = `${path}.stale-${token}`;
    judged?.();
    try { renameSync(path, aside); } catch (e) { if (codeOf(e) === "ENOENT") return null; throw e; }
    if (tokenAt(aside) !== stale) {
      // Another taker's fresh lock was moved: put it back. EEXIST means a third created one meanwhile; the lease moved
      // aside is then lost, and its holder's next commit fails on its token.
      try { linkSync(aside, path); } catch (e) { if (codeOf(e) !== "EEXIST") throw e; }
      unlinkSync(aside);
      return null;
    }
    unlinkSync(aside);
    if (!create(path, token, clock())) return null;
  }
  return lease(path, token, clock);
}

function lease(path: string, token: string, clock: () => number): Lease {
  let held = true;
  const holds = (): boolean => (held &&= tokenAt(path) === token);
  const timer = setInterval(() => {
    try { if (holds()) touch(path, clock()); } catch (e) {
      // A touch that fails leaves the lease to go stale; the token check before each commit decides whether it held.
      if (codeOf(e) === "ENOENT") held = false;
    }
  }, TOUCH_MS);
  timer.unref();
  return {
    holds,
    release() {
      clearInterval(timer);
      if (held && tokenAt(path) === token) unlinkSync(path);
      held = false;
    },
  };
}
