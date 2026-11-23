// The poller of ./server's open() (pollMs): a reader that advances on its own, for a server that only answers reads.
import type { Reader } from "./reader.js";

/** The shortest and longest `pollMs` open() takes: a poll a second at most, and setTimeout's own limit. */
export const POLL_MS_RANGE = Object.freeze({ min: 1_000, max: 2 ** 31 - 1 });

/** `reader` with a poller: advance() again `ms` after each advance ends, until close(). The timer does not keep the
 *  process alive. An advance that rejects is let go as a read's own is (reader.ts): the load that refuses a store puts
 *  its reason in status() (storeReason, storeError) before it throws, and the poller goes on. */
export function polled(reader: Reader, ms: number): Reader {
  let timer: ReturnType<typeof setTimeout> | undefined, closed = false;
  const poll = (): void => {
    if (closed) return;
    void reader.advance().catch(() => undefined).then(() => {
      if (closed) return;
      timer = setTimeout(poll, ms);
      timer.unref?.();
    });
  };
  poll();
  return { ...reader, async close() { closed = true; clearTimeout(timer); await reader.close(); } };
}
