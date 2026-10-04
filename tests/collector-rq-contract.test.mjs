import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), "..");
const COLLECTOR = resolve(REPO_ROOT, "fetch-hero-stats.mjs");
const TEST_DATE = "2099-01-01";
const MOCK_MODE = process.env.COLLECTOR_RQ_MOCK_MODE;
const AXES = ["input", "map", "region", "role", "rq", "tier"];
const TIERS = ["All", "Bronze", "Silver", "Gold", "Platinum", "Emerald", "Diamond", "Master", "Grandmaster"];
const FILTERS_PER_INPUT_MAP_REGION = 1 + TIERS.length;
const FILTERS_PER_INPUT_MAP = FILTERS_PER_INPUT_MAP_REGION * 3;
const DEFAULT_TEST_GROUP_COUNT = 2;
const DEFAULT_TEST_LIMIT = FILTERS_PER_INPUT_MAP_REGION * DEFAULT_TEST_GROUP_COUNT;
const TOTAL_FILTER_COUNT = 2 * 31 * 3 * FILTERS_PER_INPUT_MAP_REGION;
const METRIC_CASES = [
  ...[-1, 100.01, -Infinity, Infinity, NaN, "-1", "100.01", "Infinity", "-Infinity", "NaN",
    "50garbage", "50%garbage", "", " ", "%", "--", null, undefined, true, false, [], {}, ["50"]]
    .map((value) => ({ value, expected: null })),
  ...[0, 100, "0", "100", "25.5%", " 42 % ", "12.5"]
    .map((value) => ({ value, expected: Number(String(value).trim().replace(/%$/, "")) })),
];

