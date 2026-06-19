# figma2web

Figma デザインを **見た目はピクセル単位で忠実に、実装は Web ベストプラクティスで** Next.js に再現するための **Claude Code スキル + ツール群**。

figma2web は **レイヤーツリーを無視して絶対ジオメトリから構造を再構築**し、**サーバーレンダリングの参照画像とのスクリーンショット差分ループ**で忠実度を詰める。

## 何ができるか

Figma の任意のフレーム／ページを、**見た目はピクセル単位で忠実に、コードは Web ベストプラクティスで** Next.js のコンポーネントに起こす。ランディングページでも下層ページでも、同じワークフローで再現性高く実装できる。

複数ページ／サイトに展開する場合は、Figma の `componentId` で同一コンポーネントのインスタンスを束ね、**共有コンポーネントを 1 回だけ実装→各ページで再利用**する（desktop/mobile バリアント＝レスポンシブ、状態バリアント＝props）。

## 中核思想

1. **Figma は「見た目の正解」であって「構造の正解」ではない** — レイヤーツリーはヒント。構造は全ノードの `absoluteBoundingBox`（絶対座標）から再構築する。
2. **Figma は視覚的にも未完成** — literal にコピーせず、レスポンシブ・テキスト折返し・セマンティクス・状態は Web ベストプラクティスで補う。
3. **忠実度を 2 ゲートに分離** — ゲートA（デザイン幅固定で参照PNGと領域別比較）／ゲートB（複数幅で overflow・a11y・状態。ピクセル差分しない）。差分ループはゲートAだけを駆動。
4. **テキスト/装飾は除外して「実コンテンツ忠実度」で測る** — フォントレンダラ差や画像背景の CSS 近似は想定ノイズ。除外して測ることでスコアが意味を持つ。

## パイプライン（4 ステージ）

```mermaid
flowchart LR
    A["INGEST<br/>figma-ingest<br/>REST取得・正規化<br/>参照PNG・アセット・fonts"]
    B["RECONSTRUCT<br/>layout-reconstruct<br/>ツリー無視・背景分離<br/>包含/行列/重なり/部品"]
    C["GENERATE<br/>figma2web skill<br/>→ web-frontend-builder に委譲"]
    D["VERIFY & REFINE<br/>frontend-observation<br/>+ visual-diff<br/>2ゲート差分ループ"]
    A --> B --> C --> D
    D -- "差分が残れば該当領域を修正" --> C
```

複数ページに展開する場合も同じパイプラインを各ページに回すだけ。**共有コンポーネントを 1 回実装し、各ページは「共有コンポーネントの合成 ＋ 固有セクション」で再現**する。

## アーキテクチャ

`figma2web` スキルが全体をオーケストレーションし、中核ツール（`tools/`）と連携スキルを駆動する。観測能力は MCP に集約。

```mermaid
flowchart TB
    SKILL["figma2web skill<br/>オーケストレーション"]
    subgraph T["tools/（中核・依存ゼロ）"]
      ING["figma-ingest<br/>REST取得・正規化・参照PNG"]
      REC["layout-reconstruct<br/>ジオメトリ→構造再構築"]
      VD["visual-diff<br/>領域別差分・装飾除外"]
    end
    subgraph S["連携スキル"]
      WFB["web-frontend-builder<br/>GENERATE"]
      FO["frontend-observation<br/>観測（ゲートA/B）"]
      PE["playwright-e2e<br/>回帰テスト"]
    end
    MCP["mcp-browser-observer<br/>実ブラウザ観測 MCP"]
    FIGMA[("Figma REST API")]
    APP["Next.js dev<br/>（対象アプリ）"]

    SKILL --> ING & REC & WFB & FO & PE
    ING <-->|取得| FIGMA
    WFB -->|生成| APP
    FO -->|観測| MCP
    PE -->|回帰| MCP
    MCP -->|描画/操作| APP
    FO -->|差分| VD
    ING -.->|参照PNG/text_boxes| VD
    REC -.->|decoration_boxes| VD
```

## 構成

