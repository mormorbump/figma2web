---
name: figma2web
description: Figmaデザインを Next.js（対象アプリ ボイラープレート）でピクセル単位に再現するためのオーケストレーションスキル。Figma REST APIで絶対ジオメトリと参照PNGを取得し、壊れたレイヤー階層を無視してジオメトリから構造を再構築、対象アプリ規約でコード生成し、スクショ差分ループで忠実度を詰める。トリガー: 「Figmaを再現」「figma2web」「Figmaから実装」「Figmaをコード化」「FigmaをNextで」「デザインをピクセルパーフェクトに」「reproduce Figma」「figma to code」。Figmaのフレーム/ページをWebに起こす全タスクで使う。
---

# figma2web

Figma デザインを **見た目はピクセル単位で忠実に、実装は Web ベストプラクティスで** Next.js（対象アプリ）に再現する。

## 中核思想（これを外すと破綻する）

1. **Figma は「見た目の正解」であって「構造の正解」ではない。** レイヤーツリー（グループ/フレームの入れ子）はしばしば壊れている。**構造はジオメトリ（絶対座標）から再構築する。ツリーはヒント止まり。**
2. **Figma は視覚的にも未完成。** フレーム幅を変えても内部テキストが追従しない等。**literal にコピーせず**、レスポンシブ・テキスト折返し・セマンティクス・状態は Web ベストプラクティスで補う。
3. **「忠実度」と「実装品質」を 2 ゲートに分離する**（最重要・下記）。
4. **テキストはピクセル差分しない。** Figma とブラウザでフォントレンダラが違うので、テキスト境界は必ず差分が出る。テキストはレイアウトボックス（位置/サイズ/色）で見る。

### 2 つのゲート（"逸脱したいのに差分で罰する"矛盾の解消）

| ゲート | 測るもの | 方法 |
|---|---|---|
| **A 静的忠実度** | デザイン幅で同じ見た目か | フリーズ描画（レスポンシブ無効・デザイン幅固定）で参照PNGと**領域別**比較。`${CLAUDE_SKILL_DIR}/tools/visual-diff/visual_diff.py` |
| **B 実装品質** | Webとして正しいか | 375/750/desktopでoverflow無し・ランドマーク/見出し・状態(hover/focus)。**ピクセル差分しない** |

差分ループ（修正の自動反復）が駆動するのは **ゲートA だけ**。意図的な逸脱はゲートBで担保する。

## 前提セットアップ

- Figma PAT（scope `File content (read)`）を `.env` の `FIGMA_SECRET_KEY`（または環境変数 `FIGMA_SECRET_KEY`/`FIGMA_TOKEN`）に設定。ツールが `.env` を自動読込。argv・`.context`・index.json に**書かない**。`.env` は gitignore 済み。
- **対象サイト/フレームの Figma 共有URL（`node-id` 付き推奨）を `.env` の `FIGMA_FILE_URL` に設定する。** 以降ツールはこれを既定ターゲットにするので、各コマンドで URL を渡さない（`--node` でフレーム選択のみ）。トークンも `.env` から自動ロードされるので `FIGMA_TOKEN=…` の前置きも不要。
- `mcp-browser-observer` はプロジェクトの `.mcp.json` で `BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false` を設定済み（localhost 観測のため）。初回はプロジェクトMCPの承認が必要。
- 対象アプリで `npm install` 済みであること（dev サーバ起動＝VERIFY の前提）。
- **ツールのパス**: 本スキルに同梱の `tools/` を使う。コマンドは常に絶対パス `${CLAUDE_SKILL_DIR}/tools/...` で叩く（project/personal/plugin のどのモードでも CWD 非依存で解決される）。出力（`.context/figma/...` 等）は CWD＝対象アプリのプロジェクトルート相対。
- ツール依存: Node 20+ のみ（figma-ingest/layout-reconstruct は依存ゼロ、`npm install` 不要）。Python 側（visual-diff）は **初回に venv を `.context/figma2web/.venv` へ自前で作る**:
  ```
  python3 -m venv .context/figma2web/.venv && .context/figma2web/.venv/bin/pip install -r "${CLAUDE_SKILL_DIR}/tools/visual-diff/requirements.txt"
  ```
  以降の Python 実行は `.context/figma2web/.venv/bin/python "${CLAUDE_SKILL_DIR}/tools/visual-diff/<script>.py"`。venv をプロジェクト側 `.context` に置くのは、plugin cache が更新で消えても再生成でき、全モードでパスが一致するため。
