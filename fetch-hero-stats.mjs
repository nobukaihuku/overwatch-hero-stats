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
//   rq     : 0 = クイック・プレイ(ロールキュー) / 2 = ライバル・プレイ(ランク・ロールキュー)
//            ※rq=1 はドロップダウンに存在しない値。誤用すると ban/per-map が縮退する (rq=2が正)。
//   tier   : All / Bronze / Silver / Gold / Platinum / Diamond / Master / Grandmaster
//            (Grandmaster は「グランドマスター&チャンピオン」統合。★BAN率・per-mapはランク rq=2 で出る)
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
// モードごとに取得するティア: QPは全体のみ / 競技はティア別に展開
const MODE_TIERS = [
  { rq: "0", tiers: ["All"] },     // クイック・プレイ: 全体傾向の参考に1本
  { rq: "2", tiers: COMP_TIERS },  // ライバル・プレイ(ランク): ティア別 + BAN率 + per-map が取れる (rq=2が正・rq=1は縮退)
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

function buildUrl(filter) {
  const qs = new URLSearchParams(filter).toString();
  return `${DATA_ENDPOINT}?${qs}`;
}

async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          "Accept-Language": "ja,en",
          "X-Requested-With": "XMLHttpRequest",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
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
  console.log(`取得予定: ${activeFilters.length}/${FILTERS.length} スナップショット (delay ${delayMs}ms)`);
  for (let i = 0; i < activeFilters.length; i++) {
    const filter = activeFilters[i];
    const url = buildUrl(filter);
    const mode = filter.rq === "0" ? "QP" : "ランク";
    const label = `${filter.input}/${filter.map}/${mode}/${filter.region}/${filter.tier}`;
    try {
      const json = await fetchJson(url);
      const { heroes, slugCount, rowCount } = parseRates(json);
      // 部分欠損を保存しない: 0件(parse失敗の疑い)・行単位の取りこぼし(slug≠行数)は
      // failure 扱いにして、フィルタ取得失敗と同じく後段で「保存から除外」する(失敗が閾値超なら中断)。
      // 欠けたヒーローを後の時系列分析で「実在の変動」と誤認するのを防ぐ (レビュー B1)。
      if (slugCount === 0) {
        console.error(`  ✗ ${label}: 0件 (レスポンス構造が変わった可能性。rates.rates を要確認)`);
        failures.push({ filter, url, message: "0件 (parse失敗の疑い)" });
      } else if (slugCount !== rowCount) {
        console.error(`  ✗ ${label}: slug ${slugCount} 件 / 行 ${rowCount} 件 (差分=id欠落の取りこぼし)`);
        failures.push({ filter, url, message: `一部取りこぼし (slug ${slugCount} / 行 ${rowCount})` });
      } else {
        console.log(`  ✓ ${label}: ${slugCount} 件`);
        snapshots.push({ filters: filter, url, heroCount: slugCount, heroes });
      }
    } catch (err) {
      console.error(`  ✗ ${label}: 取得失敗 — ${err.message}`);
      failures.push({ filter, url, message: err.message });
    }
    if (i < activeFilters.length - 1 && delayMs > 0) await sleep(delayMs); // 礼儀: フィルタ間に間隔
  }

  if (snapshots.length === 0) {
    console.error("\n全フィルタの取得に失敗しました。中断します。");
    process.exit(1);
  }

  assertTierAxisNotCollapsed(snapshots);
  assertRankedAxisNotCollapsed(snapshots);

  if (failures.length > 0) {
    const lbl = (f) => `${f.input}/${f.map}/${f.rq === "0" ? "QP" : "ランク"}/${f.region}/${f.tier}`;
    console.warn(`\n⚠ ${failures.length}/${activeFilters.length} フィルタが失敗 (保存から除外):`);
    for (const f of failures.slice(0, 20)) console.warn(`  - ${lbl(f.filter)}: ${f.message}`);
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
  const previousPath = findLatestSnapshotPath(OUT_DIR, date);
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
