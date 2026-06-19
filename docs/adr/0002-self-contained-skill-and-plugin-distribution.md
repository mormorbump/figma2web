# ADR-0002: tools をスキルに同梱し、プラグインとして配布する

- ステータス: Accepted
- 日付: 2026-06-19
- 関連: ADR-0001（Figma トークンを argv/`.context`/`index.json`/ログに残さない方針）

## コンテキスト

figma2web は「Claude Code スキル + 中核ツール（Node/Python）」で構成される。当初の配置は:

- スキル: `.claude/skills/figma2web/`（＋連携 3 スキル）
- ツール: リポジトリルートの `tools/`

スキルは `node tools/figma-ingest.js` のように **CWD 相対**でツールを参照していた。これは
「このリポジトリを clone してその中で作業する」前提では動くが、**他アプリで使う際に
`.claude/skills/` だけをコピーするとツールが付いてこず動かない**。セットアップ手順としても
「skill をコピー」「tools は別」「Python venv」「.env」「.mcp.json」と分散していて分かりにくい。

## 決定

OSS（Claude Code）のベストプラクティスに沿って、次の 2 点を採用する。

### 1. スキルを自己完結化（tools をスキル内に同梱）

- `tools/` を `.claude/skills/figma2web/tools/` へ移動。
- スキル/連携スキルからの参照を、CWD 非依存で解決される絶対パスに統一:
  - figma2web 自身: `${CLAUDE_SKILL_DIR}/tools/...`
  - 連携スキル（別ディレクトリ）: 兄弟参照 `${CLAUDE_SKILL_DIR}/../figma2web/tools/...`
    （4 スキルは常に同じ `.claude/skills/` 配下に並ぶため、project/personal/plugin の
    どのモードでも、また連携スキルを単体起動した場合でも解決できる）。
- Python venv は**対象プロジェクトの** `.context/figma2web/.venv` に初回実行時へ自動生成する。
  スキルディレクトリ内（plugin 時は更新で消え得るキャッシュ配下）に置かない。Node 側は依存ゼロ。

`${CLAUDE_SKILL_DIR}` は SKILL.md のあるディレクトリへ CWD 非依存で解決され、
project `.claude/skills/` / personal `~/.claude/skills/` / plugin のいずれでも同一に動く
（Claude Code 公式: docs/en/skills.md）。

### 2. 自己ホスト型プラグインとして配布

- リポジトリ自身をマーケットプレイス兼プラグインソースにする
  （`.claude-plugin/marketplace.json` の plugin `source: "./"`、`plugin.json` の `skills` で
  `.claude/skills/` 配下の 4 スキルを列挙）。
- 他アプリでの導入は 2 コマンド:
  ```
  /plugin marketplace add mormorbump/figma2web
  /plugin install figma2web@figma2web
  ```
- clone してリポジトリ内で作業する従来フローも `.claude/skills/` 自動認識で維持。

## 影響

- 他アプリでの導入が「2 コマンド or ディレクトリごとコピー」に単純化。tools のコピー漏れが原理的に起きない。
- ドキュメント/コードの `tools/...` 参照を全面更新（README、SKILL.md ×4、`tools/README.md`、
  JS の `console.log("Next: ...")` ヒント、`.gitignore`、`tools/lib/env.js` のフォールバック）。
- 連携 3 スキルは upstream と同名。プラグイン同梱版が前提のため、upstream 版との二重導入は避ける旨を
  README に明記（受容したトレードオフ）。
- `.env` / `FIGMA_FILE_URL` / `.mcp.json` は user/マシン固有のためプラグインに同梱せず、対象プロジェクト側で設定。

## 検討した代替案

- **同梱のみ（プラグイン化しない）**: tools 同梱で自己完結化だけ行い、導入は「スキルフォルダをコピー」。
  実装は軽いが、導入が 1 コマンドにならず更新も手動。→ 自己完結化は土台として採用しつつ、配布はプラグインを主に。
- **連携スキルを namespace 改名して衝突回避**: 改名は cross-reference と upstream 帰属表記を壊すため不採用。
  README で「同梱版が優先・二重導入を避ける」と明記する方針にした。
- **venv をスキル内に配置**: plugin cache の更新で消える/読み取り専用の懸念があり、対象プロジェクトの
  `.context` に置く方式を採用。
