# @inversealtruism/cairnx-api

The contract of the CairnX public read API, version 1: six paged list reads of CairnX state (`names`, `bids`,
`tokens`, `events`, `holders`, `offers`), with their row and envelope types, error codes, parameter grammar and
cursor codec. Not yet released. It does no I/O and imports no Node built-in, so it runs in a browser. Its rows are
`@inversealtruism/cairnx-core`'s state types, and cairnx-core is an exact peer dependency: install the cairnx-core
version this package was published against; any other installs a second core or runs this package on a core it was
not built against.

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
