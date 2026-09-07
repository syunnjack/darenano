// 愛知の実店舗ページを作る。
//
// 作り方の方針:
//   - **1店1ページにしない。** 名前と住所しか違わないページが21枚できると、
//     名前だけのページと同じで重複と判定される。チェーン単位にまとめる
//   - **出典は店ごとに出す。** どのページから取ったかを1対1で示せるようにする。
//     まとめサイトの掲載データは使っていないことも明記する
//   - 営業時間と住所は変わる。**確認日を必ず出す**
//   - 導線は既存の内部ページへ。**新しいアフィリエイトURLは足さない**
//     （DMMのサイト申請が承認待ちのため）
//
// 使い方: node scripts/build-shops.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const publicDir = path.join(root, 'public')
const outDir = path.join(publicDir, 'shop')

const SITE_NAME = 'この子だれ？'
const GA_ID = 'G-5P2QCWYG8V'
const SITE_VERIFICATION = 'UkVs5hg-pf8rhHl-6SjNmf5AVU5fHm-ha3eBCk5Y5wA'
const CONTACT = 'info@darekore.jp'
const ORIGIN = 'https://darekore.jp'

// 運営会社でまとめる。**MAX書店とDVDマックスは同じマックスグループ**なので1枚にする。
const GROUPS = [
  {
    slug: 'zeroshiki',
    name: '零式書店・王の洞窟',
    chains: ['零式書店'],
    site: 'https://ounodoukutsu.jp/zeroshiki/',
    note: '中古の本・ゲーム・トレーディングカードを扱う。愛知・岐阜・三重に展開。'
      + '曜日ごとに閉店時間が違う店が多い。',
  },
  {
    slug: 'maxgroup',
    name: 'マックスグループ',
    chains: ['DVDマックス', 'MAX書店'],
    site: 'https://videomax-group.com/',
    note: '個室でDVDを見る「DVDマックス」と、販売の「MAX書店」を運営。'
      + '個室のほうは24時間営業で、駐車場が広い。',
  },
  {
    slug: 'takumi',
    name: '匠書店グループ',
    chains: ['匠書店'],
    site: 'https://takumi-dvd.shop/',
    note: '愛知に21店。屋号が「DVD匠書店」「綾波書店」「あきば書店」'
      + '「匠書店壱見屋」と分かれているが、同じ会社が運営している。'
      + '**店頭買取と宅配買取の両方をやっている。**'
      + '深夜26時まで開けている店が多い。',
  },
  {
    slug: 'mikuni',
    name: '三國書店',
    chains: ['三國書店'],
    site: 'http://mikunisyoten.com/',
    note: '名古屋市と清須市の3店。**買取をやっている数少ない実店舗**で、'
      + '店頭持ち込み・宅配買取・処分の3通りを公式に案内している。',
  },
]

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** 市区町村までを取り出す。一覧で「どのあたりか」を出すため。 */
function areaOf(address) {
  const match = String(address ?? '').match(/^(愛知県|岐阜県|三重県)([^0-9０-９]{2,8}?[市郡区])/)
  return match ? match[2] : ''
}

function shopRow(shop) {
  const items = [
    ['住所', [shop.zip ? `〒${shop.zip}` : '', shop.address].filter(Boolean).join(' ')],
    ['アクセス', shop.access],
    ['営業時間', shop.hours],
    ['定休日', shop.closed],
    ['電話番号', shop.tel],
    ['駐車場', shop.parking],
    ['取扱い', shop.items],
    ['買取', shop.buys],
  ].filter(([, value]) => value)

  return `<section class="shop">
        <h3>${escapeHtml(shop.name)}</h3>
        <dl>${items.map(([label, value]) =>
    `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl>
        <p class="src">出典: <a href="${escapeHtml(shop.source)}" target="_blank"
           rel="noopener nofollow">${escapeHtml(shop.source)}</a></p>
      </section>`
}

function page({ title, description, canonical, crumbs, body, schema }) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="google-site-verification" content="${SITE_VERIFICATION}" />
    <meta name="rating" content="adult" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="ja_JP" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta name="twitter:card" content="summary" />
${schema.map((s) => `    <script type="application/ld+json">${jsonLd(s)}</script>`).join('\n')}
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>
    <link rel="stylesheet" href="/actress/page.css" />
  </head>
  <body>
    <div class="wrap">
      <header class="site-head"><a class="site-name" href="/">${escapeHtml(SITE_NAME)}</a></header>
      <nav class="crumbs">${crumbs}</nav>
      ${body}
      <footer>
        <p class="adult">このページは18歳未満の方に向けたものではありません。</p>
        <p>掲載内容の訂正・削除のご依頼は <a href="mailto:${CONTACT}">${CONTACT}</a> へご連絡ください。確認のうえ対応します。</p>
        <nav class="site-nav">
          <a href="/">${escapeHtml(SITE_NAME)} トップ</a>
          <a href="/shop/">実店舗</a>
          <a href="/actress/">五十音索引</a>
          <a href="/genre/">ジャンル別</a>
          <a href="/goods/">大人のおもちゃ</a>
          <a href="/fanza/">FANZAのサービス</a>
          <a href="/privacy/">プライバシーポリシー</a>
        </nav>
      </footer>
    </div>
  </body>
</html>
`
}

