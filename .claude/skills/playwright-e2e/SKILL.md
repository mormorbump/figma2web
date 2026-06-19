---
name: playwright-e2e
description: "フロントエンドテスト（unit/integration/E2E/ビジュアル/a11y）を計画・実装・デバッグする。mcp-browser-observer MCP（Playwrightベースの browser_* ツール）で実ブラウザ/E2E自動化を行い、Vitest/Jest/RTL、flakyテストの切り分け、CIの安定化、決定的な入力とスクリーンショット/状態アサーションが必要な canvas/WebGL ゲーム（Phaser）にも対応する。トリガー: 「test」「E2E」「flaky」「visual regression」「Playwright」「game testing」。"
metadata:
  short-description: "Frontend testing on the mcp-browser-observer MCP: E2E, Vitest, flaky triage, game testing."
---

# フロントエンドテスト

正しいテスト層を選び、アプリを観測可能にし、非決定性を排除することで、失敗を解析可能にしながら、素早く確実な信頼性を手に入れましょう。

## 実行基盤: mcp-browser-observer

このスキルは、実ブラウザ層として **mcp-browser-observer** MCP（ツール名プレフィックス `browser_`、完全修飾名 `mcp__mcp-browser-observer__browser_*`）を駆動します。この MCP は Playwright（Chromium）をバックエンドに持ち、ケイパビリティのみを提供します。テストの方法論はこのスキルが担います。

2つの層、1つの基盤:
- **ブラウザ操作ステップ**（E2E、ゲームフロー、ビジュアルキャプチャ）は `browser_*` ツールを使用します。
- **ランナー非依存の層**（unit（Vitest/Jest）、component（RTL）、ピクセル差分（`imgdiff.py`）、CI 配線）は MCP に触れず、変更もありません。

ツールマッピング（公式 Playwright MCP → この MCP）:

| 用途 | `browser_*` ツール / 備考 |
|------|-------------------------|
| ナビゲート | `browser_navigate`（`url` を渡す。`localhost` がブロックされないよう `BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false` で dev サーバーを起動すること） |
| コンソールメッセージ | `browser_observe` — console errors/warnings/全メッセージを返す |
| ネットワークリクエスト | `browser_observe` — 失敗リクエストと non-2xx リクエストを返す |
| DOM / 要素参照 | `browser_observe` — DOM アウトライン + インタラクティブ要素。snapshot ref ではなく **CSS セレクター** で操作する |
| クリック | `browser_click { selector }` |
| キーボード | `browser_press_key { key }` (実際の keydown/keyup; WASD/矢印キー) |
| テキスト入力 | `browser_type { selector, text }` (値をセット; キーイベントには `browser_press_key` を使用) |
| アプリ状態の読み取り | `browser_evaluate { expression }` — **サンドボックス**: 1000文字以下; `require/import/process/fs/Function/eval/globalThis` はブロック。`window.__TEST__` のみを参照し、式は JSON シリアライズ可能なデータを返す必要がある |
| スクリーンショット | `browser_screenshot`（`.browser-observer/screenshots` 配下に保存） |
| 準備完了まで待機 | DOM ready マーカーに対して `browser_wait { selector }` を使うか、`browser_evaluate “window.__TEST__?.ready === true”` をポーリングする（`browser_wait` は任意の JS をポーリングできない） |

**frontend-observation** スキルとの関係: そちらは同じ MCP 上で「今これは OK か？」を素早くインループで確認するもので、このスキルは確認済みの安定したフローを永続的な CI テストに変換します。frontend-observation で確認し、ここで定式化します。

## 哲学: 1分あたりの信頼性

フロントエンドのテストが失敗する理由は2つあります: プロダクトが壊れているか、テストが嘘をついているかです。あなたの仕事はシグナルを最大化し、「テストが嘘をつく」状況を最小化することです。

**テストを書く前に問いかけること**:
- どのユーザーリスクをカバーしているか（お金、進行状況、認証、データ損失、クラッシュ）?
- このバグクラスを検出できる最も狭い層はどこか（純粋なロジック vs UI vs フルブラウザ）?
- どのような非決定性が存在するか（時間、RNG、非同期ローディング、ネットワーク、アニメーション、フォント、GPU）?
- `setTimeout` 以外に待機できる「準備完了」シグナルは何か?
- 失敗時に何を print/screenshot すれば CI で診断可能になるか?

