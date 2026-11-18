# Release and publish

How a package version reaches npm, and what the scripts on that path check. The rules a contributor must follow are in
`AGENTS.md` ("Packaging and publishing"); this file holds the mechanism behind each. The step lists for a
consensus-touching release and for a new gate or fee tier are at the bottom of `CONSENSUS_CHANGES.md`.

## What `scripts/check-lockstep.mjs` enforces

- Intra-workspace deps are `workspace:*`; pnpm rewrites them to exact versions at pack time. No caret ever ships.
- Published pins: every package version already on npm pins the current workspace versions of its deps and of its
  exact peers (cairnx-core under cairnx-api and the replica), so a core bump needs a bump of every package that peers
  on it. `test/check-lockstep.test.ts` covers the peer case.
- Published dist: for a version already on npm, the registry tarball (sha512-verified) holds byte-identical `dist/`
  files to this tree's build, so a source change needs a version bump. It detects that accident (one version, two code
  states), not a hostile tarball crafted to extract differently under npm and not a newly published version. The
  reader in `scripts/published-dist.mjs` refuses every archive shape `pnpm pack` does not emit. It compares files, not
  a whole-tarball hash, because pnpm orders the packed package.json dependencies nondeterministically (see
  `docs/incidents/README.md`). `test/published-dist.test.ts` covers the reader.
- Dist freshness: `dist/` is not older than `src/`, for versions not yet on npm.
- A package with a CHANGELOG.md lists it in `files`, since pnpm pack does not add it.

## The npm window (`scripts/npm-window.mjs`)

Check mode (the default, `node scripts/npm-window.mjs [--out <dir>]`) publishes nothing. It:

- lists every workspace version the HEAD commit's manifests name that is not yet on npm, dependencies first;
- packs each with `pnpm pack` (prepack builds dist/);
- runs the publish guard on each (`pnpm run prepublishOnly`: lockstep, the package suite, test:crosslang for
  cairnx-core);
- runs `scripts/verify-tarball.mjs` on each tarball: the manifest is the HEAD commit's package.json with `workspace:*`
  resolved to the versions HEAD's manifests name and only the scripts pnpm drops when packing removed, the
  package.json on disk has the commit's scripts exactly, every other file outside dist/ is the HEAD commit's, byte for
  byte, and every committed file a `files` entry covers is in the tarball, so an ignored, untracked or skip-worktree
  file, or a manifest rolled back on disk, fails; dist/ is the tree's build;
- writes SHA1SUMS and SHA256SUMS.

Run mode (`--out <dir> --run --token-file <path>`) also needs a clean tree whose HEAD is reachable from
`origin/master` (as last fetched; a pushed topic branch does not qualify) and a typed `publish`. It then copies each
verified tarball into its private directory, refuses before any npm call if a copy is not the bytes verify-tarball
checked, runs `npm publish` on that copy per package and compares each registry `dist.shasum` and `dist.integrity`
with the digests recorded at verification.

`test/npm-window.test.ts` pins this path, including that a failing guard, a failing verify-tarball, a HEAD off
`origin/master` or a tarball replaced after verification refuses the window.

### What the window does not bind

The window binds the tarball's files, the manifests, their scripts and the workspace pins to HEAD, not the build's
inputs: dist/ is built from src/ on disk with the build tools in node_modules, and a file changed there under
skip-worktree, or a changed tool, does not show in `git status`. So the maintainer runs a window only from a fresh
worktree created at the release commit, never from a working checkout:

```bash
git worktree add --detach <path> <commit>
cd <path>
pnpm install --frozen-lockfile --offline
pnpm -r build                    # check-lockstep refuses a package without dist/
```

npm-window does not itself check that it runs from such a worktree.

Accepted residual (owner rule, 2026-10-23: host-compromise fixes only where the chain decides): whoever can write that
worktree or the pnpm store while the window runs can change the build.

### Hooks

- `npm publish <tgz>` runs no package hook, so the prepublishOnly guard does not run on the window path; the script
  runs it.
- As a hook, `scripts/publish-guard.mjs` covers a publish from a package directory and refuses a non-pnpm client there
  (raw npm once shipped unresolved `workspace:*`; see `docs/incidents/README.md`).
- Every package's prepack runs its build, so a packed tarball carries a dist built from the tree.

### The npm token

npm tokens are not stored. The maintainer supplies a one-time token per window in a mode-600 file outside the repo;
the window script copies it into a userconfig in a private temporary directory, passes npm only that path, redacts it
from npm's output and removes the userconfig on exit. The maintainer deletes the file and revokes the token after the
window.

## Release tags

After a window, the maintainer tags each published version at the release commit with an annotated tag named
`<package name without the scope>-<version>`, such as `cairnx-core-0.2.7` or `cairnx-api-0.1.0`, and a message naming
the window, as the existing tags do (`git tag -a cairnx-api-0.1.0 <commit> -m "cairnx-api-0.1.0: published <date> in the
npm window from tarballs packed at this commit by scripts/npm-window.mjs"`), then pushes it.
`scripts/check-consumer-pins.mjs` reads them: a `cairnx-core-<version>` tag to grade a lagging core pin, and a
`cairnx-api-<version>` tag, whose cairnx-api manifest must name that version, for the cairnx-core version that
cairnx-api was packed against. Without the tag every consumer's check reports that version as unknown and fails.

## Versioning

Independent versioning (strict lockstep deliberately abandoned; do not re-litigate): bump the packages you changed and
every workspace package that depends on them, because a published version keeps the exact pins it shipped with.
Numbers need not match. A devDependency pin alone (csd-vectors is one for most packages) does not require a bump:
consumers never install a package's devDependencies, and check-lockstep compares `dependencies` and
`peerDependencies` only.

Consumers pin exact versions; a lockfile never resolves two different csd-codec copies (sign with one encoding, verify
with another).

Do not republish for docs alone; docs changes ride the next real release.
