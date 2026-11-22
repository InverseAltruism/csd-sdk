// What the reference copy of the resolver's book (cairnx-tuple-c89ab86.ts) imports from two resolver modules that are
// not in this repository, written here with the behaviour that book depends on: `eventLine`, one event's bytes in its
// content digest (the event's JSON and a newline), and `replay`, cairnx-core's resolve() (the resolver's wrapper only
// counts and times its calls).
import { resolve, type CairnXState, type ChainEvent } from "@inversealtruism/cairnx-core";

export const eventLine = (e: ChainEvent): string => JSON.stringify(e) + "\n";
export const replay = (events: ChainEvent[], tipHeight: number): CairnXState => resolve(events, tipHeight);
