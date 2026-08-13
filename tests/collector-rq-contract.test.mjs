import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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
const TIERS = ["All", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"];

if (MOCK_MODE) {
  let requestCount = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const officialRq = url.searchParams.get("rq");
    requestCount += 1;
    console.log(`[mock-fetch] ${requestCount} rq=${officialRq}`);

    if (MOCK_MODE === "timeout") {
      return await new Promise((_, reject) => {
        const signal = init.signal;
        if (!signal) return;
        const abort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    }

    const supportedRankedRq = MOCK_MODE === "valid-rq1" ? "1" : MOCK_MODE === "valid-rq2" ? "2" : null;
    const isRanked = officialRq === supportedRankedRq;
    const tierIndex = Math.max(0, TIERS.indexOf(url.searchParams.get("tier")));
    const selected = Object.fromEntries(AXES.map((axis) => [axis, url.searchParams.get(axis)]));

    if (officialRq !== "0" && !isRanked) selected.rq = "0";

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
  function runCollector(mode, outDir, { limit = 18, fetchTimeoutMs } = {}) {
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
      assert.equal(payload.filterPlan.capturedFilterCount, 18);
      assert.equal(payload.filterPlan.failedFilterCount, 0);

      const quickPlay = payload.snapshots.filter((snapshot) => snapshot.filters.rq === "0");
      const ranked = payload.snapshots.filter((snapshot) => snapshot.filters.rq === "2");
      assert.equal(quickPlay.length, 2);
      assert.equal(ranked.length, 16);
      assert.ok(quickPlay.every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === "0"));
      assert.ok(ranked.every((snapshot) => new URL(snapshot.url).searchParams.get("rq") === expectedRq));
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }

  test("uses official rq=2 when the API accepts it while preserving canonical rq=2", async () => {
    await assertSelectedRankedRq("valid-rq2", "2", 18);
  });

  test("falls back to official rq=1 when rq=2 is rejected while preserving canonical rq=2", async () => {
    await assertSelectedRankedRq("valid-rq1", "1", 19);
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
}
