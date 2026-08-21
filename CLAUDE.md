# darenano（darekore.jp）

## プロジェクト概要

出演者の名前から探せる名鑑サイト。**本番は https://darekore.jp**。

`darekore.jp` はこのリポジトリ専用。他のリポジトリ（`task-dashboard`、`rakuafi-tool`）に
割り当ててはいけない。

以前は中身が `task-dashboard` にあったが、あちらは private で GitHub Pages を
使えないため、2026-08-21 にこちらへ移した。task-dashboard の履歴には企画書や
販売用パッケージが入っているので、public にはしない。

## 掲載データの方針

- **権利者が API で公開している項目だけを載せる。** 推測・補間・独自の評価は載せない
- 実在の人物のデータなので、裏付けのない身体的特徴・所属・経歴を書かない
- ページには必ず出典（FANZA / DUGA）を明示する
- 一般の俳優と同名で取り違えの疑いがあるものは載せない
- 削除依頼の窓口 `info@darekore.jp` を画面に出しておく
- 性的に露骨な文章は書かない。18歳未満向けでない旨の表示を出す

### データ取得

| 出典 | スクリプト | 認証情報（環境変数） |
|---|---|---|
| FANZA ActressSearch API | `scripts/fetch-actresses.py` | `FANZA_API_ID` / `FANZA_AFFILIATE_ID` |
| DUGA アフィリエイト Web サービス | `scripts/fetch-duga-performers.py` | `DUGA_APP_ID` / `DUGA_AGENT_ID` |

**キーはリポジトリに書かない。** GitHub Secrets に入れ、環境変数で渡す。

## Git運用ルール

- **コードに変更を加えるたびに、必ずGitHubへプッシュすること。**
  - 変更内容が小さくても、作業が一段落したタイミングでコミット & プッシュを行う。
  - コミットメッセージは変更内容が分かるように簡潔に記載する。
  - プッシュ前に `git status` / `git diff` で変更内容を確認する。
  - force push（`git push --force`）は明示的な指示がない限り行わない。
  - `main`/`master` ブランチへの直接pushではなく、作業用ブランチを切ってPRを作成する運用を基本とする（指示があればこの限りではない）。

## デプロイ先

https://darekore.jp

GitHub Actions（`.github/workflows/deploy.yml`）により、`main` ブランチへのpush時に
自動でビルド & デプロイされる。`indexnow.yml` が、増えたURLだけを検索エンジンへ通知する。
データの取り直しは `refresh-data.yml`（週1回）。

独自ドメインは `public/CNAME` と **GitHub の Settings → Pages の両方**で設定されている
必要がある。片方だけだとサイトが「Site not found」になる。

## 技術スタック

- 言語: JavaScript (JSX) / データ取得は Python 3
- フレームワーク: React 19（トップページの検索のみ。出演者ページは静的HTML）
- ビルドツール: Vite
- Lint: oxlint
- パッケージ管理: npm
- ランタイム: Node.js v24 / npm v11

### 主なコマンド

- `npm run dev`: 開発サーバー起動
- `npm run build`: 本番ビルド（`prebuild` でデータ取得とページ生成）
- `npm run preview`: ビルド結果のプレビュー
- `npm run lint`: oxlintによる静的解析

## コンポーネントの命名規約

- コンポーネントファイルはパスカルケース + `.jsx`（例: `App.jsx`）。
- コンポーネント本体の関数名はファイル名と一致させる（例: `App.jsx` → `function App()`）。
- 対応するスタイルシートはコンポーネントと同名の `.css`（例: `App.jsx` ↔ `App.css`）とし、同一ディレクトリに配置する。
- アプリ全体のグローバルスタイル・CSS変数（テーマカラー等）は `index.css` に記載し、コンポーネント固有のスタイルは各コンポーネントの `.css` に閉じ込める。
- イベントハンドラ関数はキャメルケースの動詞始まり（例: `addTask`, `toggleTask`, `deleteTask`）。
- CSSクラス名はケバブケース（例: `task-form`, `delete-button`）。状態を表すクラスは要素の基本クラスに追加するモディファイア形式とする（例: 完了タスクは `task done`）。
