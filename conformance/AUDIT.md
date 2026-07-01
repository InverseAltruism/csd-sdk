# Money-safety audit tooling and review method

Internal tooling and a review method for catching the class of bug the two-wallet races kept
surfacing: an honest user pays a fee, the base node anchors the fee output (it is a pure
data-anchor with only a feerate floor), and the off-chain resolver then rejects the record. The
fee is a real on-chain UTXO to the treasury and is never returned. Past audits scored "can an
attacker steal?" (almost always no) and missed this. These tools ask the right question: "did an
honest, correctly-formed record get rejected after its treasury fee was already anchored?"

Everything here is REPORT-ONLY. It ships nothing to users, adds no runtime guards, changes no
consensus code (the tools wrap the compiled resolver), and gates no release. It produces findings
we read and triage. Fixing any finding is a separate, per-item decision.

## The two tools

Run from `csd-sdk/`:

```
pnpm run audit:money-safety     # ranked table of anchored-then-rejected treasury/premium burns
pnpm run audit:race             # adversarial multi-actor race scenarios + property report + JS/PY diff
pnpm run audit:all              # money-safety --selftest, then the race harness
```

### money-safety.mjs
Wraps `resolve()` from the compiled `packages/cairnx/dist/index.js`. The resolver already returns
its applied-event log (`resolve().events = [{height,pos,id,kind,ok,note}]`, which `canonicalState`
strips) and every event carries `paidTo`. A burn is exactly a rejected event whose `paidTo` pays
the treasury. The tool does not enumerate record types: the treasury-output test covers every
fee-bearing record, including any future one. The ~0.25 CSD miner propose fee is separate from
`paidTo` and is not counted (it is the unavoidable cost of touching the chain at all).

Modes:
- default: run the built-in scenario corpus, print the ranked burn table.
- `--selftest`: additionally assert the DETECTOR classifies every scenario correctly. Exit 1 only
  if the tool itself is broken, never because a burn exists (a burn is an informational finding).
- `--stdin`: detect over your own sequences, `{"sequences":[{"label","events","tipHeight"}]}` on stdin.
  This is how a red-team agent feeds a hypothesized sequence in and gets a yes/no burn answer.

Export: `findBurns(events, tipHeight)` for use by other tools.

### race-harness.mjs
Automates the operator's method: several actors, including at least one adversarial actor
(name-blind pre-commit, back-dated displacement reveal, cancel-snipe, double-fill), acting at the
same and adjacent heights on a shared name and token set. Per scenario it reports four properties,
none of which throw a gate:

- P1 treasury-burn: a rejected record anchored a treasury or premium fee (`findBurns`).
- P2 displacement-burn: a paying registrant was displaced by a back-dated reveal (fee lost). This
  is the adversarial name-blind-commit class; `findBurns` alone misses it because the victim's own
  register applied before it was displaced.
- P3 payment-without-delivery: a rejected fill still paid the seller (buyer paid, got nothing).
- P4 byte-identity: JS `canonicalState` equals the independent Python resolver. Exit 1 on a real
  divergence (a consensus fork is genuinely must-fix). Run only on a settled tree: a mid-rebuild
  `dist` reads as a transient divergence.

The generators are gate-aware. Below V25 the name races use the old pay-now register (the loser
burns). At and above V25 they use the sealed flow (commit then payment-free reveal), so the loser
burns nothing. The summary prints a fix-health line asserting sealed-band (>= V25) name-race burns
are 0, the affirmative signal that the V25 sealed-reservation fix is holding. The adoption-gate
risk (an un-upgraded wallet sending a pay-now register above V25) is surfaced as its own labelled
class, not smeared across the others.

`--fixtures` runs only the seeded known-incident sequences (the W2 "test" register-race, the
blind-commit displacement pre and post V25, the double-fill). Consult these as a regression signal.

## Adding a scenario when a new bug is found
1. Reproduce it as a concrete event sequence in `race-harness.mjs` (a generator) or as a corpus
   entry in `money-safety.mjs`. If it does not reproduce against the compiled `dist`, it is not a
   finding.
2. Add it to `fixtures()` so it cannot silently regress.
3. If it is a new fee-bearing record type, confirm `money-safety.mjs` flags its rejection paths (the
   treasury-output test should cover it automatically).

## The red-team fan-out, run soundly
The fan-out is a discovery engine, not a verdict machine. Its value is finding niche things across a
large repo base; the discipline is that findings must be real, not plausible-sounding noise (past
audits both missed real bugs and over-produced inflated ones).

- Lens-diverse, not quantity: each agent owns one bug class (fee-burn-after-anchor,
  false-confirmation, stuck-state, double-spend, race-ordering, observability-gap) and attacks
  THROUGH the harness where it applies (a new sequence, a new invariant).
- Falsification: a finding is only reported when it reproduces as a concrete sequence against the
  compiled `dist`. Feed the candidate into `money-safety.mjs --stdin` or add a race generator.
- Adversarial verify: hand every claimed finding to a second agent tasked to refute it (find the
  existing guard, prove it fires). Only unrefuted, reproduced findings survive.
- Completeness critic closes each round: which rejection path, fee-bearing record, or
  wallet-unobservable state still has no coverage?
- Keep the two threat models separate and both covered: honest and adversarial actor races on an
  honest resolver (this harness), and hostile infrastructure (lying RPC, withholding resolver,
  poisoned snapshot, fee-ordering miner) versus the wallet's guards (the read below). The
  observability-gap lens is their shared root.

The output of a fan-out is a triaged findings report that informs a release audit. It does not gate
anything by itself. The gate stays the existing `test:crosslang` fork detection; these audit tools
are on-demand.

## Observability-gap review (the root-cause lens)
Half the incidents reduce to the client acting against state it cannot see or verify (the register
false-confirm, the V26 recapture reservation being invisible, the viaFill caution). For each
fee-bearing wallet or UI action, list the state the resolver checks that the client cannot currently
observe and verify. Each gap is a candidate finding. Concretely, walk every state read on a
fee-or-validity path in `packages/cairnx/src/resolve.ts` and map it to a client-observable source (an
endpoint plus an SPV verify path). Any unmapped read is a latent burn or false-confirm. This is a
read-only review, not new guard code, and it is the single most useful lens because it is the
generator of the whole class.

## Rubric
Score a finding on "who loses money or gets stuck, honest or not", not only "attacker-controlled".
A 15 to 300 CSD honest-user burn is HIGH. Reachability includes the two-account race as a
first-class path. Follow the fee: for every treasury-paying record, trace whether the output is
anchored before the resolver decides validity. Never propose a fix that adds latency or a decline to
a legitimate action (warn, fail-soft, availability valve).

Background and the full incident history: `cairn/docs/Plans/55-audit-and-test-plan-2026-07-01.md`.
