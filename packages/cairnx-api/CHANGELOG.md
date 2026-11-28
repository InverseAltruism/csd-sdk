# Changelog

## 1.0.1

- Peers on `@inversealtruism/cairnx-core` 0.2.11 exactly, and `CAIRNX_API_VERSION` is 1.0.1, so the `rev` a server
  emits names the new versions. No change to the routes, the rows, the envelope or the error codes.

## 1.0.0

The contract of version 1 of the read API. 0.1.3 was never published; its change is listed here.

- Promised from 1.0.0, on the date the documentation states (<https://cairn-substrate.com/docs#cairnx-v1-notice>):
  the six routes; each parameter's name, grammar and meaning; each list's orders and cursor grammars; the envelope's
  fields; each row field's name and meaning; the error codes with their statuses; what an answer means; what `rev`
  promises.
- The `rev` in `at` is an opaque token of 1 to 64 ASCII letters, digits, `.`, `_` and `-`, which a client echoes
  unchanged; that grammar is promised, and the length and alphabet of the token a server emits inside it are not.
  A well-formed `rev` a host does not hold is 409 SNAPSHOT_NOT_HELD with the newest `at`, never 400.
- Added in any release, without notice: a route, an optional parameter (an older server refuses it), a field, a value
  of an open set (a status, `mint`, an event's `code` or `kind`, an error code), a higher `limit` maximum.
- Refused today and open to a later release, so a client does not rely on the refusal: `order` on the five lists with
  one order, any parameter but `at` and a required filter beside `keys`, and more than 32 keys.
- Not promised: the `message` texts, the key order in the JSON, the default `limit`, the presence of `total` (sent on
  every page by these handlers), which refusal answers a request wrong in several ways, and anything about the hosts
  that serve the API (limits, availability).
- A route or a field (of a row or of the envelope) is removed only after it has been marked deprecated, with the date,
  in CHANGELOG.md and the documentation, and served unchanged for six months from that date; a change of meaning is a
  new API version, `/api/cairnx/v2/`.
- A cursor belongs to the list and order that gave it: sent to another whose grammar it fits, it reads as a position
  there and can read as an empty page. After a 409 a walk that must be consistent starts again from the first page
  under the new `at`, since a cursor carried over to a new `at` can repeat or miss rows; carrying a cursor forward is
  for following a list without `at`.
- cairnx-core stays an exact peer, so a host keeps one core: each cairnx-core release is followed by a cairnx-api
  release that peers on it, a 1.0.x when nothing else changes.

Changes since 0.1.2:

- `names` takes `order=length`: shortest name first, names of one length bytewise. Its cursor is `<length>:<name>`; a
  cursor whose length is not its name's is refused as INVALID_QUERY on `after`. The default order stays `name`.
- `at` takes any `rev` in the token grammar above; 0.1.2 refused as INVALID_QUERY every `rev` but 16 lowercase hex
  digits. The handlers still emit 16 lowercase hex digits.
- cairnx-core 0.2.10 is the exact peer.
- No route, parameter, row field, envelope field, error code or cursor grammar was removed or renamed. The order of
  every string key was bytewise before and is now pinned under foreign locales (`test/locale.test.ts`).
- `rev` moves with the package version, as at every release: after a host's upgrade an `at` with the `rev` of a 0.1.x
  answer is refused with 409 SNAPSHOT_NOT_HELD and the newest `at`, so a pinned walk starts again from page 1.

## 0.1.2

- A peer-only step: cairnx-core 0.2.9 is the exact peer. No route, parameter, row, envelope field, error code or
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