if (MOCK_MODE) {
  let requestCount = 0;
  const missingSelectionSeen = new Set();
  const requestsByUrl = new Map();
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const officialRq = url.searchParams.get("rq");
    requestCount += 1;
    console.log(`[mock-fetch] ${requestCount} rq=${officialRq}`);
    const urlAttempts = (requestsByUrl.get(url.href) ?? 0) + 1;
    requestsByUrl.set(url.href, urlAttempts);

    if (MOCK_MODE === "timeout") {
      return await new Promise((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }

    const supportedRankedRq = MOCK_MODE === "valid-rq1" || MOCK_MODE.includes("probe-rq1")
      ? "1"
      : ["fallback", "timeout"].includes(MOCK_MODE) ? null : "2";
    const isRanked = officialRq === supportedRankedRq;
    const tierIndex = Math.max(0, TIERS.indexOf(url.searchParams.get("tier")));
    const selected = Object.fromEntries(AXES.map((axis) => [axis, url.searchParams.get(axis)]));

    if (officialRq !== "0" && !isRanked) selected.rq = "0";
    const probeTarget = officialRq !== "0" &&
      url.searchParams.get("region") === "Americas" && url.searchParams.get("tier") === "All";
    if (MOCK_MODE === "probe-transport-persistent" && probeTarget) throw new Error("mock transport failure");
    if (MOCK_MODE === "selection-mismatch" && url.searchParams.get("region") === "Asia" &&
        url.searchParams.get("tier") === "Grandmaster") selected.input = "Console";

    const targetKey = `${url.searchParams.get("map")}|${url.searchParams.get("region")}|${url.searchParams.get("tier")}`;
    const missingWholeMap =
      MOCK_MODE === "missing-map" && ["Asia", "Europe"].includes(url.searchParams.get("region"));
    const missingGrandmaster =
      url.searchParams.get("tier") === "Grandmaster" &&
      ((MOCK_MODE === "missing-selected-once" && url.searchParams.get("region") === "Asia" && !missingSelectionSeen.has(targetKey)) ||
        (MOCK_MODE === "missing-selected-persistent" && url.searchParams.get("region") === "Asia") ||
        (MOCK_MODE === "missing-selected-axis" && ["Asia", "Europe"].includes(url.searchParams.get("region"))));
    const missingSelectionTarget =
      isRanked && url.searchParams.get("map") === "all-maps" && (missingWholeMap || missingGrandmaster);
    if (missingSelectionTarget) missingSelectionSeen.add(targetKey);

    const cells = {
      name: "Ana",
      winrate: isRanked ? 50 + tierIndex / 10 : 45,
      pickrate: isRanked ? 10 + tierIndex / 10 : 5,
      banrate: isRanked ? 1 : 0,
    };
    if (MOCK_MODE === "missing-metrics" && url.searchParams.get("tier") === "Grandmaster") {
      cells.winrate = "--";
      cells.pickrate = "--";
      if (isRanked) cells.banrate = "--";
    }

    const missingHeroTarget =
      MOCK_MODE === "missing-hero" &&
      isRanked &&
      url.searchParams.get("map") === "all-maps" &&
      url.searchParams.get("tier") === "Grandmaster";

    const body = {
      rates: {
        rates: [
          {
            id: "ana",
            cells,
          },
          ...(!missingHeroTarget
            ? [{
                id: "mercy",
                cells: { name: "Mercy", winrate: 50, pickrate: 10, banrate: isRanked ? 1 : 0 },
              }]
            : []),
        ],
        extrema: {},
        ...(missingSelectionTarget ||
          (MOCK_MODE === "probe-rq1-retried-rejection" && probeTarget && officialRq === "2" && urlAttempts < 3)
          ? {} : { selected }),
      },
      columns: [],
    };

    const parseTarget = isRanked &&
      (MOCK_MODE.startsWith("probe-") ? probeTarget :
        url.searchParams.get("region") === "Asia" && url.searchParams.get("tier") === "Grandmaster");
    if (parseTarget && (MOCK_MODE.includes("persistent") || MOCK_MODE.includes("retried-rejection") ||
        (MOCK_MODE.includes("transient") && urlAttempts < 3))) {
      if (MOCK_MODE.includes("empty") || MOCK_MODE === "probe-rq1-retried-rejection") body.rates.rates = [];
      if (MOCK_MODE.includes("missing-row-id")) body.rates.rates.push({ cells });
    }
    if (MOCK_MODE === "metric-normalization") {
      body.rates.rates.push(...METRIC_CASES.map(({ value }, index) => ({
        id: `metric-${index}`,
        cells: parseTarget ? { winrate: value, pickrate: value, banrate: value } :
          { winrate: 50, pickrate: 10, banrate: isRanked ? 1 : 0 },
      })));
      // JSON cannot encode NaN/Infinity; json() also exercises the numeric guard directly.
      return { ok: true, json: async () => body };
    }

    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  };
} else {
  function runCollector(mode, outDir, { limit = DEFAULT_TEST_LIMIT, fetchTimeoutMs, envExtra = {} } = {}) {
    return spawnSync(
      process.execPath,
      ["--import", pathToFileURL(THIS_FILE).href, COLLECTOR, `--limit=${limit}`, "--delay-ms=0"],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          COLLECTOR_RQ_MOCK_MODE: mode,
          STATS_DATE_OVERRIDE: TEST_DATE,
          STATS_OUT_DIR: outDir,
          ...(fetchTimeoutMs ? { STATS_FETCH_TIMEOUT_MS: String(fetchTimeoutMs) } : {}),
          ...envExtra,
        },
        timeout: 6000,
      }
    );
  }

  async function assertSelectedRankedRq(mode, expectedRq, expectedRequestCount) {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-rq-"));
    try {
      const result = runCollector(mode, outDir);
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, new RegExp(`公式競技モードを rq=${expectedRq} で確定`));
      assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, expectedRequestCount);

      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      assert.equal(payload.filterPlan.totalFilterCount, TOTAL_FILTER_COUNT);
      assert.deepEqual(payload.filterPlan.modeTiers[1].tiers, TIERS);
      assert.equal(payload.filterPlan.capturedFilterCount, DEFAULT_TEST_LIMIT);
      assert.equal(payload.filterPlan.failedFilterCount, 0);

      const quickPlay = payload.snapshots.filter((snapshot) => snapshot.filters.rq === "0");
      const ranked = payload.snapshots.filter((snapshot) => snapshot.filters.rq === "2");
      assert.equal(quickPlay.length, DEFAULT_TEST_GROUP_COUNT);
      assert.equal(ranked.length, TIERS.length * DEFAULT_TEST_GROUP_COUNT);
      assert.ok(quickPlay.every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === "0"));
      assert.ok(ranked.every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === expectedRq));

      const firstRankedGroup = ranked.filter(
        (snapshot) =>
          snapshot.filters.input === "PC" &&
          snapshot.filters.map === "all-maps" &&
          snapshot.filters.region === "Americas"
      );
      assert.deepEqual(firstRankedGroup.map((snapshot) => snapshot.filters.tier), TIERS);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }

  test("includes Emerald and uses official rq=2 while preserving canonical rq=2", async () => {
    await assertSelectedRankedRq("valid-rq2", "2", DEFAULT_TEST_LIMIT);
  });

  test("falls back to official rq=1 when rq=2 is rejected while preserving canonical rq=2", async () => {
    await assertSelectedRankedRq("valid-rq1", "1", DEFAULT_TEST_LIMIT + 1);
  });

  test("aborts when every official competitive rq candidate is rejected", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-rq-fallback-"));
    try {
      const result = runCollector("fallback", outDir);
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /公式競技モードを確定できません/);
      assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, 3);
      await assert.rejects(readFile(join(outDir, `${TEST_DATE}.json`), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("times out a stalled official request after three attempts without saving", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-timeout-"));
    try {
      const result = runCollector("timeout", outDir, { limit: 1, fetchTimeoutMs: 10 });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}\n${result.error ?? ""}`);
      assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, 3);
      assert.match(result.stderr, /公式API応答待ちが 10ms を超えました/);
      await assert.rejects(readFile(join(outDir, `${TEST_DATE}.json`), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("retries a transient missing rates.selected response and saves the complete set", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-selected-retry-"));
    try {
      const limit = FILTERS_PER_INPUT_MAP_REGION * 3;
      const result = runCollector("missing-selected-once", outDir, { limit });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stdout, /再試行成功/);
      assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, limit + 1);
      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      assert.equal(payload.filterPlan.capturedFilterCount, limit);
      assert.equal(payload.filterPlan.failedFilterCount, 0);
      assert.equal(payload.collectionQuality.status, "complete");
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("keeps a persistent missing-selected filter out of a partial snapshot", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-selected-partial-"));
    try {
      const limit = FILTERS_PER_INPUT_MAP_REGION * 3;
      const result = runCollector("missing-selected-persistent", outDir, { limit });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, limit + 2);
      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      assert.equal(payload.filterPlan.capturedFilterCount, limit - 1);
      assert.equal(payload.filterPlan.failedFilterCount, 1);
      assert.equal(payload.collectionQuality.status, "partial");
      assert.equal(payload.collectionQuality.failedFilters[0].code, "missing-selected");
      assert.equal(payload.collectionQuality.failedFilters[0].attempts, 3);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("preserves null metric values and records incomplete heroes", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-missing-metrics-"));
    try {
      const result = runCollector("missing-metrics", outDir, { limit: 18 });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      const affected = payload.snapshots.find((snapshot) => snapshot.filters.tier === "Grandmaster");
      assert.equal(affected.heroes.ana.win, null);
      assert.equal(affected.heroes.ana.pick, null);
      assert.equal(affected.heroes.ana.ban, null);
      assert.equal(payload.collectionQuality.status, "partial");
      assert.ok(payload.collectionQuality.missingMetricCount >= 3);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("normalizes invalid percentages to null while preserving zero, 100, and valid strings", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-metric-range-"));
    try {
      const result = runCollector("metric-normalization", outDir, { limit: 30 });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      const affected = payload.snapshots.find((snapshot) =>
        snapshot.filters.region === "Asia" && snapshot.filters.tier === "Grandmaster");
      assert.equal(affected.heroCount, METRIC_CASES.length + 2);
      for (const [index, { value, expected }] of METRIC_CASES.entries()) {
        assert.deepEqual(affected.heroes[`metric-${index}`],
          { win: expected, pick: expected, ban: expected }, `metric input ${String(value)}`);
      }
      assert.equal(payload.collectionQuality.status, "partial");
      assert.equal(payload.collectionQuality.incompleteSnapshotCount, 1);
      assert.equal(payload.collectionQuality.missingMetricCount,
        METRIC_CASES.filter(({ expected }) => expected === null).length * 3);
      assert.equal(payload.collectionQuality.failedFilters.length, 0);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  for (const mode of ["empty-rates-transient", "missing-row-id-transient", "probe-empty-transient"]) {
    test(`recovers ${mode} on the third actual request`, async () => {
      const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-parse-retry-"));
      try {
        const limit = 30;
        const result = runCollector(mode, outDir, { limit });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, limit + 2);
        if (!mode.startsWith("probe-")) assert.match(result.stdout, /再試行成功/);
        assert.doesNotMatch(result.stdout, /rq=1/);
        const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
        assert.equal(payload.filterPlan.capturedFilterCount, limit);
        assert.equal(payload.collectionQuality.status, "complete");
        assert.equal(payload.collectionQuality.failedFilters.length, 0);
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    });
  }

  for (const [mode, code, attempts, extraRequests] of [
    ["empty-rates-persistent", "empty-rates", 3, 2],
    ["missing-row-id-persistent", "missing-row-id", 3, 2],
    ["probe-empty-persistent", "empty-rates", 5, 4],
    ["probe-transport-persistent", "request", 5, 4],
    ["probe-rq1-empty-persistent", "empty-rates", 6, 5],
    ["probe-rq1-retried-rejection", "empty-rates", 8, 7],
  ]) {
    test(`records actual attempts for ${mode}`, async () => {
      const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-parse-partial-"));
      try {
        const limit = 30;
        const result = runCollector(mode, outDir, { limit });
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, limit + extraRequests);
        if (!mode.includes("rq1")) assert.doesNotMatch(result.stdout, /rq=1/);
        const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
        assert.equal(payload.filterPlan.capturedFilterCount, limit - 1);
        assert.equal(payload.collectionQuality.status, "partial");
        assert.equal(payload.collectionQuality.failedFilters.length, 1);
        assert.equal(payload.collectionQuality.failedFilters[0].code, code);
        assert.equal(payload.collectionQuality.failedFilters[0].attempts, attempts);
        const expectedRq = mode.includes("rq1") ? "1" : "2";
        assert.ok(payload.snapshots.filter((snapshot) => snapshot.filters.rq === "2")
          .every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === expectedRq));
      } finally {
        await rm(outDir, { recursive: true, force: true });
      }
    });
  }

  test("aborts immediately on a normal filter selection mismatch", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-selection-mismatch-"));
    try {
      const result = runCollector("selection-mismatch", outDir, { limit: 30 });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.equal((result.stdout.match(/\[mock-fetch\]/g) ?? []).length, 20);
      assert.match(result.stderr, /選択値が要求と不一致/);
      assert.doesNotMatch(result.stdout, /再試行:/);
      await assert.rejects(readFile(join(outDir, `${TEST_DATE}.json`), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("records a hero row missing from only some filters", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-missing-hero-"));
    try {
      const result = runCollector("missing-hero", outDir, { limit: 18 });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      assert.ok(payload.collectionQuality.heroUniverse.includes("mercy"));
      assert.ok(
        payload.collectionQuality.incompleteSnapshots.some((issue) => issue.missingHeroes.includes("mercy"))
      );
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("rejects a severe hero-row drop against the previous snapshot", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-hero-coverage-"));
    try {
      await writeFile(
        join(outDir, "2098-12-31.json"),
        JSON.stringify({ snapshots: [{ heroes: { ana: {}, mercy: {}, genji: {} } }] }),
        "utf8"
      );
      const result = runCollector("missing-hero", outDir, { limit: 18 });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /ヒーロー行の欠損を検知/);
      await assert.rejects(readFile(join(outDir, `${TEST_DATE}.json`), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("rejects axis-concentrated missing filters even within the global failure rate", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-axis-coverage-"));
    try {
      const result = runCollector("missing-selected-axis", outDir, {
        limit: FILTERS_PER_INPUT_MAP_REGION * 3,
      });
      assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /部分欠損の偏りを検知/);
      await assert.rejects(readFile(join(outDir, `${TEST_DATE}.json`), "utf8"), { code: "ENOENT" });
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });

  test("quarantines an incomplete map and saves the remaining maps within the global limit", async () => {
    const outDir = await mkdtemp(join(tmpdir(), "overwatch-stats-map-quarantine-"));
    try {
      const limit = FILTERS_PER_INPUT_MAP * 20;
      const result = runCollector("missing-map", outDir, { limit });
      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.match(result.stderr, /品質基準未満の 1 マップを全体隔離/);
      const payload = JSON.parse(await readFile(join(outDir, `${TEST_DATE}.json`), "utf8"));
      assert.equal(payload.filterPlan.capturedFilterCount, limit - FILTERS_PER_INPUT_MAP);
      assert.equal(payload.filterPlan.failedFilterCount, FILTERS_PER_INPUT_MAP);
      assert.equal(payload.filterPlan.quarantinedMapCount, 1);
      assert.equal(payload.collectionQuality.quarantinedMaps[0].map, "all-maps");
      assert.ok(payload.snapshots.every((snapshot) => snapshot.filters.map !== "all-maps"));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
}
