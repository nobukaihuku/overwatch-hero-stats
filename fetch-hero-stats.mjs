// scripts/fetch-hero-stats.mjs
// Blizzard 公式 rates ページ (overwatch.blizzard.com/ja-jp/rates/) から
// 入力方法・マップ・地域・モード・ティア別に、ヒーロー別の 勝率 / ピック率 / BAN率 を取得し、
// 日付付きスナップショットとして
//   src/data/hero-stats/YYYY-MM-DD.json
// に保存する。公式は「現在のパッチの数値」しか出さないため、これを定期的に貯めることで
// 公式にも無い「時系列 (シーズン推移・パッチ前後比較)」という独自資産を育てる。
//
// 仕組み: rates ページは SSR で、数値が HTML に直接埋め込まれている
//   <span class="percent-value" id="dva-winrate-value">46.5%</span>
// → 裏の JSON API は無く、ページ URL 自体が実質エンドポイント。
//   クエリ (input/map/region/role/rq/tier) を変えればフィルタ別 HTML が返る。
//   認証不要。正規表現1本で全件パースできる (ライブラリ不要)。
//   調査記録: memory project_stats_analytics.md「★裏エンドポイント調査の結果」。
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
// 実行: npm run stats:fetch        (取得して保存)
//       npm run stats:fetch -- --dry  (取得して内容を表示するだけ・保存しない)
//       npm run stats:fetch -- --dry --limit=5 --delay-ms=0  (短い検証用)
//       npm run stats:fetch -- --pretty  (読みやすい整形JSONで保存)

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
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
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

// ---------- 収集するフィルタの組み合わせ ----------
// 公式フィルタの確定値 (rates ページの <option> より):
//   region : Americas / Asia / Europe
//   rq     : 0 = クイック・プレイ(ロールキュー) / 1 = ライバル・プレイ(競技・ロールキュー)
//   tier   : All / Bronze / Silver / Gold / Platinum / Diamond / Master / Grandmaster
//            (Grandmaster は「グランドマスター&チャンピオン」統合。★BAN率は競技 rq=1 でのみ出る)
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
  { rq: "1", tiers: COMP_TIERS },  // ライバル・プレイ: 競技ティア別 (主目的・BAN率も取れる)
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
  return `${BASE}?${qs}`;
}

async function fetchHtml(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "ja,en" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

function parsePercent(value) {
  const text = value.trim();
  if (text === "--") return null;
  const normalized = text.endsWith("%") ? text.slice(0, -1) : text;
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

// HTML から { slug: {win, pick, ban} } を抽出。実証済みの正規表現。
function parseRates(html) {
  const grab = (kind) => {
    // slug はハイフンを含む (soldier-76 / junker-queen / wrecking-ball / jetpack-cat)。
    const re = new RegExp(`id="([a-z0-9-]+)-${kind}-value">\\s*([^<]+)`, "g");
    const out = {};
    for (const m of html.matchAll(re)) out[m[1]] = parsePercent(m[2]);
    return out;
  };
  const win = grab("winrate");
  const pick = grab("pickrate");
  const ban = grab("banrate");

  const slugs = [...new Set([...Object.keys(win), ...Object.keys(pick), ...Object.keys(ban)])].sort();
  const heroes = {};
  for (const s of slugs) {
    heroes[s] = {
      win: win[s] ?? null,
      pick: pick[s] ?? null,
      ban: ban[s] ?? null,
    };
  }
  // 取りこぼし検出用: 行 (hero-name) の総数。slug 抽出数と差があれば警告する。
  const nameCount = [...html.matchAll(/class="hero-name"[^>]*>([^<]+)</g)].length;
  return { heroes, slugCount: slugs.length, nameCount };
}

async function main() {
  const dry = process.argv.includes("--dry");
  const pretty = process.argv.includes("--pretty");
  const limit = readNonNegativeIntOption("limit", FILTERS.length);
  const delayMs = readNonNegativeIntOption("delay-ms", DEFAULT_DELAY_MS);
  const capturedAt = new Date().toISOString();
  const date = capturedAt.slice(0, 10); // YYYY-MM-DD
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
    const mode = filter.rq === "1" ? "競技" : "QP";
    const label = `${filter.input}/${filter.map}/${mode}/${filter.region}/${filter.tier}`;
    try {
      const html = await fetchHtml(url);
      const { heroes, slugCount, nameCount } = parseRates(html);
      // 部分欠損を保存しない: 0件(parse失敗の疑い)・行単位の取りこぼし(slug≠行数)は
      // failure 扱いにして、フィルタ取得失敗と同じく後段で「保存から除外」する(失敗が閾値超なら中断)。
      // 欠けたヒーローを後の時系列分析で「実在の変動」と誤認するのを防ぐ (レビュー B1)。
      if (slugCount === 0) {
        console.error(`  ✗ ${label}: 0件 (ページ構造が変わった可能性。class/id 形式を要確認)`);
        failures.push({ filter, url, message: "0件 (parse失敗の疑い)" });
      } else if (slugCount !== nameCount) {
        console.error(`  ✗ ${label}: slug抽出 ${slugCount} 件 / 行数 ${nameCount} 件 (差分=一部取りこぼし)`);
        failures.push({ filter, url, message: `一部取りこぼし (slug ${slugCount} / 行 ${nameCount})` });
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

  if (failures.length > 0) {
    const lbl = (f) => `${f.input}/${f.map}/${f.rq === "1" ? "競技" : "QP"}/${f.region}/${f.tier}`;
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

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = resolve(OUT_DIR, `${date}.json`);
  writeFileSync(outPath, JSON.stringify(payload, null, pretty ? 2 : 0) + "\n", "utf8");
  console.log(`\n保存: ${outPath} (${snapshots.length} スナップショット)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