- `mcp-browser-observer` MCP が接続済みであること（実ブラウザ観測）。
- 観測は dev の `/sample` basePath 配下を `BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false` で。

## ワークフロー（各ステージは独立 subagent + `.context` でファイル受け渡し）

> トークン予算: PNG はパス参照のみ。モデルに貼るのは**領域 crop だけ**（全体スクショ自己批評は精度が低い）。各ステージを別 subagent に分けて会話状態を膨らませない。

### 0. ターゲット選定
```
node "${CLAUDE_SKILL_DIR}/tools/figma-ingest.js" --list
```
`.env` の `FIGMA_FILE_URL` のファイルからフレーム一覧を出し、node-id を確認。最初は**代表 1 フレーム**に絞る。

### 1. INGEST
```
node "${CLAUDE_SKILL_DIR}/tools/figma-ingest.js" --node <id> --out .context/figma --scale 2
```
（URL は `.env` の `FIGMA_FILE_URL` を参照。`--node` でフレーム選択のみ。`FIGMA_FILE_URL` が node-id 付きなら `--node` も省略可。）
出力: `.context/figma/<slug>/{model.json, ref.png, assets/, index.json}`。
- `index.json` の `fonts` を確認。`availability:"unknown"` のフォントは代替を pin（テキストはピクセル差分しない）。

### 2. RECONSTRUCT（候補生成）
```
node "${CLAUDE_SKILL_DIR}/tools/layout-reconstruct.js" --in .context/figma/<slug>
```
出力: `ir-candidates.json`（背景分離・包含・行/列/グリッド・重なり・部品の**候補**）。これは確定ではない。

### 3. 早期チェックポイント（ここで必ず一度止める）
```
.context/figma2web/.venv/bin/python "${CLAUDE_SKILL_DIR}/tools/visual-diff/overlay.py" --in .context/figma/<slug>
```
`ir-overlay.png` を **Read して目視**。色付き枠が視覚的グルーピングと合っているか確認。
- **参照PNG `ref.png` と `ir-overlay.png` を見比べ、LLM（あなた）が最終構造を決める。** flex/grid/absolute、グルーピング、セマンティック役割（header/nav/section/button/list…）を確定。
- 重なり(`absoluteCandidate`)は `position:absolute`、それ以外は flex/grid。
- `component` フラグ／`index.json` の `componentFamilies` を見て、**ファミリー単位で 1 React コンポーネントを作り再利用**する（写経しない）。
- **バリアントは設計意図**: `プロパティ1=desktop/mobile` はレスポンシブ、`EN_active/JP_inactive` 等は状態。バリアントは props や `mq(md)` 切替に対応づける（Figma の desktop/mobile バリアントがあればレスポンシブの実データとして使う）。
- マスター定義は別の「Component」ページにあることが多い。必要なら `figma-ingest --node <Componentページのid>` で**コンポーネントライブラリ自体を取得**し、ページ横断で同一ファミリーを共有する。
- 構造が怪しければ INGEST/閾値を見直す。**構造が正しいと確信するまで GENERATE に進まない**（差分ループは構造の誤りを直せない）。

