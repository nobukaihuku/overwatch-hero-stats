# 実装指示書: hero-stats collector を JSONエンドポイント方式へ切替 (2026-07-05)

> このドキュメントは**別のAIセッションにそのまま貼って実行させる**ための自己完結した指示書。
> 貼られた側はこの会話の文脈を持たない前提で書いてある。以下をすべて読んでから着手すること。

対象リポジトリ:
1. **`overwatch-hero-stats`** (private・GitHub Actions で日次収集する本体) ← **修正の主対象**
2. **`web_overwatch`** (攻略サイト本体・`D:\codex\_inspected\web_overwatch`) の `scripts/fetch-hero-stats.mjs` ← 同一スクリプトのミラー。**両方に同じ変更を入れる**

---

## 1. 何が壊れているか (背景)

`scripts/fetch-hero-stats.mjs` は Blizzard 公式 rates ページ
`https://overwatch.blizzard.com/ja-jp/rates/?<filters>` の **SSR HTML** を正規表現でスクレイプし、
ヒーロー別の 勝率/ピック率/BAN率 を `src/data/hero-stats/YYYY-MM-DD.json` に日次保存している。

**2026年6月後半〜7月頭に、Blizzard が rates ページのレンダリング方式を変更した。**
現在、SSR HTML には**既定ビューの1組の数値しか埋め込まれておらず**、`map` / `tier` / `rq`(QP/競技) の
絞り込みは**ページ読み込み後にクライアントJS(`rates.js`)が別のJSONエンドポイントを叩いて**適用している。

スクレイパーはJSを実行しないため、`map`/`tier`/`rq` に何を指定しても常に既定ビューを読む
→ **その3軸が全て同値に潰れる**。`region`/`input` はSSR(エッジのキャッシュ変種)に焼き込まれているので
今も正しく変動する、という非対称になっている。

### 実証済みの症状 (2026-07-05 ライブ確認)
- SSR HTML: `tier=All / Grandmaster / Bronze`、`map=all-maps / kings-row`、`rq=1 / 0` の5リクエストが
  **バイト完全同一 (163010B)**・ana 全て 46.2%・`<option ... selected>` 無し。
- 保存済みデータでも不良日 (2026-06-24, 06-30, 07-01, 07-02, 07-04) は全ティア同値・BAN率0。
  正常日 (06-07, 06-10, 06-17, 06-29, 07-03) はティアが分散 = 移行途中のロールアウトだった。
- 収集スクリプトの既存ガード (`slugCount===0` / `slugCount!==nameCount`) は**この縮退を検知できず**、
  縮退データが5日分そのまま保存されていた。

---

## 2. 修正方針: SSRスクレイプ → JSONエンドポイント直叩き

`rates.js` を解析した結果、フィルタ変更時に叩いているエンドポイントが判明した。
**これは公式ページ自身がフィルタリングに使っている唯一のデータ源**であり、`tier`/`map`/`rq` を正しく反映する。

### エンドポイント仕様 (2026-07-05 実証済み)
```
GET https://overwatch.blizzard.com/ja-jp/rates/data/?<同じクエリパラメータ>
    ヘッダ:
      User-Agent: <既存のUAをそのまま>
      Accept-Language: ja,en
      X-Requested-With: XMLHttpRequest      ← これが無いと 200 だが挙動が異なる可能性。必ず付ける
    → Content-Type: application/json; charset=utf-8
```
- クエリパラメータ名は**現行スクリプトと完全に同じ** (`input` / `map` / `region` / `role` / `rq` / `tier`)。
  したがって `FILTERS` 行列・軸の直積ロジックは**一切変更不要**。URLの `/rates/` を `/rates/data/` に変えるだけ。
- ティアが正しく反映されることを実測 (ana):

  | tier | win / pick / ban |
  |---|---|
  | All | 46.2 / 38.1 / 0 |
  | Grandmaster | **47.2 / 54.2** / 0 |
  | Bronze | **47 / 21.8** / 0 |

### レスポンス構造 (実測)
```jsonc
{
  "rates": {
    "rates": [
      {
        "id": "dva",                                  // ← ヒーロー slug (ハイフン含む: soldier-76 等)
        "cells": { "name": "D.Va", "winrate": 45, "pickrate": 6.8, "banrate": 0 },  // ← 数値そのまま
        "hero": { "color": "...", "name": "D.Va", "portrait": "https://...", "subrole": "initiator", "role": "TANK", "roleIcon": "https://..." }
      }
      // ... 52行 (ヒーロー数)
    ]
    // rates.rates 以外にもキーがある (計3キー)。使うのは rates.rates のみ。
  },
  "columns": [ { "id": "name", ... }, { "id": "pickrate", ... }, { "id": "winrate", ... } ]
}
```
- 各行 `id` = slug、`cells.winrate` / `cells.pickrate` / `cells.banrate` が欲しい数値 (既に number 型)。
- **HTMLスクレイプより遥かにクリーン**: 正規表現不要、slug との紐付けも `id` で確実、ロール情報も付属。

