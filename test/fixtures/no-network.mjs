// Preload for test/live-opt-in.test.ts: any outbound request (fetch or a raw TCP connect) ends the process
// with exit code 97 and names the target, so a test that reaches the network without opting in fails.
import net from "node:net";

const refuse = (what) => {
  process.stderr.write(`NETWORK ATTEMPT: ${what}\n`);
  process.exit(97);
};
globalThis.fetch = async (input) => refuse(`fetch ${typeof input === "string" ? input : String(input?.url ?? input)}`);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const o = args[0];
  if (o && typeof o === "object" && typeof o.path === "string") return connect.apply(this, args); // local IPC (tsx's own pipe)
  return refuse(`connect ${JSON.stringify(o)}`);
};
