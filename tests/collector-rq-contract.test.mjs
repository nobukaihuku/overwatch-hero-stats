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
      ["--import", pathToFileURL(THIS_FILE).href, COLLECTOR, "--limit=18", "--delay-ms=0"],
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