**コア原則**:
1. **実装ではなくコントラクトをテストする**: 安定したユーザー意味のある結果とパブリックなシームをアサートする。
2. **リトライよりも決定性を優先する**: 時間/RNG/ネットワークを制御可能にし、flake を根本から取り除く。
3. **デバッガーのように観察する**: 失敗時のコンソールエラー、ネットワーク障害、スクリーンショット、状態ダンプ。
4. **最初に1つのクリティカルフロー**: 信頼できるスモークテスト1つは、50個の flaky テストに勝る。

## テスト層の決定木

必要な信頼性を提供できる最もコストの低い層を選びます:

| 層 | 速度 | 用途 |
|-------|-------|---------|
| **Unit** | 最速 | 純粋な関数、reducer、バリデーター、数学計算、パスファインディング、決定論的シミュレーション |
| **Component** | 中程度 | モックされた IO を持つ UI の振る舞い（React Testing Library、Vue Testing Library） |
| **E2E** | 最遅 | ルーティング、ストレージ、実際のバンドリング/ランタイムをまたがるクリティカルなユーザーフロー |
| **Visual** | 特化 | レイアウト/ピクセルのリグレッション; canvas/WebGL の場合は決定性を固定した後にのみ実施 |

## クイックスタート: 最初のスモークテスト

1. **クリティカルフローを1つ定義する**: 「ページが読み込まれる → ユーザーが開始できる → 1つのキーアクションが機能する」
2. **テストシーム**をアプリに追加する（下記参照）
3. **ランナーを選択する**: E2E には mcp-browser-observer MCP（`browser_*`）、ロジックには unit テスト（Vitest/Jest）
4. **大きく失敗させる**: コンソールエラーと失敗リクエストをテストの失敗として扱う
5. **安定化する**: RNG シード固定、時間を凍結、viewport を固定、アニメーションを無効化

## 具体的な MCP ワークフロー: ゲームのテスト

mcp-browser-observer MCP 上で Phaser/canvas ゲームをテストするためのステップバイステップのシーケンス。`browser_evaluate` はJS の**式の文字列**（関数ではない）を受け取り、サンドボックス化されているため、準備完了はページ内 Promise ではなく DOM マーカーで待機します。

```
1. browser_navigate { url: "http://localhost:3000?test=1&seed=42" }
   (ナビゲーションは1回のみ。localhost が読み込まれるよう BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false で dev サーバーを起動すること。)

2. browser_wait { selector: "[data-test-ready]" }
   (シームに DOM ready マーカーをセットさせる。例: document.body.dataset.testReady = "1"
    代替案: browser_evaluate { expression: "window.__TEST__?.ready === true" } をポーリングする。)

3. browser_observe { includeScreenshot: false, maxElements: 20 }
   (1回の呼び出しでコンソールエラーとネットワーク障害の両方を返す。自ドメインのエラーがあれば失敗とする。)

4. browser_click { selector: "button#start" }
   (CSS セレクターで操作する — この MCP には snapshot-ref モデルがない。)

5. browser_evaluate { expression: "window.__TEST__.state()" }
   (ゲーム状態をアサートする。JSON シリアライズ可能なデータを返す必要がある; 式は1000文字以下。)

6. browser_press_key { key: "ArrowRight" }
   (実際の keydown/keyup — 移動には WASD/矢印キー。)

7. browser_evaluate { expression: "window.__TEST__.state().player.x" }
   (移動が発生したことを検証する。)

8. browser_screenshot
   (決定論的セットアップ後のビジュアルエビデンス; .browser-observer/screenshots 配下に保存。)
```

## 推奨テストシーム

テスト可能性のためにアプリに追加する（読み取り専用、安定、最小限）:

```javascript
window.__TEST__ = {
  ready: false,           // 最初のインタラクティブフレーム後に true
  seed: null,             // 現在の RNG シード
  sceneKey: null,         // 現在のシーン/ルート
  state: () => ({         // JSON シリアライズ可能なスナップショット
    scene: this.sceneKey,
    player: { x, y, hp },
    score: gameState.score,
    entities: entities.map(e => ({ id: e.id, type: e.type, x: e.x, y: e.y }))
  }),
  commands: {             // オプションのミューテーションコマンド
    reset: () => {},
    seed: (n) => {},
    skipIntro: () => {}
  }
};
```

**ルール**: ID と必須フィールドを公開し、生の Phaser/エンジンオブジェクトは公開しない。

