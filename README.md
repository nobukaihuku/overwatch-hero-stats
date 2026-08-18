# overwatch-hero-stats

Overwatch 公式 rates の勝率/ピック率/BAN率スナップショットを日次収集し、時系列資産として貯めるデータリポジトリ。
攻略サイト(overwatch-strategy-site)がビルド時に取得して表示する。

- 出典: Blizzard 公式データ (overwatch.blizzard.com/rates) をもとに作成。数値のみ使用・公式画像/ロゴ転載不可。
- 収集: `.github/workflows/hero-stats.yml`(日次 03:00 UTC)。手動は Actions の Run workflow、またはローカルで `STATS_OUT_DIR=hero-stats npm run stats:fetch`。
- 出力: `hero-stats/YYYY-MM-DD.json`。
- 重複排除(2026-07-12): 直近スナップショットとデータ同一の日 (capturedAt のみ差分) は保存・コミットされない。日付の欠落は「データ未変化」または「収集失敗」(Actions ログで区別)。
- 縮退検知(2026-07-19): 公式が rq/map フィルタを無視してクイック・プレイの既定ビューを返す日は保存されない(`assertRankedAxisNotCollapsed`)。したがって日付の欠落は「データ未変化」「収集失敗」に加えて「縮退日」も意味する(Actions ログで区別)。詳細は `hero-stats-collector-fix-2026-07-19.md`。
- 部分欠損(2026-08-18): HTTP/JSON/`rates.selected` の一時欠損は全フィルタ巡回後に再試行し、回復しないフィルタだけを除外して保存する。取得率が2/3未満のマップは成功分も含めてマップ全体を隔離し、隔離分を含む全体欠損が5%以内の場合だけ残りを保存する。ヒーローの未提供値は0にせず`null`で保持し、`collectionQuality`に失敗フィルタ・隔離マップ・欠損ヒーロー/指標・軸別coverageを記録する。前回スナップショット比でヒーロー行が大きく欠ける場合、選択値の不一致、隔離後も残る軸集中欠損、全体5%超の欠損は保存しない。
- private リポジトリ。サイト側のビルド時取得には読み取りトークン(Contents:Read)を使う。
