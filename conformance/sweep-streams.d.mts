// Types of sweep-streams.mjs for the TypeScript tests.
import type { CairnXState, ChainEvent } from "../packages/cairnx/src/index.js";

type Core = typeof import("../packages/cairnx/src/index.js");

export interface SweepStream {
  key: string;
  label: string;
  events: ChainEvent[];
  tipHeight: number;
  /** further tips, as in growth-streams.mjs; empty here */
  tips: number[];
  /** what the stream was built to show and the state misses; empty when every expectation holds */
  expect(resolveAt: (h?: number) => CairnXState): string[];
}

export declare function sweepStreams(R: Core): SweepStream[];
export declare function upTo(events: readonly ChainEvent[], t: number): ChainEvent[];
export declare function denseTips(events: readonly ChainEvent[], tip: number, EPOCH_LEN: number, extra?: readonly number[], span?: number): number[];
export declare function inertEvents(heights: readonly number[], tag?: string): ChainEvent[];
export interface ExpiryKinds { offer: boolean; bid: boolean; reservation: boolean; recapture: boolean; v21: boolean }
export declare function dueHeights(R: Core, events: readonly ChainEvent[]): number[];
export declare function expiryKinds(R: Core, events: readonly ChainEvent[], state: CairnXState): ExpiryKinds;
export interface MalformedKinds { offer: boolean; bid: boolean; reservation: boolean; recapture: boolean; crossV21: boolean; aboveV21: boolean; nanOffer: boolean }
export declare function stringifyNumbers(value: unknown): string;
export declare function parseNumbers(text: string): unknown;
export declare function malformedKinds(R: Core, events: readonly ChainEvent[], state: CairnXState): MalformedKinds;
