// The store conformance suite over memoryStore.
import { memoryStore } from "../src/index.js";
import { done, ok } from "./check.js";
import { storeSuite } from "./store-suite.js";

console.log("store suite, memoryStore:");
const checks = await storeSuite(() => memoryStore());
for (const c of checks) ok(c.name, c.ok);
ok("the suite ran its 32 checks", checks.length === 32);
done("cairnx-replica memoryStore");