function renderGroupPage(group, shops, confirmedOn) {
  const rows = shops.map(shopRow).join('')
  const areas = [...new Set(shops.map((s) => areaOf(s.address)).filter(Boolean))]
  // **都道府県は実データから出す。** 3県と決め打ちすると、愛知だけの
  // チェーンのタイトルに岐阜と三重が出てしまう。
  const ORDER = ['愛知県', '岐阜県', '三重県']
  const prefs = ORDER
    .filter((pref) => shops.some((s) => String(s.address ?? '').startsWith(pref)))
    .map((x) => x.replace('県', ''))

  const body = `<h1>${escapeHtml(group.name)}の店舗一覧</h1>
      <p class="lead">${group.note.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>
      <p class="confirmed">${escapeHtml(confirmedOn)} 時点で、公式サイトに書かれていた内容です。
        ${shops.length}店。${areas.length ? `${escapeHtml(areas.join('・'))}にあります。` : ''}</p>
      ${rows}
      <section class="source-block">
        <h2>この一覧について</h2>
        <p><strong>各店の公式サイトから取っています。</strong>まとめサイトに載っている
          店舗データは使っていません。住所・電話番号・営業時間は、店が自分で公開している
          ものだけを載せています。</p>
        <p><strong>営業時間と定休日は変わります。</strong>行く前に
          <a href="${escapeHtml(group.site)}" target="_blank" rel="noopener nofollow">公式サイト</a>で
          確かめてください。</p>
        <p class="confirmed">確認日: ${escapeHtml(confirmedOn)}</p>
      </section>
      <section class="related">
        <h2>店に行かずに探す</h2>
        <p>出演者の名前から作品を探すなら<a href="/actress/">五十音索引</a>、
          ジャンルから見るなら<a href="/genre/">ジャンル別</a>があります。
          配信や通販は<a href="/fanza/">FANZAのサービス</a>にまとめています。</p>
      </section>`

  return page({
    title: `${group.name}の店舗一覧（${prefs.join('・')}）｜${SITE_NAME}`,
    description: `${group.name}の店舗${shops.length}件。住所・営業時間・電話番号を`
      + `公式サイトから確認して掲載しています（${confirmedOn}時点）。`,
    canonical: `${ORIGIN}/shop/${group.slug}/`,
    crumbs: `<a href="/">${escapeHtml(SITE_NAME)}</a> ＞ <a href="/shop/">実店舗</a> ＞ ${escapeHtml(group.name)}`,
    body,
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: ORIGIN },
        { '@type': 'ListItem', position: 2, name: '実店舗', item: `${ORIGIN}/shop/` },
        { '@type': 'ListItem', position: 3, name: group.name, item: `${ORIGIN}/shop/${group.slug}/` },
      ],
    }],
  })
}

function renderIndexPage(groups, total, confirmedOn) {
  // **「愛知の」と決め打ちしない。** 零式書店は岐阜と三重にもある。
  const all = groups.flatMap(({ shops }) => shops)
  const where = ['愛知県', '岐阜県', '三重県']
    .filter((pref) => all.some((s) => String(s.address ?? '').startsWith(pref)))
    .map((x) => x.replace('県', ''))
    .join('・')
  const cards = groups.map(({ group, shops }) => `<section class="shop">
        <h3><a href="/shop/${group.slug}/">${escapeHtml(group.name)}</a></h3>
        <p>${group.note.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</p>
        <p class="confirmed">${shops.length}店 —
          ${escapeHtml([...new Set(shops.map((s) => areaOf(s.address)).filter(Boolean))].join('・'))}</p>
      </section>`).join('')

  const body = `<h1>${escapeHtml(where)}の実店舗</h1>
      <p class="lead">${escapeHtml(where)}にある店を、<strong>各社の公式サイトから確認して</strong>
        まとめています。${total}店。</p>
      ${cards}
      <section class="source-block">
        <h2>載せていない店があります</h2>
        <p><strong>公式サイトで住所を確認できなかった店は載せていません。</strong>
          まとめサイトには載っていますが、そちらの利用規約で複製が禁止されているためです。
          名前だけのページは作らない方針です。</p>
        <p class="confirmed">確認日: ${escapeHtml(confirmedOn)}</p>
      </section>`

  return page({
    title: `${where}の実店舗一覧｜${SITE_NAME}`,
    description: `${where}の店舗${total}件。住所・営業時間・電話番号を各社の`
      + `公式サイトから確認して掲載しています（${confirmedOn}時点）。`,
    canonical: `${ORIGIN}/shop/`,
    crumbs: `<a href="/">${escapeHtml(SITE_NAME)}</a> ＞ 実店舗`,
    body,
    schema: [{
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: SITE_NAME, item: ORIGIN },
        { '@type': 'ListItem', position: 2, name: '実店舗', item: `${ORIGIN}/shop/` },
      ],
    }],
  })
}

async function main() {
  let data
  try {
    data = JSON.parse(await readFile(path.join(root, 'data', 'shops.json'), 'utf8'))
  } catch {
    console.log('data/shops.json がありません。先に fetch-shops.py を走らせてください。')
    return
  }

  const shops = data.shops ?? []
  if (!shops.length) {
    console.log('店舗の記録がありません。')
    return
  }

  const filled = []
  for (const group of GROUPS) {
    const rows = shops.filter((s) => group.chains.includes(s.chain))
    if (!rows.length) continue
    const dir = path.join(outDir, group.slug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'),
      renderGroupPage(group, rows, data.confirmedOn), 'utf8')
    filled.push({ group, shops: rows })
    console.log(`  /shop/${group.slug}/  ${rows.length}店`)
  }

  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'index.html'),
    renderIndexPage(filled, shops.length, data.confirmedOn), 'utf8')

  console.log(`/shop/ と ${filled.length}枚のチェーンページを書き出しました（${shops.length}店）。`)
}

main()
