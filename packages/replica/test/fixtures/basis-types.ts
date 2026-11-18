// Never run: test/basis.test.ts compiles it with tsc, and `pnpm typecheck` includes it. Each @ts-expect-error line must
// be an error, so a pinned basis over anything but blocks becoming assignable fails the compile, and so does a lawful
// basis no longer compiling.
import type { Basis, BlocksBasis } from "../../src/index.js";

const pin = { height: 117_000, hash: `0x${"ab".repeat(32)}` }, logSha256 = `0x${"cd".repeat(32)}`;
const blocks: BlocksBasis = { kind: "blocks", root: { kind: "own-node", node: "http://127.0.0.1:8789" }, bodies: "http://127.0.0.1:8789" };
const lawful: Basis[] = [
  blocks,
  { kind: "pinned", pin, logSha256, above: blocks },
  { kind: "pinned", pin, logSha256, above: { kind: "blocks", root: { kind: "anchor", anchor: pin }, bodies: "https://blocks.example" } },
  { kind: "feed", feed: "https://feed.example", inclusion: true },
];
// @ts-expect-error a feed does not sit above a pin
const overFeed: Basis = { kind: "pinned", pin, logSha256, above: { kind: "feed", feed: "https://feed.example", inclusion: true } };
// @ts-expect-error nor a display
const overDisplay: Basis = { kind: "pinned", pin, logSha256, above: { kind: "display", origin: "https://api.example" } };
// @ts-expect-error nor another pin
const overPin: Basis = { kind: "pinned", pin, logSha256, above: { kind: "pinned", pin, logSha256, above: blocks } };
void [lawful, overFeed, overDisplay, overPin];
