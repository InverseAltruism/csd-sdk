# @inversealtruism/cairnx-api

The types, parameter parser, cursor codec and pure handlers of the CairnX read API, version 1: six paged list reads
of CairnX state (`names`, `bids`, `tokens`, `events`, `holders`, `offers`). It does no I/O and imports no Node
built-in, so it runs in a browser. Its rows are `@inversealtruism/cairnx-core`'s state types, and cairnx-core is an
exact peer dependency: install the cairnx-core version this package was published against; any other installs a
second core or runs this package on a core it was not built against.

## What 0.1.2 is

- The handlers and types the CairnX resolver, its first consumer, will mount to answer the six reads.
- Not a live HTTP API: as of 0.1.2 no public route serves these reads.
- Not the 1.0 contract: until 1.0.0, any release may change a route, a parameter, a row or envelope field, an error
  code or a cursor grammar, and CHANGELOG.md names each change. What an answer of the public API promises, and the
  notice before a field or route is retired, start on the day the API's documentation is published, not with a
  package version.

The rest of this file describes 0.1.2 as built: 0.1.0's API, on cairnx-core 0.2.9.

## What an answer means

Every page carries `level: 1` (a refusal carries no level). That is the reader's position, not a claim of the server:
an answer over HTTP from someone else's process is display (CairnX `CONVENTION.md` section 37), whatever that process
ran.

From a 200 a caller may conclude: this server states that its replay of the records it read, up to block `at`, gives
these rows. It may not conclude that `at` is on the chain with the most work or will stay there (it is the server's
tip, depth 0); that the server read every record or bound every author (it replays a feed, complete only on its
word); or that a row holds after `at`. An answer may be a reason to refuse a signature or a credit and is never the
reason to allow one. A missing row is never an error: `rows` is empty.

## Exports (`.`)

- `CAIRNX_API_VERSION`: this package's version, one of the inputs of every `rev`.
- `At`, `Page<R>`, `Refusal`, `RefusalError`, `Answer<R>`: the envelope. `at` is `{ height, hash, rev }`, the block
  whose state the answer describes and, with `rev`, the state itself; `rev` is opaque and never compared across
  servers. A walk ends on `next === null` and on nothing else; `total` is optional and never ends a walk.
- `NameRow`, `TokenRow`, `OfferRow`, `BidRow`, `HolderRow`, `EventRow`, `RowOf`: the rows. `EventRow` is
  `{ txid, height, pos, kind, applied, code }`, without the log's note text. In place of cairnx-core's unbounded
  arrays:
  - `OfferRow.fillCount`: the number of fills the resolver applied to the offer: the length of the core's `fills` on a
    partially fillable offer, else 1 when the core's `fill` is set (a whole fill), else 0. A filled offer never reads 0.
  - `BidRow.offerCount`: the number of offers anchored in response to the bid: offers whose record names this bid and
    that were created while the resolver held it.
- `Open<T>`: a value of an open set, the known values and any other string. The offer and bid `status`, a token's
  `mint`, an event's `code` and a refusal's `code` are open: a newer server may send a value this release does not
  name, so a consumer must handle an unknown value (an unknown code by `applied` or by the HTTP status).
- `ERRORS`, `ERROR_CODES`, `statusOf`, `ErrorCode`: each refusal code with its one HTTP status and the side that
  answers it. A client treats a code it does not know by its status.

  | Code | Status |
  |---|---|
  | `INVALID_QUERY` (with `param`), `INVALID_PATH` | 400 |
  | `NOT_FOUND` | 404 |
  | `METHOD_NOT_ALLOWED` | 405 |
  | `SNAPSHOT_NOT_HELD` (with the newest `at` held) | 409 |
  | `RATE_LIMITED` (with `retryAfter` in seconds) | 429 |
  | `INTERNAL` | 500 |
  | `UPSTREAM_UNAVAILABLE`, `RESPONSE_TOO_LARGE` | 502 |
  | `NOT_READY` | 503 |

  `answer` returns four of them: `NOT_FOUND`, `INVALID_QUERY`, `SNAPSHOT_NOT_HELD` and `NOT_READY`.
  `METHOD_NOT_ALLOWED` and `INTERNAL` are for the host to send, and `INVALID_PATH`, `RATE_LIMITED`,
  `UPSTREAM_UNAVAILABLE` and `RESPONSE_TOO_LARGE` for a proxy in front of it; this package only names them. A proxy
  may also answer `NOT_FOUND` and `METHOD_NOT_ALLOWED` itself (`ERRORS` marks both `from: "both"`).