```
tools/                      依存ゼロの Node + Python ツール（中核）
  figma-ingest.js           REST取得→model.json/ref.png/assets/index.json/text_boxes.json
                            （componentFamilies でファミリー＋バリアントも解決）
  layout-reconstruct.js     絶対ジオメトリ→候補IR + decoration_boxes.json
  lib/                      figma-url / figma-rest / normalize / geometry / fonts / env
  visual-diff/              overlay.py（構造目視）/ visual_diff.py（領域別差分・装飾除外）
  README.md
.claude/skills/             figma2web（オーケストレーション）＋ frontend-observation /
                            playwright-e2e / web-frontend-builder（観測・検証・生成。同梱・カスタマイズ済み）
.env.example                Figma トークン設定の雛形
.mcp.json.example           browser-observer MCP（localhost許可）の雛形
```

## 連携スキルと原典

観測/検証/生成は同梱スキル（`.claude/skills/` に figma2web 用カスタマイズ済み）に委譲する。実ブラウザ観測の MCP のみ別途導入する。

| スキル | 同梱 | 役割 | 原典 (upstream) |
|---|---|---|---|
| `mcp-browser-observer`（MCP） | 別途導入 | 実ブラウザ観測（DOM/console/network/スクショ） | https://github.com/MizukiMachine/mcp-browser-observer |
| `frontend-observation` | 同梱 | 描画/動作の即時検証観点 | https://github.com/MizukiMachine/codex-skill-public/tree/develop/frontend-observation |
| `playwright-e2e` | 同梱 | 恒久的な回帰テスト | https://github.com/MizukiMachine/codex-skills-public/tree/develop/playwright-e2e |
| `web-frontend-builder` | 同梱 | GENERATE の被委譲（本番品質 UI 実装） | https://github.com/MizukiMachine/codex-skills-public/tree/develop/web-frontend-builder |

MCP は `.mcp.json.example` を参考に設定し、`BROWSER_OBSERVER_BLOCK_PRIVATE_IPS=false` を必ず付ける（localhost 観測のため）。

## セットアップ

スキル（`.claude/skills/`）は同梱済み。**このリポジトリ内で作業すれば Claude Code が自動認識**するので配置作業は不要。あとは環境を一度だけ整える:

```bash
# 1) Figma トークン（scope: File content -> read）
cp .env.example .env && $EDITOR .env          # FIGMA_SECRET_KEY と FIGMA_FILE_URL を設定
#   FIGMA_FILE_URL = 対象サイト/フレームの Figma 共有URL。ツールは常にこれを既定ターゲットにする

# 2) Python 差分ツール
cd tools/visual-diff && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && cd -

# 3) browser-observer MCP（localhost観測を許可）
cp .mcp.json.example .mcp.json && $EDITOR .mcp.json   # mcp-browser-observer のパスを設定
#   Claude Code を再起動してプロジェクト MCP を承認する
```

> 自分の別アプリで使う場合のみ、`.claude/skills/` をそのアプリ直下（または `~/.claude/skills/`）にコピーする。

## 使い方

セットアップ後、Claude Code に **一文投げるだけ**:

> **「figma2web のスキルで実装して」**

これで INGEST（`figma-ingest`）→ 構造再構築（`layout-reconstruct`）→ 構造目視（`overlay`）→ 生成 → 2ゲート差分検証 → 自己修正まで、必要な node/python コマンドはスキルがエージェントとして自分で実行する。複数ページを扱うときは、同じ一文を各ページに対して投げるだけ。

<details><summary>各ツールを手動・単体で叩く場合（デバッグ/CI 用）</summary>

```bash
node tools/figma-ingest.js --list                              # フレーム一覧（.env の FIGMA_FILE_URL を参照）
node tools/figma-ingest.js --node <id>                         # 取得（同上。--node でフレーム選択）
node tools/layout-reconstruct.js --in .context/figma/<slug>    # 構造再構築
tools/visual-diff/.venv/bin/python tools/visual-diff/overlay.py --in .context/figma/<slug>  # 構造目視
```
</details>

要件: Node 20+ / Python 3.11+ / Figma PAT（File content read）/ `mcp-browser-observer`。

## ライセンス

MIT（[LICENSE](LICENSE)）。連携する外部スキルは各 upstream のライセンスに従う。
