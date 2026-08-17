// fetch-hero-stats.mjs
// Blizzard 公式 rates ページの JSON データ (overwatch.blizzard.com/ja-jp/rates/data/) から
// 入力方法・マップ・地域・モード・ティア別に、ヒーロー別の 勝率 / ピック率 / BAN率 を取得し、
// 日付付きスナップショットとして
//   src/data/hero-stats/YYYY-MM-DD.json
// に保存する。公式は「現在のパッチの数値」しか出さないため、これを定期的に貯めることで
// 公式にも無い「時系列 (シーズン推移・パッチ前後比較)」という独自資産を育てる。
//
// 仕組み: rates ページ本体は表示更新時に /rates/data/ の JSON エンドポイントを叩く。
//   同じクエリ (input/map/region/role/rq/tier) を渡すと、フィルタ済みの rates.rates が返る。
//   認証不要。ネイティブ fetch で JSON を読み、row.id と cells の数値をそのまま使う。
//   HTML SSR は tier/map/rq が既定ビューに縮退する時期があるため、収集には使わない。
//
// 出典明記の義務: このデータを公開表示する際は必ず
//   「Blizzard 公式データ (overwatch.blizzard.com/rates) をもとに作成」と明記すること。
//   利用するのは数値 (事実) のみ。ロゴ・公式画像の転載は不可。
//
// 運用(2026-07-04 分離後): 日次収集は別リポジトリ overwatch-hero-stats のワークフローで行い、
//   そこにコミットして時系列資産を貯める(サイトrepoの .git 肥大化を避けるため)。
//   データrepo側は STATS_OUT_DIR=hero-stats を渡してこのスクリプトを再利用する。
//   サイトrepoでは src/data/hero-stats/ は gitignore 済み。ローカルで本スクリプトを直接
//   実行すると、その gitignore 済みディレクトリに書き出す(手動確認・アドホック取得用)。
//   同日再実行は上書き (冪等)。
//
// 重複排除(2026-07-12): Blizzard の rates は毎日は更新されないため、直近の既存スナップショット
//   とデータが完全一致する日 (capturedAt のみ差分) は保存しない(同一データ約4MB/日の肥大化防止)。
//   ワークフロー側は「差分なし」となりコミットもスキップされる。
//   したがって日付の欠落は「収集失敗」だけでなく「データ未変化」も意味する(Actions ログで区別)。
//
// 縮退検知(2026-07-19): 公式が rq/map フィルタを無視してクイック・プレイの既定ビューを返す日が
//   あり(実測で約4割)、そのまま保存すると時系列 delta が壊れる。assertRankedAxisNotCollapsed で
//   検知して中断するため、日付の欠落は「縮退日」も意味するようになった。
// 部分欠損(2026-08-18): 一時的なHTTP/JSON/選択情報欠損は第2パスで再試行し、回復しない
//   フィルタだけを除外して保存できる。ヒーローの未提供セルは0に補完せずnullのまま保持し、
//   collectionQuality に欠損とcoverageを記録する。選択値の不一致と軸の偏った欠損は保存しない。
//
// 実行: npm run stats:fetch        (取得して保存)
//       npm run stats:fetch -- --dry  (取得して内容を表示するだけ・保存しない)
//       npm run stats:fetch -- --dry --limit=5 --delay-ms=0  (短い検証用)
//       npm run stats:fetch -- --pretty  (読みやすい整形JSONで保存)

import { writeFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
// 出力先。既定はサイトrepo構成 (src/data/hero-stats)。
// hero-stats データリポジトリ側ではワークフローが STATS_OUT_DIR=hero-stats を渡す
// (このスクリプトをそのまま再利用できるようにするため)。
const OUT_DIR = process.env.STATS_OUT_DIR
  ? resolve(process.env.STATS_OUT_DIR)
  : resolve(ROOT, "src/data/hero-stats");

const BASE = "https://overwatch.blizzard.com/ja-jp/rates/";
const DATA_ENDPOINT = "https://overwatch.blizzard.com/ja-jp/rates/data/";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---------- 収集するフィルタの組み合わせ ----------
// 公式フィルタの確定値 (rates ページの <option> より):
//   region : Americas / Asia / Europe
//   tier   : All / Bronze / Silver / Gold / Platinum / Diamond / Master / Grandmaster
//            (Grandmaster は「グランドマスター&チャンピオン」統合)
//   input  : PC / Console     role : All ほかサブロール多数     map : all-maps ほか個別マップ多数
// role は公式FAQ上「表示内容の絞り込み」で、再計算フィルタではないため All だけを取る。
// 下記の軸を直積して FILTERS を生成。軸を足し引きすれば収集範囲を調整できる。
const INPUTS = ["PC", "Console"];
const MAPS = [
  "all-maps",
  "antarctic-peninsula",
  "busan",
  "ilios",
  "lijiang-tower",
  "nepal",
  "oasis",
  "samoa",
  "circuit-royal",
  "dorado",
  "havana",
  "junkertown",
  "rialto",
  "route-66",
  "shambali-monastery",
  "watchpoint-gibraltar",
  "aatlis",
  "new-junk-city",
  "suravasa",
  "blizzard-world",
  "eichenwalde",
  "hollywood",
  "kings-row",
  "midtown",
  "neon-junction",
  "numbani",
  "paraiso",
  "colosseo",
  "esperanca",
  "new-queen-street",
  "runasapi"
];
const ROLE = "All";
const REGIONS = ["Americas", "Asia", "Europe"];
const COMP_TIERS = ["All", "Bronze", "Silver", "Gold", "Platinum", "Diamond", "Master", "Grandmaster"];
// 公式APIの競技値は 2026-08-12〜13 に 1 と 2 の間で切り替わったため、run開始時に候補を検証する。
// 保存済み payload との互換性を保つため、canonical の競技値は常に 2 を維持する。
const CANONICAL_QUICK_PLAY_RQ = "0";
const CANONICAL_COMPETITIVE_RQ = "2";
const OFFICIAL_COMPETITIVE_RQ_CANDIDATES = ["2", "1"];

// モードごとに取得するティア: QPは全体のみ / 競技はティア別に展開
const MODE_TIERS = [
  { rq: CANONICAL_QUICK_PLAY_RQ, tiers: ["All"] },
  { rq: CANONICAL_COMPETITIVE_RQ, tiers: COMP_TIERS },
];

// 2入力 × 31マップ × 3地域 × (QP全体1 + 競技8ティア) = 1674 スナップショット
const FILTERS = [];
for (const input of INPUTS)
  for (const map of MAPS)
    for (const region of REGIONS)
      for (const { rq, tiers } of MODE_TIERS)
        for (const tier of tiers)
          FILTERS.push({ input, map, region, role: ROLE, rq, tier });

const DEFAULT_DELAY_MS = Number.parseInt(process.env.STATS_FETCH_DELAY_MS ?? "1000", 10);
const FETCH_TIMEOUT_MS = (() => {
  const value = Number.parseInt(process.env.STATS_FETCH_TIMEOUT_MS ?? "15000", 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("STATS_FETCH_TIMEOUT_MS must be a positive integer.");
  }
  return value;
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readOptionValue(name) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
}

function readNonNegativeIntOption(name, fallback) {
  const raw = readOptionValue(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return parsed;
}

const FILTER_AXES = ["input", "map", "region", "role", "rq", "tier"];
const QUALITY_METRICS = ["win", "pick", "ban"];
const MIN_COVERAGE_RATE = 2 / 3;
const MIN_HERO_COVERAGE_RATE = 2 / 3;

class OfficialFilterSelectionError extends Error {
  constructor(message) {
    super(message);
    this.name = "OfficialFilterSelectionError";
  }
}

class OfficialFilterSelectionMissingError extends OfficialFilterSelectionError {
  constructor(message) {
    super(message);
    this.name = "OfficialFilterSelectionMissingError";
    this.code = "missing-selected";
  }
}

class OfficialFilterSelectionMismatchError extends OfficialFilterSelectionError {
  constructor(message) {
    super(message);
    this.name = "OfficialFilterSelectionMismatchError";
    this.code = "selection-mismatch";
  }
}

class FilterCollectionError extends Error {
  constructor(code, message, { url = null } = {}) {
    super(message);
    this.name = "FilterCollectionError";
    this.code = code;
    this.url = url;
  }
}

function assertOfficialSelection(json, expectedFilter) {
  const selected = json?.rates?.selected;
  if (!selected || typeof selected !== "object") {
    throw new OfficialFilterSelectionMissingError("公式応答に rates.selected がありません。");
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
  throw new OfficialFilterSelectionMismatchError(
    `公式応答の選択値が要求と不一致です (${details})。保存を中断します。`
  );
}

function toOfficialFilter(filter, officialCompetitiveRq) {
  return {
    ...filter,
    rq: filter.rq === CANONICAL_COMPETITIVE_RQ ? officialCompetitiveRq : filter.rq,
  };
}

function buildRequest(filter, officialCompetitiveRq) {
  const officialFilter = toOfficialFilter(filter, officialCompetitiveRq);
  const qs = new URLSearchParams(officialFilter).toString();
  return { officialFilter, url: `${DATA_ENDPOINT}?${qs}` };
}

async function fetchOfficialResponse(
  filter,
  officialCompetitiveRq,
  { attempts = 1, retryMissingSelection = true, delayMs = 0 } = {}
) {
  const { officialFilter, url } = buildRequest(filter, officialCompetitiveRq);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const json = await fetchJsonOnce(url);
      assertOfficialSelection(json, officialFilter);
      return { json, url };
    } catch (err) {
      lastError = err;
      const retryableSelection = err instanceof OfficialFilterSelectionMissingError && retryMissingSelection;
      const retryableTransport = !(err instanceof OfficialFilterSelectionError);
      if (attempt >= attempts || (!retryableSelection && !retryableTransport)) throw err;
      if (delayMs > 0) await sleep(Math.min(delayMs, 1000 * attempt));
    }
  }
  throw lastError;
}

async function resolveOfficialCompetitiveResponse(filter, delayMs) {
  const rejected = [];
  for (let i = 0; i < OFFICIAL_COMPETITIVE_RQ_CANDIDATES.length; i++) {
    const candidate = OFFICIAL_COMPETITIVE_RQ_CANDIDATES[i];
    try {
      const response = await fetchOfficialResponse(filter, candidate, {
        attempts: 3,
        retryMissingSelection: true,
        delayMs,
      });
      console.log(`公式競技モードを rq=${candidate} で確定`);
      return { ...response, officialCompetitiveRq: candidate };
    } catch (err) {
      if (err instanceof OfficialFilterSelectionMissingError) throw err;
      if (!(err instanceof OfficialFilterSelectionError)) throw err;
      rejected.push(`rq=${candidate}: ${err.message}`);
      if (i < OFFICIAL_COMPETITIVE_RQ_CANDIDATES.length - 1) {
        console.warn(`公式競技 rq=${candidate} は選択不一致。次候補を確認します。`);
        if (delayMs > 0) await sleep(delayMs);
      }
    }
  }
  throw new OfficialFilterSelectionError(
    `公式競技モードを確定できません (${rejected.join(" / ")})。保存を中断します。`
  );
}

async function fetchJsonOnce(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": UA,
        "Accept-Language": "ja,en",
        "X-Requested-With": "XMLHttpRequest",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (error) {
    throw controller.signal.aborted
      ? new Error(`公式API応答待ちが ${FETCH_TIMEOUT_MS}ms を超えました。`)
      : error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function normNum(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const text = String(value).trim().replace(/%$/, "");
  if (text === "" || text === "--") return null;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : null;
}

// JSON から { slug: {win, pick, ban} } を抽出。出力 shape は既存データと同じ。
function parseRates(json) {
  const rows = json?.rates?.rates;
  if (!Array.isArray(rows)) return { heroes: {}, slugCount: 0, rowCount: 0 };
  const heroes = {};
  for (const row of rows) {
    const slug = row?.id;
    if (!slug) continue;
    const cells = row.cells ?? {};
    heroes[slug] = {
      win: normNum(cells.winrate),
      pick: normNum(cells.pickrate),
      ban: normNum(cells.banrate),
    };
  }
  return { heroes, slugCount: Object.keys(heroes).length, rowCount: rows.length };
}

function filterLabel(filter) {
  return `${filter.input}/${filter.map}/${filter.rq === "0" ? "QP" : "ランク"}/${filter.region}/${filter.tier}`;
}

function filterFailure(code, message, filter, url = null, attempts = 1) {
  return { filter, url, code, message, attempts };
}

async function fetchFilterSnapshot(filter, officialCompetitiveRq, { attempts, delayMs, resolveCompetitive = false } = {}) {
  let response;
  if (resolveCompetitive) {
    response = await resolveOfficialCompetitiveResponse(filter, delayMs);
  } else {
    response = await fetchOfficialResponse(filter, officialCompetitiveRq, {
      attempts,
      retryMissingSelection: true,
      delayMs,
    });
  }

  const effectiveCompetitiveRq = response.officialCompetitiveRq ?? officialCompetitiveRq;
  let parsed;
  try {
    parsed = parseRates(response.json);
    if (parsed.slugCount === 0) {
      throw new FilterCollectionError(
        "empty-rates",
        "0件 (レスポンス構造が変わった可能性。rates.rates を要確認)",
        { url: response.url }
      );
    }
    if (parsed.slugCount !== parsed.rowCount) {
      throw new FilterCollectionError(
        "missing-row-id",
        `一部取りこぼし (slug ${parsed.slugCount} / 行 ${parsed.rowCount})`,
        { url: response.url }
      );
    }
  } catch (err) {
    err.officialCompetitiveRq = effectiveCompetitiveRq;
    throw err;
  }
  return {
    snapshot: { filters: filter, url: response.url, heroCount: parsed.slugCount, heroes: parsed.heroes },
    officialCompetitiveRq: effectiveCompetitiveRq,
  };
}

function axisValues(filter) {
  return {
    input: filter.input,
    map: filter.map,
    region: filter.region,
    mode: filter.rq === "0" ? "QP" : "ランク",
    rq: filter.rq,
    tier: filter.tier,
  };
}

function calculateCoverage(activeFilters, snapshots) {
  const buckets = new Map();
  const compoundBuckets = new Map();

  const ensure = (map, key) => {
    if (!map.has(key)) map.set(key, { expected: 0, captured: 0 });
    return map.get(key);
  };

  for (const filter of activeFilters) {
    for (const [axis, value] of Object.entries(axisValues(filter))) {
      ensure(buckets, `${axis}=${value}`).expected += 1;
    }
    ensure(compoundBuckets, `${filter.input}|${filter.map}|${filter.region}`).expected += 1;
  }

  for (const snapshot of snapshots) {
    for (const [axis, value] of Object.entries(axisValues(snapshot.filters))) {
      ensure(buckets, `${axis}=${value}`).captured += 1;
    }
    ensure(compoundBuckets, `${snapshot.filters.input}|${snapshot.filters.map}|${snapshot.filters.region}`).captured += 1;
  }

  const withRates = (entries) => Object.fromEntries(
    [...entries].map(([key, value]) => [
      key,
      {
        expected: value.expected,
        captured: value.captured,
        rate: value.expected === 0 ? 1 : value.captured / value.expected,
      },
    ])
  );

  const axis = withRates(buckets);
  const compound = withRates(compoundBuckets);
  const insufficient = [
    ...Object.entries(axis)
      .filter(([, value]) => value.captured < Math.ceil(value.expected * MIN_COVERAGE_RATE))
      .map(([key, value]) => [`axis:${key}`, value]),
    ...Object.entries(compound)
      .filter(([, value]) => value.captured < Math.ceil(value.expected * MIN_COVERAGE_RATE))
      .map(([key, value]) => [`input-map-region:${key}`, value]),
  ];
  return { axis, compound, insufficient };
}

function assertCoverage(activeFilters, snapshots) {
  const coverage = calculateCoverage(activeFilters, snapshots);
  if (coverage.insufficient.length === 0) return coverage;

  console.error(
    `\n部分欠損の偏りを検知しました。軸またはinput/map/regionグループの取得率が ${
      Math.round(MIN_COVERAGE_RATE * 100)
    }% 未満のため、保存を中断します。`
  );
  for (const [key, value] of coverage.insufficient.slice(0, 10)) {
    console.error(`  - ${key}: ${value.captured}/${value.expected}`);
  }
  if (coverage.insufficient.length > 10) {
    console.error(`  ... 他 ${coverage.insufficient.length - 10} グループ`);
  }
  process.exit(1);
}

function readPreviousHeroUniverse(previousPath) {
  if (!previousPath) return new Set();
  try {
    const previous = JSON.parse(readFileSync(previousPath, "utf8"));
    return new Set(
      (previous.snapshots ?? []).flatMap((snapshot) => Object.keys(snapshot.heroes ?? {}))
    );
  } catch {
    return new Set();
  }
}

function assertHeroAvailability(snapshots, previousPath) {
  const expectedHeroes = readPreviousHeroUniverse(previousPath);
  if (expectedHeroes.size === 0) return;
  for (const snapshot of snapshots) {
    const captured = Object.keys(snapshot.heroes).length;
    const minimum = Math.ceil(expectedHeroes.size * MIN_HERO_COVERAGE_RATE);
    if (captured >= minimum) continue;
    console.error(
      `\nヒーロー行の欠損を検知しました: ${filterLabel(snapshot.filters)} は ${captured}/${expectedHeroes.size} 件。` +
        "前回スナップショット比で大きく欠けているため、保存を中断します。"
    );
    process.exit(1);
  }
}

function collectQuality(snapshots, failures, previousPath, coverage) {
  const heroUniverse = readPreviousHeroUniverse(previousPath);
  for (const snapshot of snapshots) {
    for (const slug of Object.keys(snapshot.heroes)) heroUniverse.add(slug);
  }

  const incompleteSnapshots = [];
  for (const snapshot of snapshots) {
    const missingHeroes = [...heroUniverse].filter((slug) => !Object.hasOwn(snapshot.heroes, slug)).sort();
    const requiredMetrics = snapshot.filters.rq === CANONICAL_QUICK_PLAY_RQ
      ? ["win", "pick"]
      : QUALITY_METRICS;
    const missingMetrics = {};
    for (const [slug, values] of Object.entries(snapshot.heroes)) {
      const missing = requiredMetrics.filter((metric) => values[metric] == null);
      if (missing.length > 0) missingMetrics[slug] = missing;
    }
    if (missingHeroes.length > 0 || Object.keys(missingMetrics).length > 0) {
      incompleteSnapshots.push({
        filters: snapshot.filters,
        missingHeroes,
        missingMetrics,
      });
    }
  }

  const missingMetricCount = incompleteSnapshots.reduce(
    (total, issue) => total + Object.values(issue.missingMetrics).reduce((n, metrics) => n + metrics.length, 0),
    0
  );
  return {
    status: failures.length > 0 || incompleteSnapshots.length > 0 ? "partial" : "complete",
    heroUniverse: [...heroUniverse].sort(),
    failedFilters: failures.map(({ filter, code, message, attempts }) => ({ filter, code, message, attempts })),
    incompleteSnapshots,
    incompleteSnapshotCount: incompleteSnapshots.length,
    missingMetricCount,
    coverageByAxis: coverage.axis,
    coverageByInputMapRegion: coverage.compound,
  };
}

function heroesSignature(heroes) {
  return Object.keys(heroes)
    .sort()
    .map((slug) => {
      const v = heroes[slug];
      return `${slug}:${v.win},${v.pick},${v.ban}`;
    })
    .join("|");
}

function assertTierAxisNotCollapsed(snapshots) {
  const byGroup = new Map();
  for (const snapshot of snapshots) {
    const f = snapshot.filters;
    const key = `${f.input}|${f.map}|${f.region}|${f.rq}`;
    if (!byGroup.has(key)) byGroup.set(key, new Map());
    byGroup.get(key).set(f.tier, heroesSignature(snapshot.heroes));
  }

  let tierGroups = 0;
  const collapsedExamples = [];
  for (const [key, tiers] of byGroup) {
    if (tiers.size < 2 || !tiers.has("All")) continue;
    tierGroups++;
    const allSignature = tiers.get("All");
    const everyTierEqualsAll = [...tiers.values()].every((signature) => signature === allSignature);
    if (everyTierEqualsAll) collapsedExamples.push(key);
  }

  if (collapsedExamples.length > 0) {
    console.error(
      `\n縮退検知: ${collapsedExamples.length}/${tierGroups} グループでティア変種が All と完全同値。` +
        " tier軸が反映されていない可能性があるため、保存を中断します。"
    );
    for (const key of collapsedExamples.slice(0, 10)) console.error(`  - ${key}`);
    if (collapsedExamples.length > 10) console.error(`  ... 他 ${collapsedExamples.length - 10} 件`);
    process.exit(1);
  }
}

// rq/map 軸の縮退検知 (2026-07-19)
// 公式APIは日によって rq/map フィルタを適用せず、クイック・プレイの既定ビューを返すことがある。
// 実測 (2026-07-05〜18) では 11 日中 5 日がこの状態で、rq=2 を要求しても
//   - BAN率が全フィルタで消える (BANはランクでのみ発生する)
//   - per-map が全マップ all-maps と同一になる
//   - rq=2 の中身が rq=0 と完全に一致する
// という3点が同時に起きる。返る値自体はロール別合計 100/200/200 が成立する整合したQPデータのため、
// 保存してしまうと後段では異常と分からず、時系列 delta が「実際には動いていないヒーローの
// 大きな変動」として現れる (/stats/ の急上昇・急降下が誤表示になる)。
//
// assertTierAxisNotCollapsed はティア軸しか見ておらず、縮退時もティア軸は生きているため素通りする。
// ここで BAN率の欠落と rq 軸の一致を検査し、縮退日は保存せず中断する。
function assertRankedAxisNotCollapsed(snapshots) {
  const ranked = snapshots.filter((s) => s.filters.rq === "2");
  if (ranked.length === 0) return; // ランクを収集していない構成なら検査対象外
  // (1) BAN率の欠落。単発の取得失敗による部分欠損と区別するため、半数割れのみ縮退とみなす。
  const withBan = ranked.filter((s) => Object.values(s.heroes).some((h) => (h.ban ?? 0) > 0));
  if (withBan.length < ranked.length / 2) {
    console.error(
      `\n縮退検知: rq=2 の ${ranked.length - withBan.length}/${ranked.length} フィルタで BAN率が空。` +
        " ランクを要求したのにクイック・プレイの既定ビューが返っている疑いがあるため、保存を中断します。"
    );
    process.exit(1);
  }
  // (2) rq 軸そのものの一致。同じ input/map/region/tier で rq=2 と rq=0 が同値なら rq が効いていない。
  const byKey = new Map();
  for (const s of snapshots) {
    const f = s.filters;
    byKey.set(`${f.input}|${f.map}|${f.region}|${f.tier}|${f.rq}`, heroesSignature(s.heroes));
  }
  const collapsed = [];
  for (const [key, signature] of byKey) {
    if (!key.endsWith("|2")) continue;
    const qpKey = key.replace(/\|2$/, "|0");
    if (byKey.has(qpKey) && byKey.get(qpKey) === signature) collapsed.push(key.slice(0, -2));
  }
  if (collapsed.length > 0) {
    console.error(
      `\n縮退検知: ${collapsed.length} グループで rq=2 (ランク) と rq=0 (QP) が完全同値。` +
        " rq軸が反映されていないため、保存を中断します。"
    );
    for (const key of collapsed.slice(0, 10)) console.error(`  - ${key}`);
    if (collapsed.length > 10) console.error(`  ... 他 ${collapsed.length - 10} 件`);
    process.exit(1);
  }
}

// ---------- 重複排除 ----------
// OUT_DIR にある「保存予定日以外で最新」のスナップショットのパスを返す (無ければ null)。
function findLatestSnapshotPath(outDir, excludeDate) {
  let files;
  try {
    files = readdirSync(outDir);
  } catch {
    return null; // 初回実行などディレクトリ不在は「比較対象なし」扱い
  }
  const dates = files
    .map((name) => /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name)?.[1])
    .filter((d) => d && d !== excludeDate)
    .sort();
  return dates.length > 0 ? resolve(outDir, `${dates[dates.length - 1]}.json`) : null;
}

// capturedAt を除いて完全一致か。前ファイルが読めない/壊れている場合は false (=通常どおり保存)。
function isSameExceptCapturedAt(payload, previousPath) {
  try {
    const previous = JSON.parse(readFileSync(previousPath, "utf8"));
    return (
      JSON.stringify({ ...payload, capturedAt: null }) ===
      JSON.stringify({ ...previous, capturedAt: null })
    );
  } catch {
    return false;
  }
}

async function main() {
  const dry = process.argv.includes("--dry");
  const pretty = process.argv.includes("--pretty");
  const limit = readNonNegativeIntOption("limit", FILTERS.length);
  const delayMs = readNonNegativeIntOption("delay-ms", DEFAULT_DELAY_MS);
  const capturedAt = new Date().toISOString();
  // STATS_DATE_OVERRIDE は重複排除の動作検証用 (通常運用では使わない)
  const date = process.env.STATS_DATE_OVERRIDE || capturedAt.slice(0, 10); // YYYY-MM-DD
  const activeFilters = FILTERS.slice(0, limit);

  // 失敗許容: 一部フィルタが失敗しても、割合が閾値以内なら「除外して保存」する。
  // (1,674件のライブ取得では単発の通信/パース差が起きやすく、1件でも中断だと丸ごと1日分を失うため。)
  // 閾値超は systemic 障害(ページ構造変化/ブロック)の疑いとして中断。既定5% / STATS_MAX_FAILURE_RATE で調整可。
  const maxFailureRate = (() => {
    const v = Number.parseFloat(process.env.STATS_MAX_FAILURE_RATE ?? "0.05");
    return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 0.05;
  })();
  const maxFailures = Math.floor(activeFilters.length * maxFailureRate);

  const snapshots = [];
  const failures = [];
  let officialCompetitiveRq = null;
  const retryQueue = [];
  console.log(`取得予定: ${activeFilters.length}/${FILTERS.length} スナップショット (delay ${delayMs}ms)`);
  for (let i = 0; i < activeFilters.length; i++) {
    const filter = activeFilters[i];
    const label = filterLabel(filter);
    const resolvingCompetitive = filter.rq === CANONICAL_COMPETITIVE_RQ && officialCompetitiveRq === null;
    try {
      const result = await fetchFilterSnapshot(filter, officialCompetitiveRq, {
        attempts: resolvingCompetitive ? 3 : 1,
        delayMs,
        resolveCompetitive: resolvingCompetitive,
      });
      officialCompetitiveRq = result.officialCompetitiveRq ?? officialCompetitiveRq;
      console.log(`  ✓ ${label}: ${result.snapshot.heroCount} 件`);
      snapshots.push(result.snapshot);
    } catch (err) {
      if (err.officialCompetitiveRq) officialCompetitiveRq = err.officialCompetitiveRq;
      const fatalSelection =
        err instanceof OfficialFilterSelectionMismatchError ||
        (err instanceof OfficialFilterSelectionError && officialCompetitiveRq === null && filter.rq === CANONICAL_COMPETITIVE_RQ);
      if (fatalSelection) throw err;
      const failure = filterFailure(
        err.code ?? "request",
        err.message,
        filter,
        err.url ?? null,
        1
      );
      console.error(`  ✗ ${label}: 取得失敗 — ${failure.message} (再試行キュー)`);
      failures.push(failure);
      retryQueue.push(failure);
    }
    if (i < activeFilters.length - 1 && delayMs > 0) await sleep(delayMs); // 礼儀: フィルタ間に間隔
  }

  if (retryQueue.length > 0) {
    console.log(`\n再試行: ${retryQueue.length} フィルタ (各フィルタ残り2回まで)`);
    for (let i = 0; i < retryQueue.length; i++) {
      const failure = retryQueue[i];
      const label = filterLabel(failure.filter);
      try {
        const result = await fetchFilterSnapshot(failure.filter, officialCompetitiveRq, {
          attempts: 2,
          delayMs,
        });
        officialCompetitiveRq = result.officialCompetitiveRq ?? officialCompetitiveRq;
        const index = failures.indexOf(failure);
        if (index >= 0) failures.splice(index, 1);
        snapshots.push(result.snapshot);
        console.log(`  ↻ ${label}: 再試行成功 (${result.snapshot.heroCount} 件)`);
      } catch (err) {
        if (err.officialCompetitiveRq) officialCompetitiveRq = err.officialCompetitiveRq;
        if (err instanceof OfficialFilterSelectionMismatchError) throw err;
        if (
          err instanceof OfficialFilterSelectionError &&
          officialCompetitiveRq === null &&
          failure.filter.rq === CANONICAL_COMPETITIVE_RQ
        ) {
          throw err;
        }
        failure.code = err.code ?? failure.code;
        failure.message = err.message;
        failure.url = err.url ?? failure.url;
        failure.attempts = 3;
        console.error(`  ✗ ${label}: 再試行後も取得失敗 — ${failure.message}`);
      }
      if (i < retryQueue.length - 1 && delayMs > 0) await sleep(delayMs);
    }
  }

  if (snapshots.length === 0) {
    console.error("\n全フィルタの取得に失敗しました。中断します。");
    process.exit(1);
  }

  const previousPath = findLatestSnapshotPath(OUT_DIR, date);
  assertHeroAvailability(snapshots, previousPath);
  const coverage = assertCoverage(activeFilters, snapshots);
  assertTierAxisNotCollapsed(snapshots);
  assertRankedAxisNotCollapsed(snapshots);

  if (failures.length > 0) {
    console.warn(`\n⚠ ${failures.length}/${activeFilters.length} フィルタが失敗 (保存から除外):`);
    for (const f of failures.slice(0, 20)) console.warn(`  - ${filterLabel(f.filter)}: ${f.message}`);
    if (failures.length > 20) console.warn(`  ... 他 ${failures.length - 20} 件`);
    if (failures.length > maxFailures) {
      console.error(
        `\n失敗が閾値 ${maxFailures} 件 (${Math.round(maxFailureRate * 100)}%) を超えました。` +
          ` systemic 障害の疑いがあるため中断します (保存しません)。`
      );
      process.exit(1);
    }
    console.warn(`\n閾値内 (<= ${maxFailures} 件) のため、失敗分を除いた ${snapshots.length} 件を保存します。`);
  }

  const collectionQuality = collectQuality(snapshots, failures, previousPath, coverage);

  const payload = {
    capturedAt,
    source: BASE,
    note: "Blizzard 公式 rates ページより取得。公開表示時は出典明記・数値のみ使用。",
    patch: null, // 手動でパッチ番号/バージョンを記入する欄 (任意)
    filterPlan: {
      inputs: INPUTS,
      maps: MAPS,
      regions: REGIONS,
      role: ROLE,
      modeTiers: MODE_TIERS,
      totalFilterCount: FILTERS.length,
      capturedFilterCount: snapshots.length,
      failedFilterCount: failures.length
    },
    collectionQuality,
    snapshots,
  };

  if (dry) {
    console.log("\n[--dry] 保存しません。先頭スナップショットの先頭5件:");
    const first = snapshots[0];
    console.log(`  filters: ${JSON.stringify(first.filters)}`);
    for (const [slug, v] of Object.entries(first.heroes).slice(0, 5)) {
      console.log(`    ${slug.padEnd(14)} win ${v.win}%  pick ${v.pick}%  ban ${v.ban}%`);
    }
    return;
  }

  // 重複排除: 直近スナップショットと capturedAt 以外が同一なら保存しない。
  // --limit の部分取得は snapshots 件数や filterPlan.capturedFilterCount が変わるため、
  // フル取得の前日分と誤って同一視されることはない。
  if (previousPath && isSameExceptCapturedAt(payload, previousPath)) {
    console.log(
      `\n重複排除: ${basename(previousPath)} とデータ同一 (capturedAt のみ差分) のため保存をスキップします。`
    );
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, pretty ? 2 : 0) + "\n", "utf8");
  console.log(`\n保存: ${outPath} (${snapshots.length} スナップショット)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
