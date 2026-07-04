# overwatch-hero-stats

Overwatch 公式 rates の勝率/ピック率/BAN率スナップショットを日次収集し、時系列資産として貯めるデータリポジトリ。
攻略サイト(overwatch-strategy-site)がビルド時に取得して表示する。

- 出典: Blizzard 公式データ (overwatch.blizzard.com/rates) をもとに作成。数値のみ使用・公式画像/ロゴ転載不可。
- 収集: `.github/workflows/hero-stats.yml`(日次 03:00 UTC)。手動は Actions の Run workflow、またはローカルで `STATS_OUT_DIR=hero-stats npm run stats:fetch`。
- 出力: `hero-stats/YYYY-MM-DD.json`。
- private リポジトリ。サイト側のビルド時取得には読み取りトークン(Contents:Read)を使う。
