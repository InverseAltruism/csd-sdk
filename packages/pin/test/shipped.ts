// The package's plain JS scripts as its tests call them. They sit outside the typecheck (the generator imports
// conformance/chain-read.mjs, which carries no types), so they are loaded by URL and given these types here.
import type { Pin } from "@inversealtruism/cairnx-replica";
import type { BlockFixture } from "@inversealtruism/cairnx-replica/testing";

export type Descriptor = Omit<Pin, "log">;
export type Fixture = Pick<BlockFixture, "from" | "to" | "toHash" | "blocks"> & { readonly format?: 1 };
const load = async <T>(path: string): Promise<T> => (await import(String(new URL(path, import.meta.url)))) as T;

export const shipped = await load<{
  PIN_FILE: string; DELTAS: string; baseFile(): string; baseFixture(): BlockFixture; readDeltas(dir?: string): Fixture[];
  derive(base?: BlockFixture, deltas?: Fixture[]): Promise<{ pin: Descriptor; log: Uint8Array }>; differing(got: Descriptor, want: Descriptor): string[];
  derivedPin(pin: Descriptor, base?: BlockFixture, deltas?: Fixture[]): Promise<{ pin: Descriptor; log: Uint8Array }>;
}>("../scripts/shipped.mjs");
export const gen = await load<{
  generate(o: { rpc: string; anchor: { height: number; hash: string }; check?: boolean; fetch?: typeof fetch; base?: BlockFixture; deltas?: Fixture[];
    pin?: Descriptor | null; built?: Record<string, number> }): Promise<{ pin: Descriptor; delta: Fixture; text: string; file: string }>;
}>("../scripts/generate-pin.mjs");
export const chainRead = await load<{ renderFixture(f: Fixture): string }>("../../../conformance/chain-read.mjs");
