// Types of growth-streams.mjs for the TypeScript tests (a declaration beside a .mjs is what the compiler reads, so the
// module itself stays plain JavaScript like the rest of conformance/).
import type { CairnXState, ChainEvent } from "../packages/cairnx/src/index.js";

type Core = typeof import("../packages/cairnx/src/index.js");

export interface GrowthStream {
  key: string;
  label: string;
  events: ChainEvent[];
  tipHeight: number;
  /** further tips the whole stream is resolved at; some lie below its last event */
  tips: number[];
  /** what the stream was built to show and the state misses; empty when every expectation holds */
  expect(resolveAt: (h?: number) => CairnXState): string[];
}

export declare const FULL_SIZES: Readonly<Record<"S1" | "S2" | "S3" | "S4" | "S5" | "S6" | "S7", number>>;
export declare function registrations(R: Core, n: number): GrowthStream;
export declare function bids(R: Core, n: number): GrowthStream;
export declare function holds(R: Core, n: number): GrowthStream;
export declare function reservations(R: Core, n: number): GrowthStream;
export declare function recaptures(R: Core, n: number): GrowthStream;
export declare function ocancels(R: Core, n: number, m: number): GrowthStream;
export declare function displacements(R: Core, n: number, m: number): GrowthStream;
export declare function v21(R: Core): GrowthStream;
export declare function edges(R: Core): GrowthStream[];
export declare function growthStreams(R: Core, n: number): GrowthStream[];
export declare function fullGrowthStreams(R: Core): GrowthStream[];
export declare function resolverAt(resolve: (events: ChainEvent[], tipHeight: number) => CairnXState, s: GrowthStream): (h?: number) => CairnXState;