## 避けるべきアンチパターン

❌ **間違った層でのテスト**: 純粋なロジックに E2E テストを使う
*魅力的な理由*: 「とにかくブラウザを通してすべてテストしよう」
*より良い方法*: ロジックには unit テスト; E2E は統合コントラクトのために残す

❌ **実装の詳細をテストする**: DOM 構造/クラス名をアサートする
*魅力的な理由*: DevTools で見えるものを簡単にアサートできる
*より良い方法*: ユーザーにとって意味のある出力をアサートする（テキスト、スコア、HP の変化）

❌ **Sleep 駆動のテスト**: `wait 2s then click`
*魅力的な理由*: シンプルで「自分のマシンでは動く」
*より良い方法*: 明示的な準備完了シグナルを待機する（DOM マーカー、`window.__TEST__.ready`）

❌ **制御されていないランダム性**: アサーションでの RNG/時間の使用
*魅力的な理由*: 「ゲームはランダムを使うので、テストも同様にすべき」
*より良い方法*: RNG をシード固定する（`?seed=42`）、時間を凍結する、安定した不変条件をアサートする

❌ **決定性なしのピクセルスナップショット**: Canvas スクリーンショットの flake
*魅力的な理由*: 「ビジュアルバグを自動的に検出できる」
*より良い方法*: まず決定論的モードを確立してから、既知の安定したフレームでスクリーンショットを撮る

❌ **戦略としてのリトライ**: 「リトライを3回に増やすだけ」
*魅力的な理由*: CI をグリーンにする簡単な修正
*より良い方法*: flake の根本原因を修正する; リトライは本当の問題を隠す

## 失敗したテストのデバッグ

テストが失敗した場合、次の順序でエビデンスを収集する:

1. **コンソールエラー + ネットワーク障害**: `browser_observe { includeScreenshot: false, maxElements: 20 }` — 1回の呼び出しで両方を返す; 自ドメインのコンソール/ページエラーや失敗/non-2xx リクエストがあれば失敗とする
2. **スクリーンショット**: `browser_screenshot` → 失敗時のビジュアル状態（`.browser-observer/screenshots` 配下に保存）
3. **アプリ状態**: `browser_evaluate { expression: “window.__TEST__.state()” }`
4. **flake の分類**（references/flake-reduction.md を参照）:
   - 準備完了? → 明示的な待機を追加
   - タイミング? → アニメーション/物理演算を制御
   - 環境? → viewport/DPR を固定
   - データ? → テストデータを分離

## 卒業基準: テストは「十分」か？

最低限のテストスイート:
- [ ] アプリが読み込まれ、主要なアクションが機能することを証明する **1つのスモークテスト**
- [ ] **テストシームが存在する**（ready フラグと state を持つ `window.__TEST__`）
- [ ] canvas/ゲームの**決定論的モード**（`?test=1` でシーディングを有効化）
- [ ] **コンソールエラーがテストを失敗させる**（サイレントな失敗なし）
- [ ] **CI がすべての push でテストを実行する**

次のレベルに進む条件:
- クリティカルなパス（認証、支払い、セーブ/ロード）に専用の E2E がある
- 複雑なロジック（パスファインディング、ダメージ計算、ステートマシン）を unit テストがカバーする
- 決定性が固定された主要画面（メニュー、HUD）でのビジュアルリグレッション

## imgdiff.py によるビジュアルリグレッション

スクリーンショットのピクセル比較:

```bash
# ベースラインと現在を比較
python scripts/imgdiff.py baseline.png current.png --out diff.png

# 小さな許容範囲を設定（アンチエイリアシングの差異）
python scripts/imgdiff.py baseline.png current.png --max-rms 2.0
```

終了コード: 0 = 同一、1 = 差異あり、2 = エラー

## UI スライスのリグレッション（ナインスライス / リボン / バー）

Canvas の UI の問題（パネルのシーム、セグメント化されたリボン、見えない HUD のフィル）は、完全なゲームプレイフローの代わりに専用の UI ハーネスで検出するのが最適です。

1. *UI アセットのみ*を読み込むシンプルな `test.html`/シーンを作成する。
2. 組み立て済みパネル（複数サイズ）の横に生のスライスをレンダリングし、「生のクロップ + スケール」と「スティッチされたマルチスライス」の両方のビューでリボン/バーを含める。
3. ブラウザ MCP が各モードを決定論的に切り替えられるよう、`window.__TEST__` に `.commands.showTest(n)` を公開する（`browser_evaluate { expression: “window.__TEST__.commands.showTest(2)” }` で操作する）。
4. 対象のスクリーンショット（パネル、リボン、バー）をキャプチャし、CI で差分を取る。

