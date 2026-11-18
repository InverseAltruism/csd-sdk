// Which node addresses count as one's own, the header root of a level 3 replica (design section 2). In a page:
// localhost, 127.0.0.1 or [::1]. On a server also the private literals 10/8, 172.16/12, 192.168/16, 100.64/10 and
// fc00::/7, and the hosts its operator lists in CAIRNX_OWN_NODE_HOSTS, which reach this module only from server.ts,
// so no request, URL parameter or stored value can name one. An address with credentials, a query or a fragment, or
// not http or https, is refused in both. A refusal names the host alone, never the credentials, path or query.
import { ReplicaConfigError } from "./errors.js";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

function urlOf(node: unknown): URL | null {
  try {
    return new URL(String(node));
  } catch (e) {
    if (e instanceof TypeError) return null;
    throw e;
  }
}
function parse(node: unknown): URL {
  const u = typeof node === "string" ? urlOf(node) : null;
  if (u === null || (u.protocol !== "http:" && u.protocol !== "https:") || u.username !== "" || u.password !== "" || u.search !== "" || u.hash !== "") {
    throw new ReplicaConfigError("node: not an http or https URL without credentials, query or fragment");
  }
  return u;
}
const base = (u: URL): string => `${u.origin}${u.pathname.replace(/\/+$/, "")}`;
const refuse = (u: URL, rule: string): never => { throw new ReplicaConfigError(`node: ${u.hostname} is not one's own node (${rule})`); };

function isPrivate(host: string): boolean {
  const v4 = /^([0-9]+)\.([0-9]+)\.[0-9]+\.[0-9]+$/.exec(host);
  if (v4 !== null) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v6 = /^\[([0-9a-f]{0,4}):/.exec(host);
  return v6 !== null && (Number.parseInt(v6[1] || "0", 16) & 0xfe00) === 0xfc00;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?";
const HOST_ENTRY = new RegExp(`^(?:${LABEL}(?:\\.${LABEL})*|\\[[0-9a-f:.]+\\])$`);
/** The host list of CAIRNX_OWN_NODE_HOSTS: comma-separated bare lowercase ASCII host names or IP literals, each in the
 *  form a URL's hostname takes (an IPv6 literal in brackets), empty entries skipped. Any other entry (a port, a scheme,
 *  a path, a trailing dot, upper case, non-ASCII, a form a URL rewrites) throws ReplicaConfigError naming it. */
export function parseHosts(v: string | undefined): ReadonlySet<string> {
  const out = new Set<string>();
  for (const raw of (v ?? "").split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    if (!HOST_ENTRY.test(entry) || urlOf(`http://${entry}/`)?.hostname !== entry) {
      throw new ReplicaConfigError(`CAIRNX_OWN_NODE_HOSTS: ${JSON.stringify(entry)} is not a bare lowercase host name or IP literal`);
    }
    out.add(entry);
  }
  return out;
}

/** The base URL of a loopback node, the one rule a page has. */
export function loopbackNode(node: string): string {
  const u = parse(node);
  return LOOPBACK.has(u.hostname) ? base(u) : refuse(u, "a page accepts localhost, 127.0.0.1 or [::1]");
}

/** The base URL of a loopback, private or listed node, the server's rule. */
export function serverNode(node: string, listed: ReadonlySet<string>): string {
  const u = parse(node), h = u.hostname;
  return LOOPBACK.has(h) || isPrivate(h) || listed.has(h) ? base(u) : refuse(u, "a server accepts loopback, a private range or CAIRNX_OWN_NODE_HOSTS");
}
