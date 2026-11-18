# Changelog

## 0.1.0 (unreleased)

- The contract of the CairnX public read API, version 1, entry `.`: the envelope (`At`, `Page`, `Refusal`), the
  rows of the six lists over cairnx-core's state types (`fillCount` and `offerCount` in place of the unbounded
  arrays, no note text in `EventRow`, the growable status and mint unions `Open`), the error codes with their HTTP
  statuses, the closed parameter table of each route and `parseQuery`, which refuses an unknown, repeated, empty,
  malformed or out-of-range parameter with its name (heights and positions at most 15 digits), the cursor codec of
  each list order, and `CAIRNX_API_VERSION`. cairnx-core is an exact peer dependency.