決定論的セットアップ + スクリーンショットのワークフローについては `references/phaser-canvas-testing.md` を参照。

## バリエーションガイダンス

コンテキストに応じてアプローチを調整する:
- **DOM アプリ**: `browser_click`/`browser_observe` で標準 CSS セレクターを使用し、`browser_wait` で要素を待機
- **Canvas ゲーム**: テストシームは必須、`window.__TEST__.ready` で待機
- **ハイブリッド**: メニューには DOM、ゲームプレイにはテストシーム
- **CI のみの GPU**: ソフトウェアレンダリングフラグが必要か、ビジュアルテストをスキップする可能性あり
- **UI スライスのリグレッション**: ナインスライス/リボン/バーのアーティファクトには、決定論的モードと対象スクリーンショットを持つ小さな UI ハーネスシーン/ページを優先する（`references/phaser-canvas-testing.md`）。

## 同梱リソース

必要に応じて参照:
- `references/playwright-mcp-cheatsheet.md`: **公式 Playwright MCP** API に対して書かれたツールパターン — 「実行基盤」上のマッピングテーブルを使用して各呼び出しを `browser_*` ツールに変換する（例: `browser_snapshot`+ref → `browser_observe`+CSS セレクター）
- `references/phaser-canvas-testing.md`: Phaser ゲームの決定論的モード
- `references/flake-reduction.md`: Flake の分類と修正

## 覚えておくこと

準備完了と状態のための小さく安定したシームを追加することで、ほぼあらゆるフロントエンド（canvas/WebGL ゲームを含む）をテスト可能にできます。信頼できるスモークテスト1つが基盤です。メンテナンスが退屈なテストを目指しましょう: 決定論的で、準備完了について明示的で、失敗エビデンスが豊富なもの。目標はカバレッジの数値ではなく、信頼性です。

## figma2web 連携

このスキルを figma2web プロジェクト（Figma デザインを Next.js / 対象アプリ で**ピクセル単位で再現**する）で使う場合の追加ルール（`figma2web` スキルから呼ばれる）。

### 差分ツールの使い分け（imgdiff.py より visual-diff を優先）

- 同梱の `scripts/imgdiff.py` は**単純な RMS 全面比較**である。Figma 再現では、フォントレンダラ差や意図的な逸脱を全面差分が罰してしまうため、これを合否ゲートにしない。
- Figma 再現の差分は `${CLAUDE_SKILL_DIR}/../figma2web/tools/visual-diff/visual_diff.py`（figma2web スキルに同梱、OpenCV ベース、`.context/figma2web/.venv` の python で実行）を優先して使う。これは**領域別（連結成分）比較＋テキスト領域除外**（テキストはピクセルでなくレイアウトボックスで比較）を行う。差分→LLM 修正の領域 crop 用途にも使う。figma2web が無い repo で本スキル単体起動した場合のみ上の `scripts/imgdiff.py` にフォールバック。

### 恒久回帰テストの baseline 戦略（役割を分ける）

- 恒久回帰テストは Playwright の `toHaveScreenshot` ベースで、**デザイン幅固定の visual regression** として作る。
- **baseline は Figma 参照 PNG ではなく、「合格した実描画スクショ」を baseline にする。** フォントレンダラ差を回帰の偽陽性にしないため。
- 役割を明確に分ける:
  - **Figma 参照 PNG** = 「初回の再現ターゲット」（ゲート A で最初に到達すべき正解）。
  - **回帰 baseline** = 「合格時の自分のスクショ」（以降の回帰検出の基準）。

### dev サーバ前提

- ページは basePath `/sample` 配下。`browser_navigate` は `http://localhost:<port>/sample/<route>` を渡す（`/` は 404）。
- ローカル dev のテストには `BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false` を設定して dev サーバ/MCP を起動する。

### テスト観点

- **ゲート A 回帰**: デザイン幅でのフリーズ描画スクショを `toHaveScreenshot` で回帰検出。
- **ゲート B**: 複数幅（375 / 750 / desktop）での overflow 無し・ランドマーク/見出し階層・状態（hover/focus/disabled）などの a11y 検証。ゲート B はピクセル差分しない。