---

## 3. 具体的なコード変更 (`scripts/fetch-hero-stats.mjs`)

### 3-1. URL生成: `/rates/` → `/rates/data/`
現状:
```js
const BASE = "https://overwatch.blizzard.com/ja-jp/rates/";
```
変更後:
```js
const BASE = "https://overwatch.blizzard.com/ja-jp/rates/";
const DATA_ENDPOINT = "https://overwatch.blizzard.com/ja-jp/rates/data/"; // JSON APIエンドポイント
```
`buildUrl(filter)` は `DATA_ENDPOINT` を使うよう変更 (BASEはコメント/出典表示用に残してよい):
```js
function buildUrl(filter) {
  const qs = new URLSearchParams(filter).toString();
  return `${DATA_ENDPOINT}?${qs}`;
}
```

### 3-2. 取得: XHRヘッダを付け、JSONを返す
現状の `fetchHtml(url)` を `fetchJson(url)` に置換:
```js
async function fetchJson(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "ja,en", "X-Requested-With": "XMLHttpRequest" }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  throw lastError;
}
```

### 3-3. パース: 正規表現 → JSON 走査
現状の `parseRates(html)` (正規表現で `id="slug-winrate-value"` を拾う実装) を全面置換:
```js
// 数値の正規化: number ならそのまま。null / 非数値 / "--" は null。
function normNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim().replace(/%$/, "");
  if (s === "--" || s === "") return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

// JSON から { slug: {win, pick, ban} } を抽出。
function parseRates(json) {
  const rows = json?.rates?.rates;
  if (!Array.isArray(rows)) return { heroes: {}, slugCount: 0, rowCount: 0 };
  const heroes = {};
  for (const row of rows) {
    const slug = row?.id;
    if (!slug) continue;
    const c = row.cells ?? {};
    heroes[slug] = { win: normNum(c.winrate), pick: normNum(c.pickrate), ban: normNum(c.banrate) };
  }
  const slugCount = Object.keys(heroes).length;
  return { heroes, slugCount, rowCount: rows.length };
}
```
**出力JSONの形は変えないこと。** ダウンストリーム (`src/lib/hero-stats.ts`) は各スナップショットの
`heroes[slug].{win,pick,ban}` を読むので、この shape を厳守する。

### 3-4. main ループの取得・ガードを差し替え
現状は `fetchHtml` → `parseRates(html)` → `slugCount===0` / `slugCount!==nameCount` で判定している。
`nameCount` は HTML の `class="hero-name"` 由来なので JSON では取れない。次のように置換:
```js
const json = await fetchJson(url);
const { heroes, slugCount, rowCount } = parseRates(json);
if (slugCount === 0) {
  console.error(`  ✗ ${label}: 0件 (レスポンス構造が変わった可能性。rates.rates を要確認)`);
  failures.push({ filter, url, message: "0件 (parse失敗の疑い)" });
} else if (slugCount !== rowCount) {
  console.error(`  ✗ ${label}: slug ${slugCount} / 行 ${rowCount} (差分=id欠落の取りこぼし)`);
  failures.push({ filter, url, message: `一部取りこぼし (slug ${slugCount} / 行 ${rowCount})` });
} else {
  console.log(`  ✓ ${label}: ${slugCount} 件`);
  snapshots.push({ filters: filter, url, heroCount: slugCount, heroes });
}
```

### 3-5. 縮退検知ガードを追加 (再発防止・重要)
保存直前 (`snapshots.length === 0` チェックの前後) に、**軸が潰れていないかの sanity check** を入れる。
今回のような「静かな汚染」を将来また食らわないための安全網。
```js
// 縮退検知: 同一 (input, map, region, rq) 内で、ティア変種の heroes が全て All と同値なら
// tier 軸が効いていない (SSRフォールバック等) 疑い → その日の保存を中断する。
function heroesSignature(heroes) {
  return Object.keys(heroes).sort().map((s) => `${s}:${heroes[s].win},${heroes[s].pick},${heroes[s].ban}`).join("|");
}
{
  const byGroup = new Map(); // key: input|map|region|rq → Map(tier → signature)
  for (const s of snapshots) {
    const f = s.filters;
    const key = `${f.input}|${f.map}|${f.region}|${f.rq}`;
    if (!byGroup.has(key)) byGroup.set(key, new Map());
    byGroup.get(key).set(f.tier, heroesSignature(s.heroes));
  }
  let collapsedGroups = 0, tierGroups = 0;
  for (const [, tiers] of byGroup) {
    if (tiers.size < 2 || !tiers.has("All")) continue; // ティア展開がある競技グループのみ対象
    tierGroups++;
    const allSig = tiers.get("All");
    const everyTierEqualsAll = [...tiers].every(([, sig]) => sig === allSig);
    if (everyTierEqualsAll) collapsedGroups++;
  }
  if (tierGroups > 0 && collapsedGroups === tierGroups) {
    console.error(
      `\n縮退検知: 全 ${tierGroups} グループでティア変種が All と完全同値。` +
        ` tier軸が反映されていない (エンドポイント/仕様変更の疑い)。保存を中断します。`
    );
    process.exit(1);
  }
  if (collapsedGroups > 0) {
    console.warn(`\n⚠ 縮退検知: ${collapsedGroups}/${tierGroups} グループでティアが同値 (部分的な異常)。値を確認すること。`);
  }
}
```