- `ROUTES`, `isRoute`, `ROUTE_TABLE`, `paramsOf`, `LIMIT_DEFAULT`, `KEYS_MAX`, `NAME_STATUSES`, `OFFER_STATUSES`,
  `BID_STATUSES`, `OFFER_KINDS`: the closed parameter table of each route, as data.
- `parseQuery(route, query)`: the parser. It returns `{ ok: true, query }`, typed per route and order, or
  `{ ok: false, error }` with `code: "INVALID_QUERY"` and `param` naming the refused parameter. A parameter outside
  the route's table, given twice, empty, malformed or out of range is refused, never ignored, so a parameter added
  later is refused by an older server rather than answered with unfiltered rows. `param` echoes a name only when it
  is 1 to 16 lowercase letters, the shape of every name in the table, and is `"(not shown)"` otherwise; `message`
  quotes no input. Pass the raw query string or `URL.searchParams`, never a record from a query parser, which merges
  a repeated parameter. Any other `query`, or a route outside the six, throws a `TypeError`.
- `CURSORS`, `CursorCodec` and the key types: the cursor of each list order, with `encode`, `decode`, `compare` and
  `of(row)`. A cursor is only a position: a cursor of another list or snapshot that fits the grammar is valid
  (`44682:2` is an `events` cursor and a `newest` names cursor alike).

## Handlers (`./handlers`)

For a host that answers these reads (the CairnX resolver is the first): the v1 reads over a prepared view. No I/O, no
clock, no randomness: equal inputs give byte-equal answers.

- `prepareView(state, { height, hash, input, core })`: once per published state, builds every served list's rows in
  each order, the key indexes and the counts, and `at` with its `rev`. `height` is the state's `tipHeight`, `hash`
  that block's hash, `input` the host's identity of its event list (it must change whenever the list does: the
  service's replay fingerprint, a replica's events hash), `core` the cairnx-core version the process loaded. `rev` is
  the first 16 hex digits of sha256 over `input`, `core` and this package's version, joined by newlines. The state is
  read during the call only and never written; the view shares no object with it and is frozen at every depth.
  Throws a `TypeError` on a malformed source (a height that is not the state's tip, a malformed hash, an empty input,
  a newline in `input`, a `core` that is not a version).
- `answer(held, route, query)`: `held` is the views the host holds, newest first; `query` is the raw query string or
  `URL.searchParams`, never a parsed record (it merges a repeated parameter that must be refused). It returns
  `{ status, body }`, a fresh plain object that shares nothing with the view:
  - a route outside the six: 404 `NOT_FOUND`; a refused parameter: the parser's 400; no view held: 503 `NOT_READY`;
  - `at` absent: the newest view; else the newest view with that height and hash (and that `rev` when given), or 409
    `SNAPSHOT_NOT_HELD` with the newest `at` in the body;
  - a page: the filtered rows in the list's order after `after` (sought by comparing keys, so a cursor whose row is
    gone still finds its place), `limit` of them, `next` from a lookahead at the next matching row (null on the last
    page, full or not), and `total`, the count of rows matching the filters. A page never ends between two rows of
    one sort key, since `after` names a key and the next page starts past it: when the rows after the limit share
    the last row's key, the page holds them too. Only `events` can have such rows (below);
  - `keys`: the rows that exist, every row of each key, in the list's default order, a key with no row absent,
    `total` their count.

What each list reads from the state:

