// The package's plain JS scripts as its tests call them. They sit outside the typecheck (checkJs would hold them to
// types they do not carry), so they are loaded by URL and given these types here.
export type Anchor = { height: number; hash: string };
export type Table = { format: 1; chunk: number; floor: Anchor; activationRoot: Anchor; anchors: Anchor[] };
export type Io = { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> };
type Walk = { tablePath?: string; chunk?: number; pageSize?: number; paceMs?: number; io?: Io };
const load = async <T>(path: string): Promise<T> => (await import(String(new URL(path, import.meta.url)))) as T;

export const tableMod = await load<{
  CHUNK: number; ACTIVATION_ROOT_HEIGHT: number; HASH_RE: RegExp; ROOT: string; TABLE: string;
  firstChunk(floorHeight: number, chunk: number): number; topOf(k: number, chunk: number): number;
  validateTable(t: unknown, chunk?: number): Table; renderJson(t: Table): string; parseTable(text: string, chunk?: number): Table;
  extensionFault(old: Table, next: Table): string | null;
}>("../scripts/table.mjs");
export const wallet = await load<{ renderSpvAnchors(t: Table): string; renderSpvNewest(t: Table): string }>("../scripts/render-wallet.mjs");
export const builder = await load<{ build(root?: string): Table }>("../scripts/build.mjs");
export const gen = await load<{
  MIN_MARGIN: number;
  validateC1(text: string, chunk: number, floor: Anchor): { height: number; hash: string; tip: number };
  generate(o: Walk & { c1Text: string; base: string; write?: boolean }): Promise<{ table: Table; text: string; entries: number; newest: number }>;
  check(o: Walk & { headers: string; rpc: string }): Promise<{ entries: number; newest: number; tip: number }>;
  parseArgs(argv: string[], env: Record<string, string | undefined>): Record<string, unknown>;
  main(argv: string[], env?: Record<string, string | undefined>, ctx?: Walk & { log?: (s: string) => void; err?: (s: string) => void }): Promise<number>;
}>("../scripts/generate-anchors.mjs");