### 3-6. 冒頭コメントの更新
ファイル先頭の「仕組み」コメント (SSR/正規表現前提の記述) を、JSONエンドポイント方式に書き換える。
出典明記の義務 (「Blizzard 公式データ (overwatch.blizzard.com/rates) をもとに作成」) は**変更しない**。

---

## 4. 守るべき制約
- **新しい依存を追加しない。** ネイティブ `fetch` + `JSON.parse` のみ (cheerio/puppeteer/playwright 不要)。
- **公式サイトへの大量・高頻度アクセスをしない。** フィルタ間ディレイ (既定1000ms) を維持。
  検証は `--dry --limit=5 --delay-ms=0` の短縮実行で行い、フル取得 (1674件) は日次ワークフローに任せる。
- **出力JSONの shape を変えない** (`snapshots[].heroes[slug].{win,pick,ban}`)。
- 秘密情報 (`HERO_STATS_TOKEN` 等) を表示・コミットしない。

---

## 5. 検証手順
サイト側リポジトリ (`web_overwatch`) で:
```
node --check scripts/fetch-hero-stats.mjs
npm run stats:fetch -- --dry --limit=16 --delay-ms=1500
```
- `--limit=16` は「PC × all-maps × Asia × (QP1 + 競技8ティア)」を含む範囲。
  **ティア間で win/pick が分散していること**を目視確認する (例: ana が All 46.2 / GM 47.2 / Bronze 47 のように違う)。
- 全ティア同値なら縮退検知が発火して exit 1 になるはず (= ガードが機能している)。
- BAN率が競技高ティアで非0になるヒーロー (例: よくBANされるタンク/サポート) があることも確認。
- map差の確認は任意 (ana 等は all-maps と個別マップで一致することもある。マップ依存が明確なヒーローで見ると良い)。

---

## 6. 別リポジトリ (`overwatch-hero-stats`) への反映
- **実際の日次収集はこのリポジトリの GitHub Actions で走る。** サイト側の `scripts/fetch-hero-stats.mjs` は
  手動確認用のミラーなので、**同じ修正を `overwatch-hero-stats` 側の同名スクリプトにも入れること**。
- 反映後、ワークフローを1回 `workflow_dispatch` で手動実行し、生成された `YYYY-MM-DD.json` で
  ティアが分散していることを確認してから日次運用に戻す。
- 手順の詳細は `docs/hero-stats-data-repo-setup.md` を参照。

---

## 7. 完了後にやること (サイト側)
- ヒーロー詳細ページ (`src/pages/heroes/[slug].astro`) に「ティア別の勝率」ラダー (`.tier-ladder`) が既に実装済みで、
  「ティア間に差が無ければ非表示」のガードが入っている。**データ源が直れば自動的に表示される**ので、
  修正後の新スナップショットが1つ入った状態で `npm run build` し、ヒーロー詳細でラダーが出ることを確認する。
- 関連ドキュメントを同期: `docs/design-foundation-2026-07-05.md` (L2① の「データ源のティア軸が全ティア同値」の
  但し書きを解消)、必要なら `project_stats_analytics` メモリの収集方式の記述も更新。

---

## 付録: 診断の生ログ (参考)
- SSR (`/rates/`) は tier/map/rq を変えてもバイト同一・`selectedTier=null`。region/input のみ変動。
- JSON (`/rates/data/`) は tier で明確に変動 (ana: All 46.2/38.1/0, GM 47.2/54.2/0, Bronze 47/21.8/0)。
- `rates.js` 内の該当コード:
  `fetch(`/${urlLocale}/rates/data/?${r.toString()}`,{headers:{"X-Requested-With":"XMLHttpRequest"}}).then(t=>t.json())`
