# Official `rq` Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore ranked-stat collection by translating the repository's canonical `rq=2` value to the official API's current `rq=1` value while preserving saved JSON compatibility and failing immediately on official filter fallback.

**Architecture:** Keep canonical filters unchanged in the payload and create a request-only official filter before URL construction. Validate `rates.selected` against that official filter before parsing rows; a mismatch follows a dedicated fatal error path instead of the collector's partial-failure path.

**Tech Stack:** Node.js 22, native `fetch`, ECMAScript modules, `node:test`, `node:child_process`

## Global Constraints

- Operate only in `D:\codex\_inspected\overwatch-hero-stats`.
- Keep text files UTF-8.
- Do not modify `web_overwatch`, Backend, articles, or images.
- Preserve `snapshots[].filters.rq === "2"` for ranked snapshots.
- Preserve the current payload schema and all existing tier, BAN, rq-equality, partial-failure, and duplicate guards.
- Add no dependencies, migrations, secrets, or workflow changes.
- Automated tests must use mocked responses and make no network requests.
- Do not run the full 1,674-request collector locally.

---

### Task 1: Translate canonical ranked requests without changing saved filters

**Files:**
- Create: `tests/collector-rq-contract.test.mjs`
- Modify: `fetch-hero-stats.mjs:56-140`

**Interfaces:**
- Consumes: canonical filter objects shaped as `{ input, map, region, role, rq, tier }`, where ranked uses `rq: "2"`.
- Produces: `toOfficialFilter(filter)` returning a copied filter with ranked translated to `rq: "1"`; `buildRequest(filter)` returning `{ officialFilter, url }`.

- [ ] **Step 1: Create the offline integration test harness and failing compatibility test**

Create `tests/collector-rq-contract.test.mjs` with this content:

```js
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..");
const COLLECTOR = resolve(REPO_ROOT, "fetch-hero-stats.mjs");
const TEST_DATE = "2099-01-01";
const MOCK_MODE = process.env.COLLECTOR_RQ_MOCK_MODE;
const AXES = ["input", "map", "region", "role", "rq", "tier"];
const TIERS = ["All", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"];

if (MOCK_MODE) {
  let requestCount = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    const officialRq = url.searchParams.get("rq");
    const isRanked = officialRq === "1";
    const tierIndex = Math.max(0, TIERS.indexOf(url.searchParams.get("tier")));
    const selected = Object.fromEntries(AXES.map((axis) => [axis, url.searchParams.get(axis)]));

    if (MOCK_MODE === "fallback" && isRanked) selected.rq = "0";

    requestCount += 1;
    console.log(`[mock-fetch] ${requestCount} rq=${officialRq}`);

    const body = {
      rates: {
        rates: [
          {
            id: "ana",
            cells: {
              name: "Ana",
              winrate: isRanked ? 50 + tierIndex / 10 : 45,
              pickrate: isRanked ? 10 + tierIndex / 10 : 5,
              banrate: isRanked ? 1 : 0,
            },
          },
        ],
        extrema: {},
        selected,
      },
      columns: [],
    };

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };
} else {
  function runCollector(mode, outDir) {
    return spawnSync(
      process.execPath,
      ["--import", THIS_FILE, COLLECTOR, "--limit=18", "--delay-ms=0"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          COLLECTOR_RQ_MOCK_MODE: mode,
          STATS_DATE_OVERRIDE: TEST_DATE,
          STATS_OUT_DIR: outDir,
        },
      }
    );
  }

  test("requests official rq=1 while preserving canonical rq=2 in saved snapshots", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-rq-"));
    try {
      const result = runCollector("valid", outDir);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      assert.equal(payload.filterPlan.capturedFilterCount, 18);
      assert.equal(payload.filterPlan.failedFilterCount, 0);

      const quickPlay = payload.snapshots.filter((snapshot) => snapshot.filters.rq === "0");
      const ranked = payload.snapshots.filter((snapshot) => snapshot.filters.rq === "2");
      assert.equal(quickPlay.length, 2);
      assert.equal(ranked.length, 16);
      assert.ok(quickPlay.every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === "0"));
      assert.ok(ranked.every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === "1"));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
}
```

