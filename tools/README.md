# figma2web tools

`figma2web` スキルが使う 3 つのツール。Figma REST から取得 → ジオメトリで構造再構築 → 実描画と参照PNGの差分、を担う。
設計の根拠と全体像は `.claude/skills/figma2web/SKILL.md` を参照。

## セットアップ

```bash
# Node ツール（依存ゼロ, Node 20+）
node tools/figma-ingest.js --help        # 引数は下記

# Python 差分ツール（OpenCV/Pillow）
cd tools/visual-diff
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Figma PAT（scope **File content (read)**）は次のいずれかで渡す。argv・`.context`・`index.json`・ログには残さない（ADR-0001）。
- **`.env` ファイル（推奨）**: プロジェクトルートに `FIGMA_SECRET_KEY=figd_xxx`（`.env.example` 参照）。ツールが自動で読み込む。`.env` は gitignore 済み。
- 環境変数: `FIGMA_SECRET_KEY` または `FIGMA_TOKEN`（fish 例: `set -x FIGMA_SECRET_KEY figd_xxx`）。

## 1. figma-ingest （Node）

Figma REST からフレームを取得し、正規化モデル・参照PNG・アセット・index.json を書き出す。

```bash
# 対象フレームの node-id を一覧
FIGMA_TOKEN=… node tools/figma-ingest.js --url "<figma url>" --list

# 取得
FIGMA_TOKEN=… node tools/figma-ingest.js --url "<url>" --node 12:34 --out .context/figma --scale 2
```

出力 `.context/figma/<node-slug>/`:
- `model.json` — 全ノードの絶対座標＋スタイル（親子は `parentId` に残すが構造には使わない）
- `ref.png` — サーバーレンダリングの参照画像（**ゲートA の基準**, scale 既定 2）
- `assets/` — image fill の PNG・ベクターの SVG
- `index.json` — フレーム/サイズ/フォント/アセット一覧（**トークンや認証付きURLは書かない**）

フラグ: `--scale <n>`（既定2）, `--no-assets`, `--list`。

## 2. layout-reconstruct （Node）

`model.json` の絶対ジオメトリから**候補 IR** を生成。レイヤーツリーは無視。

```bash
node tools/layout-reconstruct.js --in .context/figma/<slug>
```

やること（design §3.2）:
- **背景分離**: 全面を覆う装飾レイヤー（塗り/画像の leaf）を `backgrounds` に分離。painted leaf は containment 親になれない（全面背景が全要素の親になる罠を回避）。
- **包含再構築**: 最小外接矩形＝親（plausible container のみ親候補）。
- **行/列/グリッド推定**: 射影＋gap 中央値。
- **重なり検出**: `absoluteCandidate` フラグ（→ `position:absolute` 候補）。`layoutPositioning:ABSOLUTE` は信頼。
- **部品検出**: 同一 `componentId` を再利用候補に。

出力 `ir-candidates.json`。**これは確定ではない** — スキル/LLM が `ref.png` を見て最終決定する。

## 3. visual-diff （Python / OpenCV）

### overlay.py — 早期構造チェック
`ir-candidates.json` の枠を `ref.png` に重ねて目視確認用 `ir-overlay.png` を出す（コード生成前のゲート, design §3.3）。
```bash
tools/visual-diff/.venv/bin/python tools/visual-diff/overlay.py --in .context/figma/<slug>
```
凡例: 青=container 緑=text 橙=image 紫=icon 赤=component `*`=absolute候補

### visual_diff.py — ゲートA の領域別差分
実描画スクショと `ref.png` を**領域別**に比較。テキスト領域は除外（フォントレンダラ差は想定ノイズ）。差分領域の crop を出してローカル修正に回す。
```bash
tools/visual-diff/.venv/bin/python tools/visual-diff/visual_diff.py \
  --ref .context/figma/<slug>/ref.png \
  --actual .context/figma/<slug>/actual.png \
  --out-dir .context/figma/<slug>/diff_out \
  --scale 2 [--text-boxes text_boxes.json] [--delta-e 6] [--top-k 8]
```
出力: `diff.png`（ヒートマップ）, `crops/region*_{ref,actual}.png`, `report.json`（`nonTextFidelity`, `regions[]`, `verdict`）。
exit code: 0=有意な非テキスト差分なし, 1=差分残り, 2=エラー。

`--text-boxes` は TEXT ノードのフレーム座標 `[{x,y,w,h},…]`（`model.json` から生成）。

## パイプライン全体
```
figma-ingest → layout-reconstruct → overlay.py(目視) → [GENERATE] → browser-observer screenshot → visual_diff.py → 修正ループ
```
詳細手順は `.claude/skills/figma2web/SKILL.md`。