- `names`, `bids`, `tokens`, `offers`: the rows of `state.names`, `state.bids`, `state.tokens` and `state.offers`.
  `offers?kind=` matches what the offer gives (`name` or `token`). A name offer has no partial fills: only an offer
  with `min` carries `fills`, and cairnx-core's record rule admits `min` on a token offer only (`records.ts`). So a
  name offer's `fillCount` is 0 or 1, and a name listing loses nothing by the missing `fills`.
- `events`: the applied log, every entry once, in (height, pos) order. The log array itself is in apply order (a
  block's Proposes first, and from V14 a block's deferred cancels at its end), so it is sorted, and entries of one
  key keep their log order. Below V29 a repeated event is applied and logged again at the same (height, pos); the
  feed shows each copy, `keys` returns every entry of a transaction id, and a page never splits them. The entries
  at heights up to h are the same in every later state of one branch under one core: no rule of the replay reads
  the tip.
- `holders`: for the required `ticker`, the addresses of `state.balances[ticker]`, which holds no address whose
  available and locked amounts are both zero (cairnx-core's `resolve.ts` leaves them out).
  A ticker with no balances, unknown or a token never held, reads an empty list and adds nothing to the view: the
  view has one entry per ticker the state holds and is frozen.

Size of an answer. A row is bounded: every string in it is fixed-width (an address, a hash, a decimal) or was carried
by one record of at most `MAX_RECORD_BYTES` (a name, a ticker, a token's name or metadata hash, a whole profile), so a
row's size does not grow with the state. A page holds `limit` rows plus the remaining rows of its last row's key, and
a `keys` read every row of each key it names. On every list but `events` a key has one row, so the excess is 0; on a
feed without repeated events it is 0 on `events` too. cairnx-core drops a repeated event id at or above V29 (88,000;
`resolve.ts`), so a repeated event exists only in the history below V29, with as many copies as the host's feed
carried. The one other way to a key of several entries is a feed with two transactions at one position, which no event
list of CONVENTION section 33 holds: `pos` is a transaction's index in its block.

Cost per request: an unfiltered page or a `keys` read is a binary search and a copy of the rows it returns; a
filtered page scans the list until the page fills, and with an `owner` filter counts every row for `total` (every
other filter's count, each `status` and `kind` of offers alone and together included, is counted once per view).

## Parameters

Every route takes `at`, `keys`, `after` and `limit`.

- `at=<height>:<hash>[:<rev>]`: the height in its one decimal spelling, at most 15 digits, the block hash as
  `0x` and 64 lowercase hex digits, `rev` as 16 lowercase hex digits. Upper-case hex is refused, never normalised.
- `limit`: 1 to 200 (1 to 500 on `events`); absent, 100; out of range is refused, never clamped.
- `keys`: 1 to 32 distinct primary keys, comma-separated (names; ids for `offers` and `bids`; tickers; transaction ids
  for `events`; addresses for `holders`). With `keys`, every other parameter but `at` and the required `ticker` of
  `holders` is refused.
- `after`: the cursor of the list's order. A height or a position in it is at most 15 digits.

| Route | Order and `after` | Filters |
|---|---|---|
| `names` | `order=name` (default): `<name>`; `order=newest` (height desc, name asc): `<height>:<name>` | `owner` (address), `status` (`held`, `pending`, `lapsed`) |
| `bids` | height desc, id asc: `<height>:<id>` | `status` (`open`, `cancelled`, `expired`, `done`) |
| `tokens` | ticker asc: `<ticker>` | |
| `events` | height asc, pos asc: `<height>:<pos>` | |
| `holders` | available + locked desc, address asc: `<amount>:<address>` | `ticker`, required |
| `offers` | height desc, id asc: `<height>:<id>` | `status` (`open`, `filled`, `cancelled`, `expired`), `kind` (`name`, `token`) |

Names, tickers, addresses and hashes are checked with cairnx-core's `NAME_RE`, `TICKER_RE`, `ADDR_RE` and `HASH_RE`;
decimals with its `AMOUNT_RE`. Strings order bytewise; `names` order by name is not the order of the state object,
which lists integer-like names first.
