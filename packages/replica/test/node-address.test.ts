// The address rule of each entry. CAIRNX_OWN_NODE_HOSTS is set before the entries load and changed after the first
// use, which the server entry must not see: the list is read once. A list with an entry out of form throws at that
// read, which a child process shows. No request is made (a source reads lazily).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ReplicaConfigError } from "../src/index.js";
import { parseHosts } from "../src/node-address.js";
import { done, ok, thrown } from "./check.js";

process.env.CAIRNX_OWN_NODE_HOSTS = " csd , node.internal,[fd00::a],";
const browser = await import("../src/browser.js"), server = await import("../src/server.js");
type Entry = typeof browser.nodeBlocks;
const nodeOf = (entry: Entry, node: string): string | null => {
  try {
    const r = entry({ node }).basis.root;
    return r.kind === "own-node" ? r.node : null;
  } catch (e) {
    if (e instanceof ReplicaConfigError && !e.message.includes("secret")) return null;
    throw e;
  }
};
const passes = (entry: Entry, nodes: string[]) => nodes.filter((n) => nodeOf(entry, n) === null);

const loopback = ["http://127.0.0.1:8789", "http://localhost:8789/", "http://[::1]:8789", "https://LOCALHOST/rpc/"];
const listed = ["http://csd:8789", "http://node.internal", "http://[fd00::a]:8789", "http://CSD:8789"];
const privates = ["http://10.1.2.3:8789", "http://172.16.0.1", "http://172.31.255.255", "http://192.168.1.1", "http://100.64.0.1",
  "http://100.127.0.1", "http://[fd00::1]:8789", "http://[fc12:3456::1]", "http://10.1"];
const others = ["http://example.com", "https://8.8.8.8:8789", "http://172.32.0.1", "http://172.15.0.1", "http://100.128.0.1", "http://100.63.0.1",
  "http://11.0.0.1", "http://192.169.0.1", "http://127.0.0.2", "http://[fe80::1]", "http://[::ffff:10.0.0.1]", "http://csd.example.com",
  "http://user:secret@127.0.0.1:8789", "http://:secret@127.0.0.1:8789", "http://user@127.0.0.1", "http://127.0.0.1:8789/?x=1", "http://127.0.0.1:8789/#f", "ftp://127.0.0.1", "127.0.0.1:8789", "not a url"];

console.log("./browser:");
ok("a loopback node passes, its base URL normalized", passes(browser.nodeBlocks, loopback).length === 0 &&
  nodeOf(browser.nodeBlocks, "http://localhost:8789/") === "http://localhost:8789" && nodeOf(browser.nodeBlocks, "https://LOCALHOST/rpc/") === "https://localhost/rpc");
ok("a private, listed or public node throws ReplicaConfigError", passes(browser.nodeBlocks, [...privates, ...listed, ...others]).length === privates.length + listed.length + others.length);
console.log("./server:");
ok("a loopback, private or listed node passes", passes(server.nodeBlocks, [...loopback, ...privates, ...listed]).length === 0,
  passes(server.nodeBlocks, [...loopback, ...privates, ...listed]).join(", "));
ok("a public node, a near miss of a range, credentials, a query, a fragment or another scheme throws, without echoing the address",
  passes(server.nodeBlocks, others).length === others.length);
process.env.CAIRNX_OWN_NODE_HOSTS = "late.host";
ok("CAIRNX_OWN_NODE_HOSTS is read once: a host listed after the first use throws, one listed before still passes",
  thrown(() => server.nodeBlocks({ node: "http://late.host" })) instanceof ReplicaConfigError && nodeOf(server.nodeBlocks, "http://csd:8789") === "http://csd:8789");

console.log("CAIRNX_OWN_NODE_HOSTS:");
const badEntries = ["csd:8789", "http://csd3", "csd4.", "*", "CSD", "BÜCHER.internal", "0x7f.1", "example.org/", "fd00::9", "[FD00::1]", "user@csd"];
const named = badEntries.filter((e) => { const x = thrown(() => parseHosts(`csd,${e}`)); return x instanceof ReplicaConfigError && x.message.includes(JSON.stringify(e)); });
ok(`an entry with a port, scheme, path, trailing dot, wildcard, upper case, non-ASCII or a form a URL rewrites throws, naming it (${named.length} of ${badEntries.length})`,
  named.length === badEntries.length);
ok("an empty or unset list is the empty set, empty entries skipped", parseHosts(undefined).size === 0 && parseHosts(" , ,").size === 0 &&
  [...parseHosts("a.internal,,10.9.9.9")].join() === "a.internal,10.9.9.9");
const serverFile = fileURLToPath(new URL("../src/server.ts", import.meta.url));
const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
  `const s = await import(${JSON.stringify(serverFile)}); for (const i of [1, 2]) { try { s.nodeBlocks({ node: "http://127.0.0.1:8789" }); console.log("passed"); } catch (e) { console.log(e.name, e.message); } process.env.CAIRNX_OWN_NODE_HOSTS = "csd"; }`],
  { env: { ...process.env, CAIRNX_OWN_NODE_HOSTS: "csd,csd:8789" }, encoding: "utf8" });
const lines = child.stdout.trim().split("\n");
ok("on a server, a list out of form throws at the first use and again at the next, even for a loopback node and with the variable fixed in between", lines.length === 2 &&
  lines.every((l) => l.startsWith("ReplicaConfigError CAIRNX_OWN_NODE_HOSTS:") && l.includes('"csd:8789"')), child.stdout + child.stderr);

done("cairnx-replica node address");