- [ ] **Step 2: Run the focused test and verify the RED state**

Run:

```powershell
node --test tests/collector-rq-contract.test.mjs
```

Expected: FAIL in `requests official rq=1 while preserving canonical rq=2 in saved snapshots`. The current collector requests `rq=2`, the mock returns QP-like data, and the collector exits non-zero through an existing collapse guard.

- [ ] **Step 3: Add canonical/official constants and request translation**

In `fetch-hero-stats.mjs`, replace the mode comments and literals with:

```js
const CANONICAL_QUICK_PLAY_RQ = "0";
const CANONICAL_COMPETITIVE_RQ = "2";
const OFFICIAL_COMPETITIVE_RQ = "1";

const MODE_TIERS = [
  { rq: CANONICAL_QUICK_PLAY_RQ, tiers: ["All"] },
  { rq: CANONICAL_COMPETITIVE_RQ, tiers: COMP_TIERS },
];
```

Document beside these constants that Blizzard changed the official competitive request value to `1` on or before 2026-08-07, while canonical `2` is retained for payload compatibility.

Replace `buildUrl(filter)` with:

```js
function toOfficialFilter(filter) {
  return {
    ...filter,
    rq: filter.rq === CANONICAL_COMPETITIVE_RQ ? OFFICIAL_COMPETITIVE_RQ : filter.rq,
  };
}

function buildRequest(filter) {
  const officialFilter = toOfficialFilter(filter);
  const qs = new URLSearchParams(officialFilter).toString();
  return { officialFilter, url: `${DATA_ENDPOINT}?${qs}` };
}
```

In the collection loop, replace:

```js
const url = buildUrl(filter);
```

with:

```js
const { url } = buildRequest(filter);
```

Keep `snapshots.push({ filters: filter, ... })` unchanged so stored ranked filters remain canonical `rq="2"`.

- [ ] **Step 4: Run the focused test and verify the GREEN state**

Run:

```powershell
node --test tests/collector-rq-contract.test.mjs
```

Expected: PASS, with one test passing and no network access.

- [ ] **Step 5: Commit the compatibility translation**

```powershell
git add fetch-hero-stats.mjs tests/collector-rq-contract.test.mjs
git commit -m "fix(stats): translate ranked rq for official API"
```

---

### Task 2: Abort immediately when the official response falls back to another filter

**Files:**
- Modify: `tests/collector-rq-contract.test.mjs`
- Modify: `fetch-hero-stats.mjs:138-162`
- Modify: `fetch-hero-stats.mjs:329-353`

**Interfaces:**
- Consumes: `officialFilter` from `buildRequest(filter)` and the official JSON response.
- Produces: `assertOfficialSelection(json, expectedFilter)`; throws `OfficialFilterSelectionError` with a mismatch description.

- [ ] **Step 1: Add the failing silent-fallback test**

Inside the non-mock `else` block in `tests/collector-rq-contract.test.mjs`, add:

```js
test("aborts immediately when official selected filters differ from the request", async () => {
  const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-rq-fallback-"));
  try {
    const result = runCollector("fallback", outDir);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /公式応答の選択値が要求と不一致/);
    assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, 2);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run only the fallback test and verify the RED state**

Run:

```powershell
node --test --test-name-pattern="aborts immediately" tests/collector-rq-contract.test.mjs
```

Expected: FAIL because the translated collector currently ignores `rates.selected`, completes all 18 mock requests, and exits successfully.

- [ ] **Step 3: Add the fatal official-selection validator**

Add near the request helpers in `fetch-hero-stats.mjs`:

```js
const FILTER_AXES = ["input", "map", "region", "role", "rq", "tier"];

class OfficialFilterSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfficialFilterSelectionError";
  }
}

function assertOfficialSelection(json, expectedFilter) {
  const selected = json?.rates?.selected;
  if (!selected || typeof selected !== "object") {
    throw new OfficialFilterSelectionError("公式応答に rates.selected がありません。保存を中断します。");
  }

  const mismatches = FILTER_AXES.filter(
    (axis) => String(selected[axis]) !== String(expectedFilter[axis])
  );
  if (mismatches.length === 0) return;

  const details = mismatches
    .map(
      (axis) =>
        `${axis}: requested=${JSON.stringify(expectedFilter[axis])}, selected=${JSON.stringify(selected[axis])}`
    )
    .join("; ");
  throw new OfficialFilterSelectionError(
    `公式応答の選択値が要求と不一致です (${details})。保存を中断します。`
  );
}
```

In the collection loop, retain the official filter and validate immediately after the fetch:

```js
const { officialFilter, url } = buildRequest(filter);
```

```js
const json = await fetchJson(url);
assertOfficialSelection(json, officialFilter);
const { heroes, slugCount, rowCount } = parseRates(json);
```

At the start of the loop's `catch` block, add the fatal path before ordinary failure collection:

```js
if (err instanceof OfficialFilterSelectionError) throw err;
```

- [ ] **Step 4: Run the fallback test and verify the GREEN state**

Run:

```powershell
node --test --test-name-pattern="aborts immediately" tests/collector-rq-contract.test.mjs
```

Expected: PASS. The child process exits with status 1 after exactly two mocked requests and reports the selected-filter mismatch.

- [ ] **Step 5: Run the complete offline test file**

Run:

```powershell
node --test tests/collector-rq-contract.test.mjs
```

Expected: PASS with two tests passing.

- [ ] **Step 6: Commit the response-selection guard**

```powershell
git add fetch-hero-stats.mjs tests/collector-rq-contract.test.mjs
git commit -m "fix(stats): reject official filter fallback"
```

---

### Task 3: Verify syntax, live bounded behavior, and repository scope

**Files:**
- Verify: `fetch-hero-stats.mjs`
- Verify: `tests/collector-rq-contract.test.mjs`
- Verify: `.github/workflows/hero-stats.yml` remains unchanged

**Interfaces:**
- Consumes: the completed collector and offline integration tests.
- Produces: verification evidence for syntax, current official compatibility, payload-contract preservation, and change scope.

- [ ] **Step 1: Verify JavaScript syntax**

Run:

```powershell
node --check fetch-hero-stats.mjs
node --check tests/collector-rq-contract.test.mjs
```

Expected: both commands exit 0 without output.

- [ ] **Step 2: Re-run the complete offline suite**

Run:

```powershell
node --test tests/collector-rq-contract.test.mjs
```

Expected: PASS with two tests passing and zero failures.

- [ ] **Step 3: Run a bounded live dry check**

Run:

```powershell
npm run stats:fetch -- --dry --limit=18 --delay-ms=1000
```

Expected: 18/1,674 requests complete, each response passes `rates.selected` validation, canonical ranked tiers do not collapse, ranked BAN data is present, and `[--dry] 保存しません` is printed. This command makes 18 official requests and writes no snapshot.

- [ ] **Step 4: Verify change scope and formatting**

Run:

```powershell
git diff HEAD~2 --check
git diff HEAD~2 --stat
git status --short --branch
```

Expected: no whitespace errors; only `fetch-hero-stats.mjs` and `tests/collector-rq-contract.test.mjs` differ across the two implementation commits; the branch is ahead only by the design, plan, and implementation commits with no uncommitted files.

- [ ] **Step 5: Stop before external rollout**

Report the local verification evidence and request action-time confirmation before any push or `workflow_dispatch`. Do not change secrets, repository settings, or workflow permissions.

