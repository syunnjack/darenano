# darenano（darekore.jp）

**このリポジトリが `darekore.jp` の配信元です。**

出演者の名前と読みから、プロフィールを引くための名鑑。

- 本番URL: https://darekore.jp
- 配信: GitHub Pages（`public/CNAME` に `darekore.jp`）
- **GitHub の Settings → Pages でも Custom domain の設定が要る。**
  CNAME ファイルだけでは足りない
- 同じドメインを別リポジトリに設定すると、こちらの紐付けが外れてサイトが消える

以前は中身が `task-dashboard` にあったが、あちらは private で
GitHub Pages を使えないため、2026-08-21 にこちらへ移した。

## 掲載しているデータ

権利者が API で公開している項目だけを持つ。推測・補完・独自の評価は載せない。

| 出典 | 取得スクリプト | 中身 |
|---|---|---|
| FANZA ActressSearch API | `scripts/fetch-actresses.py` | 氏名・読み・別名義・生年月日・出身地・身長・血液型・趣味・写真 |
| DUGA アフィリエイト Web サービス | `scripts/fetch-duga-performers.py` | 氏名・カナ・出演者ID |
| DUGA 作品データCSV | `scripts/fetch-duga-csv.py` | 作品数・代表作品（リンク先）・収録期間・主なレーベル |

出力先は `public/data/`。ページの生成は `scripts/build-site.mjs`。

以前は出典の記録が無いまま身体的特徴を載せていた。確認できないものは載せない
方針に変えて、すべて API 由来のデータに置き換えてある。

### 認証情報

**リポジトリには置かない。** GitHub Secrets と環境変数で渡す。

| 環境変数 | 用途 |
|---|---|
| `FANZA_API_ID` | FANZA API ID |
| `FANZA_AFFILIATE_ID` | FANZA アフィリエイトID（`xxxx-99x` 形式） |
| `DUGA_APP_ID` | DUGA の appid |
| `DUGA_AGENT_ID` | DUGA の代理店ID |

DUGA の API 制限は 60秒あたり60リクエスト。全商品を見るのに約90分かかるので、
1,000件ごとに書き出して、途中で止まっても続きから再開できるようにしてある。

**DUGA には出演者ごとのページのURLが公式に無い。** ウェブサービスのレスポンスにも
作品データCSVにも、あるのは商品ページのURLだけ。氏名での検索URL
（`/search/=/q=氏名/`）を試したが「条件に一致する作品は見つかりません」になったため、
いちばん新しい出演作品のページへ案内している。

作品データCSV（`https://duga.jp/productcsv/`、認証不要・毎日12:30と18:30に更新）は
ウェブサービスより収録が広い（CSV 238,872作品・45,194人 / API 195,824作品・8,865人）。
作品数・リンク先・収録期間はCSVから取る。出演者IDと読み仮名はCSVに無いので、
ウェブサービス側から取る。

**レーベル名には露骨な語を含むものがある**（1,068種のうち30種ほど。「女排泄一門会」など）。
`scripts/fetch-duga-csv.py` の `EXPLICIT` で除いている。「熟女」「人妻」のような
ジャンル語は露骨な描写ではないので除いていない。除外後に表示できるレーベルがあるのは
45,194人中45,119人。

「DUGAでの収録」は、その人の作品のうち公開日がいちばん古いものと新しいものの範囲。
**本人の活動期間そのものではない**ので、そう書かないこと。DUGAに無い時期の作品や、
他社でのみ配信された作品は含まれない。

## DUGA のクレジット表示（義務）

DUGA ウェブサービスの規約で、**指定のクレジットの表示が義務**づけられている。
全ページのフッタに次を出している。

```html
<a href="https://click.duga.jp/aff/api/21786-01" target="_blank">Powered by DUGAウェブサービス</a>
```

- **ソースの改変は認められていない。** `rel` などを足さない
- 表示位置は自由だが、閲覧者に分かるように出す
- DUGA が提供しているサイトだと誤解させる表示は禁止
- **アプリケーションIDの申請内容と違うURLでの表示は認められない。**
  申請時のURLが `https://darekore.jp` になっているか、管理画面の［編集］で確認すること

規定を守らないと API の利用を止められることがある。

## 削除依頼

ご本人・関係者から掲載を希望しない旨の連絡を受けたら削除する。
窓口は `info@darekore.jp`。画面にも表示している。

## Commands

- `npm run dev`: 開発サーバー起動
- `npm run build`: 本番ビルド（`prebuild` でページを生成する）
- `npm run lint`: 静的解析
- `npm run preview`: ビルド結果のプレビュー

`main` へ push すると Actions が `dist/` を Pages へ配信する。
データの取り直しは `refresh-data.yml`（週1回）。
