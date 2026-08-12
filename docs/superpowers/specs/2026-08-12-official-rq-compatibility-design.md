# Official `rq` Compatibility Design

## Goal

Restore daily ranked-stat collection after Blizzard changed the official competitive-mode request value from `rq=2` to `rq=1`, without changing the repository's stored JSON contract or weakening contamination guards.

## Confirmed root cause

- The official rates UI currently exposes `rq=0` for Quick Play and `rq=1` for Competitive.
- A request using the collector's former `rq=2` value returns HTTP 200 but reports `rates.selected.rq` as `0`, produces the same hero values as Quick Play, and has no positive BAN rates.
- A request using `rq=1` reports `rates.selected.rq` as `1`, differs from Quick Play, and returns positive BAN rates.
- The official page still uses `/ja-jp/rates/data/`; the endpoint did not move. Only the competitive request value changed.
- Runs from 2026-08-07 through 2026-08-11 completed the request matrix and were then blocked by the existing ranked-axis contamination guard. No snapshot or commit was produced.

## Approaches considered

### 1. Translate the request value while preserving the stored value — selected

Keep `snapshots[].filters.rq === "2"` as the repository's stable, canonical representation of ranked data. Translate only the outgoing official request to `rq=1`. Validate the official response's `rates.selected` object against the translated request before parsing or saving it.

Advantages:

- Preserves compatibility with existing snapshots and unknown downstream consumers.
- Limits the production change to the collector.
- Detects future silent fallback immediately instead of after the complete 1,674-request run.

Trade-off:

- The collector must explicitly distinguish canonical stored filter values from official request values.

### 2. Change stored snapshots to `rq=1` — rejected

Use `rq=1` both for requests and saved filters.

This is simpler internally, but it changes the established JSON contract and could break downstream consumers that identify ranked snapshots with `rq=2`. Other repositories are outside this task's scope, so their compatibility cannot be changed or verified here.

### 3. Discover the value dynamically from official HTML — rejected

Fetch and parse the rates page's mode `<select>` before every collection run.

This would follow future numeric changes automatically, but adds a localized HTML dependency, an extra request, and ambiguity about which option is semantically equivalent to the repository's canonical ranked mode. A silent label or markup change could select the wrong mode.

## Architecture

The collector will retain two representations:

- Canonical filter: the existing stored filter using `rq="0"` for Quick Play and `rq="2"` for ranked.
- Official filter: a request-only copy in which canonical ranked `rq="2"` is translated to the current official value `rq="1"`.

`buildUrl()` will construct the query from the official filter. The snapshot will continue to store the canonical filter, while its `url` records the actual official request URL.

After `fetchJson()` returns and before `parseRates()` runs, a response-selection validator will compare all available official axes (`input`, `map`, `region`, `role`, `rq`, and `tier`) with the official request. A missing or mismatched `rates.selected` value is a systemic contract failure and must abort the run immediately. It must not be converted into an ordinary per-filter failure that allows the remaining request matrix to continue.

The existing tier-collapse, ranked BAN, rq-equality, partial-failure, duplicate, payload, and commit logic remains unchanged and continues to operate on canonical filters.

## Data flow

1. Generate the existing canonical filter matrix: 2 inputs × 31 maps × 3 regions × (QP 1 tier + ranked 8 tiers) = 1,674 filters.
2. Translate canonical `rq=2` to official `rq=1` only for URL construction.
3. Fetch the official JSON response with the existing headers and retry policy.
4. Verify `rates.selected` matches the official request.
5. Parse hero rows and apply existing row-completeness checks.
6. Store the canonical filter and actual request URL in the snapshot.
7. Apply existing tier/ranked guards, duplicate elimination, and persistence.

## Error handling

- A selected-filter mismatch must include the requested axis and returned value in the error message, but no token, secret, or environment value.
- The mismatch must stop immediately through the top-level error path.
- HTTP, JSON, or individual row failures retain the existing retry and 5% partial-failure behavior.
- Existing BAN and rq-equality guards remain defense in depth; they are not relaxed.

## Testing

Add one offline `node:test` integration file that launches the real collector with a preloaded mock `fetch` implementation.

The test file will cover two behaviors:

1. Current official contract:
   - Quick Play requests use official `rq=0`.
   - Ranked requests use official `rq=1`.
   - Saved snapshot filters retain canonical `rq=2`.
   - The run succeeds with ranked BAN data and distinct tier signatures.
2. Silent fallback:
   - The mock returns `selected.rq=0` for a ranked request.
   - The collector exits non-zero with the selected-filter mismatch message before completing the request matrix.

Tests use a temporary output directory, `STATS_DATE_OVERRIDE`, `--delay-ms=0`, and a bounded filter limit. They make no network requests and leave no repository data files behind.

## Files and change budget

- Modify `fetch-hero-stats.mjs` for request translation, response-selection validation, and current explanatory comments.
- Add `tests/collector-rq-contract.test.mjs` for the offline integration coverage.
- No workflow, payload schema, dependency, migration, secret, or other repository changes.

Estimated production change: 20–40 lines in one file. Estimated test addition: 80–130 lines in one file. Migration count: 0.

## Verification and rollout

1. Observe the new test fail against the current collector for the expected `rq=2` request behavior.
2. Apply the minimal translation and validation implementation.
3. Run the focused test and `node --check fetch-hero-stats.mjs`.
4. Run a bounded dry collector check only if the official endpoint remains available; do not run the full matrix locally.
5. Inspect the diff and confirm no payload-contract changes.
6. After explicit operational approval, run the workflow once and inspect the generated snapshot before relying on the daily schedule.