### 4. GENERATE（web-frontend-builder に委譲）
`web-frontend-builder` スキルの流儀で、**対象アプリ 規約厳守**で実装:
- 出力は `src/components/page/<name>/` のページコンポーネント＋ `src/app/<route>/page.tsx` の薄いシェル。
- 名前付き export / props型 `TProps` / `any`禁止 / コンポーネントは arrow function / SCSS modules（先頭 `@use "@/styles/abstracts/index" as *;`）/ `rem()` / 単一 breakpoint `mq(md:750px)`。
- 既存 `elements`/`container` を再利用（カスタム `<Image>`(picture, next/imageではない)・`<Typography>`(`data-font-setting`)・`<Stack>` 等）。
- **必須成果物**: Figma の text style から `[data-font-setting='…']` の CSS（font-family/size/line-height/weight/letter-spacing）を生成。色/余白トークンは `src/styles/abstracts/_variables.scss` に追加。
- 構造は flex/grid 基本。重なりのみ `position:absolute`。**絶対配置の写経は禁止。**
- レスポンシブ/状態/セマンティクスは Web ベストプラクティスで補う。
- アセット: ラスタ画像→`public/assets/images/original/`→`npm run sharp`（変換完了を待つ）。SVG→`src/assets/images/svg/`→`npm run svgr`。

### 5. VERIFY & REFINE（2 ゲート, frontend-observation + visual-diff）
dev 起動（`BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false`）→ `http://localhost:<port>/sample/<route>`。`fonts.ready`・画像 decode・sharp 変換完了を待つ。

**ゲートA ループ（≤6回・改善<0.01で早期終了）:**
1. **デザイン幅・DPR を参照に一致させて** `actual.png` を撮る（参照は scale2＝例 2880px 幅）。既定ビューポート(1280px)では差分が無意味。ヘッドレス Chrome を `--headless --force-device-scale-factor=2 --window-size=1440,<H> --screenshot` で駆動するか、actual を 2880px 幅にリサイズしてから diff。
2. `.context/figma2web/.venv/bin/python "${CLAUDE_SKILL_DIR}/tools/visual-diff/visual_diff.py" --ref ref.png --actual actual.png --text-boxes text_boxes.json --decoration-boxes decoration_boxes.json --scale 2`（`text_boxes.json`＝INGEST 自動生成、`decoration_boxes.json`＝RECONSTRUCT 自動生成。`--scale` は ingest と同値）。**`contentFidelity`（テキスト＋装飾除外の実コンテンツ忠実度）で判断**。残差が装飾背景なら構造はOK。
3. `report.json` の `regions[]` が残るなら、その領域の `crops/region*_{ref,actual}.png` を Read して**局所修正** → 再描画 → 再比較
4. 非テキスト領域が許容内になれば DONE

**ゲートB:** 375/750/desktop で `browser_audit`。overflow・ランドマーク/見出し階層・alt・focus可視・状態を確認。**ピクセル差分しない。**

**人間サインオフ:** `ref.png`/`actual.png`/`diff_out/diff.png` の三面図＋各幅スクショ＋a11yサマリを `.context` に残す。

### 6. 恒久化
合格したら `playwright-e2e` でデザイン幅の visual regression を作る。**baseline は Figma 参照PNGではなく「合格した実描画スクショ」**（フォント差を偽陽性にしない）。

## 再実行（冪等性）
生成物は既知パスへ**丸ごと再生成**。人手修正は別レイヤー/別ファイルに置く。INGEST は `index.json.frame.fileVersion` でキャッシュ判定。

## やってはいけないこと
- レイヤーツリーをそのまま codegen（壊れた階層を継承する）
- テキストをピクセル差分して font AA を追いかける
- 全体スクショを丸ごとモデルに貼って自己批評させる（領域 crop を使う）
- `FIGMA_TOKEN` を argv/`.context`/index.json/ログに残す
- 絶対配置の写経（重なり以外は flex/grid）
- `/`（basePath無し）へ navigate（404）

## 参照
- ツール詳細: `${CLAUDE_SKILL_DIR}/tools/README.md`
- 連携スキル: `web-frontend-builder`（GENERATE被委譲）, `frontend-observation`（観測）, `playwright-e2e`（回帰）。原典URLとカスタマイズは README の「連携スキル」節。
