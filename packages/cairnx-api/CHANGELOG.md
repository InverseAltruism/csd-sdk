# Changelog

## Unreleased

- 0.1.2, a peer-only step: cairnx-core 0.2.9 is the exact peer. No route, parameter, row, envelope field, error code or
  cursor grammar changed; `rev` moves with the package version.

## 0.1.1

- A peer-only step: cairnx-core 0.2.8 is the exact peer. No route, parameter, row, envelope field, error code or cursor
  grammar changed; `rev` moves with the package version, as it does at every release.

## 0.1.0 (2026-11-19)

- First release, made for one consumer: the CairnX resolver, which is to mount the handlers. No public HTTP route
  serves these reads yet, and this is not the 1.0 contract: any part of it can change in any release before 1.0.0.
- Entry `.`, the types and parser of the CairnX read API, version 1, as they stand before 1.0: the envelope (`At`, `Page`, `Refusal`), the
  rows of the six lists over cairnx-core's state types (`fillCount` and `offerCount` in place of the unbounded
  arrays, no note text in `EventRow`, the growable status and mint unions `Open`), the error codes with their HTTP
  statuses, the closed parameter table of each route and `parseQuery`, which refuses an unknown, repeated, empty,
  malformed or out-of-range parameter with its name (heights and positions at most 15 digits), the cursor codec of
  each list order, and `CAIRNX_API_VERSION`. cairnx-core is an exact peer dependency.
- `./handlers`: `prepareView(state, { height, hash, input, core })`, the frozen view of one published state with
  `rev`, and `answer(held, route, query)`, the `{ status, body }` of a v1 read of any of the six lists from the views
  held. `events` is the applied log in (height, pos) order, each entry once; `holders` reads an unknown ticker as an
  empty list and adds nothing to the view; `offers` filters on `status` and `kind`. A page never ends between two rows
  of one key, so a repeated event below V29 is never split across pages. Dependency: `@noble/hashes`, at
  cairnx-core's version.
