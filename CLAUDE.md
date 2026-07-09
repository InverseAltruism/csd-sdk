> Onboarding briefing for coding agents and contributors. `AGENTS.md` is the canonical briefing and this file imports it; edit `AGENTS.md` only. Production and operations specifics are intentionally out of scope here and maintained privately.

# CLAUDE.md (csd-sdk)

The full technical briefing for this repo lives in `AGENTS.md` (the L0 consensus SDK monorepo: packages, gates, invariants, dev/test/publish, incident history, cross-repo map). It is the single source of truth; read it first and keep both files in sync by editing `AGENTS.md`.

@AGENTS.md

## Claude Code operating notes

- **This repo IS the consensus. A wrong byte here forks the chain's app layer.** Single most important red line: byte-identity with the Rust node is the prime invariant. Any change to tx/sighash/header bytes, LWMA/chainwork, merkle acceptance, or the CairnX replay must be recorded in `CONSENSUS_CHANGES.md`, pinned by a golden vector BEFORE landing, and height-gated. Run `pnpm run audit:all` before any change to `packages/cairnx/src/*` or a new gate.
- `pnpm publish` NEVER `npm publish`; build before testing (tsx tests import sibling dists); package versions are independent (bump only what you changed); intra-workspace deps stay `workspace:*`.
- Keep the Python oracle (`conformance/cairnx_ref.py`) independent (written from spec, never transliterated from the JS).
- No em dashes / AI-slop in user-facing docs. Security fixes must not regress UX. Commits, tags, and publishes are maintainer-gated; never speculative.
