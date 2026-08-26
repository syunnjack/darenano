// FANZA と DUGA から取ったデータで、出演者ページ・索引・サイトマップを作る。
//
// 方針:
//   - 権利者が公開している項目だけを載せる。推測や補完はしない
//   - 名前しか分からない人のページは noindex にして、サイトマップにも入れない
//     （中身の薄いページを大量に検索結果へ出さないため）
//   - すでに公開してあったURLは、薄くても消さない（404 を作らないため）
//
// 使い方: node scripts/build-site.mjs

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { merge, normaliseName, normaliseReading } from './lib/merge.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const publicDir = path.join(root, 'public')
const outDir = path.join(publicDir, 'actress')

const SITE_URL = 'https://darekore.jp'
const SITE_NAME = 'この子だれ？'
const GA_ID = 'G-5P2QCWYG8V'
const SITE_VERIFICATION = 'UkVs5hg-pf8rhHl-6SjNmf5AVU5fHm-ha3eBCk5Y5wA'
const CONTACT = 'info@darekore.jp'

// DUGA の代理店ID。リンクに現れる公開の値で、秘密のキーではない。
// （FANZA のアフィリエイトIDも、API が返す一覧URLに含まれている。）
const DUGA_AGENT_ID = process.env.DUGA_AGENT_ID || '21786'

// DUGA ウェブサービスの利用規約で表示が義務づけられているクレジット。
// 「規定のHTMLソースを利用してください。ソースや画像の改変はできません」と
// されているため、rel などを足さずそのままの形で出す。
const DUGA_CREDIT = `<a href="https://click.duga.jp/aff/api/${DUGA_AGENT_ID}-01" target="_blank">Powered by DUGAウェブサービス</a>`

// ソクミルも、指定のHTMLをそのまま出すことが義務づけられている。
const SOKMIL_CREDIT = '<a href="https://sokmil-ad.com/" target="_blank" rel="nofollow">'
  + '<img src="https://sokmil-ad.com/api/credit/135x18.gif" alt="WEB SERVICE BY SOKMIL" width="135" height="18" border="0"></a>'

// 投票と口コミの保存先。匿名キーは公開してよい値で、守りはデータベース側の RLS。
// 未設定のときは、投稿欄を出さずにページを作る。
const SUPABASE_URL = process.env.SUPABASE_URL || ''
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || ''

// 五十音の見出しと、そこに入れる読みの頭文字。濁音・半濁音は清音にまとめる。
const KANA_ROWS = [
  ['あ', [['あ', 'あ'], ['い', 'い'], ['う', 'うゔ'], ['え', 'え'], ['お', 'お']]],
  ['か', [['か', 'かが'], ['き', 'きぎ'], ['く', 'くぐ'], ['け', 'けげ'], ['こ', 'こご']]],
  ['さ', [['さ', 'さざ'], ['し', 'しじ'], ['す', 'すず'], ['せ', 'せぜ'], ['そ', 'そぞ']]],
  ['た', [['た', 'ただ'], ['ち', 'ちぢ'], ['つ', 'つづっ'], ['て', 'てで'], ['と', 'とど']]],
  ['な', [['な', 'な'], ['に', 'に'], ['ぬ', 'ぬ'], ['ね', 'ね'], ['の', 'の']]],
  ['は', [['は', 'はばぱ'], ['ひ', 'ひびぴ'], ['ふ', 'ふぶぷ'], ['へ', 'へべぺ'], ['ほ', 'ほぼぽ']]],
  ['ま', [['ま', 'ま'], ['み', 'み'], ['む', 'む'], ['め', 'め'], ['も', 'も']]],
  ['や', [['や', 'やゃ'], ['ゆ', 'ゆゅ'], ['よ', 'よょ']]],
  ['ら', [['ら', 'ら'], ['り', 'り'], ['る', 'る'], ['れ', 'れ'], ['ろ', 'ろ']]],
  ['わ', [['わ', 'わゎ'], ['を', 'を'], ['ん', 'ん']]],
]

// 頭文字 -> 見出しの対応表。
const KANA_OF = new Map(
  KANA_ROWS.flatMap(([, initials]) => initials.flatMap(([head, members]) => [...members].map((char) => [char, head])))
)

// 表示する項目と、その見出し。API が返した値をそのまま出す。
const PROFILE_FIELDS = [
  ['birthday', '生年月日'],
  ['prefectures', '出身地'],
  ['height', '身長'],
  ['blood_type', '血液型'],
  ['hobby', '趣味'],
]

function readJson(file) {
  return readFile(file, 'utf8').then(JSON.parse)
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

function slugify(name) {
  const base = String(name || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return base || 'unknown'
}

/**
 * FANZA は別名義を「本名（別名義）（別名義）」の形で 1つの値に詰めて返す。
 * 括弧の外を本名、中を別名義として分ける。URL は本名から作る。
 */
function splitAliases(raw) {
  const parts = String(raw ?? '').split(/[（(]/)
  const name = parts[0].trim()
  const aliases = parts
    .slice(1)
    .map((part) => part.replace(/[）)]\s*$/, '').trim())
    .filter(Boolean)

  return { name: name || String(raw ?? '').trim(), aliases }
}

/** 読みの頭文字から、索引の見出し（あ・い・う…）を返す。 */
function kanaHead(reading) {
  return KANA_OF.get(normaliseReading(reading).charAt(0)) ?? 'その他'
}

/** 名前以外に載せられる事実を集める。 */
function profileOf(person) {
  const source = person.fanza ?? {}
  const entries = []

  if (source.aliases?.length) entries.push(['別名義', source.aliases.join(' / ')])

  for (const [key, label] of PROFILE_FIELDS) {
    const value = source[key]
    if (value === undefined || value === null || value === '') continue
    entries.push([label, key === 'height' ? `${value}cm` : String(value)])
  }

  const size = ['bust', 'waist', 'hip'].map((key) => source[key]).filter(Boolean)
  if (size.length === 3) entries.push(['スリーサイズ', `B${size[0]} / W${size[1]} / H${size[2]}`])

  // ソクミルからしか取れない項目。FANZA に無いときは、そちらの値も使う。
  const sokmil = person.sokmil ?? {}
  if (sokmil.cup) entries.push(['カップ', `${sokmil.cup}カップ`])

  if (!entries.some(([label]) => label === 'スリーサイズ')) {
    const other = ['bust', 'waist', 'hip'].map((key) => sokmil[key]).filter(Boolean)
    if (other.length === 3) entries.push(['スリーサイズ', `B${other[0]} / W${other[1]} / H${other[2]}`])
  }
  if (!entries.some(([label]) => label === '出身地') && sokmil.prefectures) {
    entries.push(['出身地', String(sokmil.prefectures)])
  }
  if (!entries.some(([label]) => label === '血液型') && sokmil.blood_type) {
    entries.push(['血液型', String(sokmil.blood_type)])
  }

  // DUGA に収録されている作品の、公開日のいちばん古いものと新しいもの。
  // 本人の活動期間そのものではなく、あくまで収録の範囲。
  const span = duraSpan(person.duga)
  if (span) entries.push(['DUGAでの収録', span])

  // 出演の多いレーベル。露骨な名称のものは取得側で除いてある。
  if (person.duga?.labels?.length) {
    entries.push(['主なレーベル', person.duga.labels.join('、')])
  }

  // B10F。カテゴリーごとのCSVしか無いので、置いてあるCSVのぶんだけの数になる。
  // 全作品を数えたものではないため、そう分かる書き方にしてある。
  const b10fSpan = b10fSpanOf(person.b10f)
  if (b10fSpan) entries.push(['B10Fでの収録', b10fSpan])

  return entries
}

/** 「2019-03-18」を「2019年3月」にする。 */
function monthLabel(iso) {
  const [year, month] = String(iso).split('-')
  return `${Number(year)}年${Number(month)}月`
}

/** 「2019年3月 〜 2026年3月（14作品）」の形にする。 */
function duraSpan(duga) {
  if (!duga?.firstOpenedOn || !duga?.lastOpenedOn) return ''

  const first = monthLabel(duga.firstOpenedOn)
  const last = monthLabel(duga.lastOpenedOn)
  const works = `${duga.works.toLocaleString('ja-JP')}作品`

  return first === last ? `${first}（${works}）` : `${first} 〜 ${last}（${works}）`
}

/**
 * 数えたカテゴリーの書き方。数が多いときは名前を並べない。
 *
 * B10F のカテゴリーには露骨な語を含むものがある（「近親相姦」など130種）。
 * 出演者のプロフィール欄に全部を並べると、その人の作品の内容だと読めてしまう。
 * 5つを超えたら本数だけにする。
 */
function categoryLabel(categories) {
  if (!categories?.length) return '一部カテゴリーのみ'
  // 全作品CSVから取ったときは「全ての作品」だけが入る。この場合は断りが要らない。
  if (categories.length === 1 && categories[0] === '全ての作品') return ''
  if (categories.length > 5) return `${categories.length}カテゴリー分`

  return `${categories.join('・')}のみ`
}

/** B10F は取り込んだカテゴリーのぶんだけなので、それが分かる書き方にする。 */
function b10fSpanOf(b10f) {
  if (!b10f?.firstOpenedOn || !b10f?.lastOpenedOn) return ''

  const first = monthLabel(b10f.firstOpenedOn)
  const last = monthLabel(b10f.lastOpenedOn)
  const works = `${b10f.works.toLocaleString('ja-JP')}作品`
  const span = first === last ? first : `${first} 〜 ${last}`
  const categories = categoryLabel(b10f.categories)

  return categories ? `${span}（${works}／${categories}）` : `${span}（${works}）`
}

function sourcesOf(person, confirmedOn) {
  const list = []

  if (person.fanza) {
    list.push({
      label: 'FANZA ActressSearch API',
      url: 'https://affiliate.dmm.com/api/',
      note: `出演者ID ${person.fanza.dmmId}`,
    })
  }

  if (person.duga) {
    list.push({
      label: 'DUGA アフィリエイト Web サービス',
      url: 'https://affiliate.duga.jp/',
      note: `出演者ID ${person.duga.dugaId} / 収録作品 ${person.duga.works.toLocaleString('ja-JP')}件`,
    })
  }

  if (person.sokmil) {
    list.push({
      label: 'ソクミルアフィリエイト WEBサービス',
      url: 'https://sokmil-ad.com/',
      note: `出演者ID ${person.sokmil.sokmilId}`,
    })
  }

  // B10F にはウェブサービスが無く、管理画面のカテゴリー別CSVだけが出典。
  // 数えたカテゴリーを書いておかないと、全作品数だと誤解される。
  if (person.b10f) {
    const scope = categoryLabel(person.b10f.categories)
    const categories = `${scope ? `${scope} / ` : ''}収録作品 ${person.b10f.works.toLocaleString('ja-JP')}件`

    list.push({
      label: 'B10F アフィリエイト 作品データCSV',
      url: 'https://affiliate.b10f.jp/',
      note: categories,
    })
  }

  return { list, confirmedOn }
}

function renderPage(person, { profile, sources, related, indexable }) {
  const canonical = `${SITE_URL}/actress/${person.slug}/`
  const reading = person.reading ? `（${person.reading}）` : ''
  const title = `${person.name}${reading}のプロフィール｜${SITE_NAME}`

  const facts = profile.map(([label, value]) => `${label}: ${value}`).join('、')
  const description = facts
    ? `${person.name}${reading}のプロフィール。${facts}。FANZA・DUGA が公開している情報をもとにまとめています。`
    : `${person.name}${reading}の名前と読みを収録しています。FANZA・DUGA が公開している情報をもとにまとめています。`

  const personSchema = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: person.name,
    url: canonical,
  }
  const alternateNames = [...new Set([person.reading, ...(person.fanza?.aliases ?? [])].filter(Boolean))]
  if (alternateNames.length) personSchema.alternateName = alternateNames
  if (/^\d{4}-\d{2}-\d{2}$/.test(person.fanza?.birthday ?? '')) personSchema.birthDate = person.fanza.birthday
  if (person.fanza?.prefectures) personSchema.homeLocation = { '@type': 'Place', name: person.fanza.prefectures }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: `${SITE_URL}/` },
      { '@type': 'ListItem', position: 2, name: '五十音索引', item: `${SITE_URL}/actress/` },
      { '@type': 'ListItem', position: 3, name: person.name, item: canonical },
    ],
  }

  const profileHtml = profile.length
    ? `<table class="profile"><tbody>${profile
        .map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`)
        .join('')}</tbody></table>`
    : '<p class="thin">この方は、名前と読み以外の情報が出典元で公開されていません。確認できないことは書かない方針のため、掲載していません。</p>'

  // 出演作品へのリンク。FANZA は API が一覧のURLを返すのでそれを使う。
  // DUGA は返さないため、氏名での検索へアフィリエイトの転送を通して繋ぐ。
  const works = []

  if (person.fanza?.listUrl) {
    works.push(['FANZA で出演作品を見る', person.fanza.listUrl])
  }

  // DUGA には出演者ごとのページのURLが公式に無い（ウェブサービスのレスポンスにも
  // 作品データCSVにも、あるのは商品ページのURLだけ）。氏名での検索URLを組んでみたが
  // 該当なしになったため、いちばん新しい出演作品のページへ案内する。
  if (person.sokmil?.affiliateURL) {
    works.push(['ソクミル で出演作品を見る', person.sokmil.affiliateURL])
  }

  if (person.duga?.productId) {
    const opened = person.duga.productOpenedOn
      ? `（${person.duga.productOpenedOn.replace(/^(\d+)-(\d+)-(\d+)$/, (_m, y, m2, d) => `${Number(y)}年${Number(m2)}月${Number(d)}日公開`)}）`
      : ''

    works.push([
      `DUGA で最新の出演作品を見る${opened}`,
      `https://click.duga.jp/ppv/${encodeURIComponent(person.duga.productId)}/${DUGA_AGENT_ID}-01`,
    ])
  }

  // B10F も出演者ページが無いので、いちばん新しい出演作品へ案内する。
  // URLは管理画面のCSVが返した紹介IDつきのものをそのまま使う。
  if (person.b10f?.productUrl) {
    const opened = person.b10f.productOpenedOn
      ? `（${person.b10f.productOpenedOn.replace(/^(\d+)-(\d+)-(\d+)$/, (_m, y, m2, d) => `${Number(y)}年${Number(m2)}月${Number(d)}日配信`)}）`
      : ''

    works.push([`B10F で最新の出演作品を見る${opened}`, person.b10f.productUrl])
  }

  const worksHtml = works.length
    ? `<p class="works">${works
        .map(([label, url]) => `<a class="button" href="${escapeHtml(url)}" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(label)}</a>`)
        .join('')}<span class="pr">広告</span></p>`
    : ''

  // 写真は権利者（FANZA）が配信しているものをそのまま参照する。保存も加工もしない。
  // API は http:// で返してくるが、https のページから読むので付け替える。
  const photo = (person.fanza?.image || person.sokmil?.imageURL || '').replace(/^http:\/\//, 'https://')
  const photoHtml = photo
    ? `<figure class="photo"><img src="${escapeHtml(photo)}" alt="${escapeHtml(person.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="160" height="200" /><figcaption>写真: FANZA</figcaption></figure>`
    : ''

  const sourcesHtml = `<ul class="sources">${sources.list
    .map((s) => `<li><a href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.label)}</a>（${escapeHtml(s.note)}）</li>`)
    .join('')}</ul>`

  const historyHtml = person.nameHistory?.length
    ? `<section class="history"><h2>名義ごとの収録</h2>
        <table class="profile"><tbody>${person.nameHistory
          .map((h) => `<tr><th>${escapeHtml(h.name)}</th><td>${escapeHtml(monthLabel(h.first))} 〜 ${escapeHtml(monthLabel(h.last))}（${h.works.toLocaleString('ja-JP')}作品）</td></tr>`)
          .join('')}</tbody></table>
        <p class="confirmed">DUGA に残っている作品の公開日から並べたものです。改名した時期そのものではありません。</p>
      </section>`
    : ''

  const relatedHtml = related.length
    ? `<section class="related"><h2>読みが近い方</h2><div class="chips">${related
        .map((r) => `<a href="/actress/${r.slug}/">${escapeHtml(r.name)}</a>`)
        .join('')}</div></section>`
    : ''

  const robots = indexable ? '' : '<meta name="robots" content="noindex,follow" />\n    '

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    ${robots}<meta name="google-site-verification" content="${SITE_VERIFICATION}" />
    <meta name="rating" content="adult" />
    <link rel="canonical" href="${canonical}" />
    <meta property="og:type" content="profile" />
    <meta property="og:locale" content="ja_JP" />
    <meta property="og:site_name" content="${escapeHtml(SITE_NAME)}" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${canonical}" />
    <meta name="twitter:card" content="summary" />
    <script type="application/ld+json">${jsonLd(personSchema)}</script>
    <script type="application/ld+json">${jsonLd(breadcrumbSchema)}</script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>
    <link rel="stylesheet" href="/actress/page.css" />
    <script defer src="/assets/ugc.js"></script>
  </head>
  <body>
    <div class="wrap">
      <header class="site-head"><a class="site-name" href="/">${escapeHtml(SITE_NAME)}</a></header>
      <nav class="crumbs"><a href="/">${escapeHtml(SITE_NAME)}</a> ＞ <a href="/actress/">五十音索引</a></nav>
      <h1>${escapeHtml(person.name)}</h1>
      ${person.reading ? `<p class="reading">読み: ${escapeHtml(person.reading)}</p>` : ''}
      <div class="lead-block">${photoHtml}${profileHtml}</div>
      ${worksHtml}
      <section class="source-block">
        <h2>出典</h2>
        ${sourcesHtml}
        <p class="confirmed">各サービスの API が公開している情報をそのまま載せています。取得時期は<a href="/actress/">五十音索引</a>に記載しています。</p>
      </section>
      ${historyHtml}
      <section id="ugc" class="ugc"
               data-slug="${escapeHtml(person.slug)}"
               data-api="${escapeHtml(SUPABASE_URL)}"
               data-key="${escapeHtml(SUPABASE_ANON_KEY)}"></section>
      ${relatedHtml}
      <footer>
        <p class="adult">このページは18歳未満の方に向けたものではありません。</p>
        <p>掲載内容の訂正・削除のご依頼は <a href="mailto:${CONTACT}">${CONTACT}</a> へご連絡ください。確認のうえ対応します。</p>
        <nav class="site-nav">
          <a href="/">${escapeHtml(SITE_NAME)} トップ</a>
          <a href="/actress/">五十音索引</a>
          <a href="/genre/">ジャンル別</a>
          <a href="/ranking/">投票ランキング</a>
          <a href="/privacy/">プライバシーポリシー</a>
        </nav>
        <p class="credit">${DUGA_CREDIT} ${SOKMIL_CREDIT}</p>
      </footer>
    </div>
  </body>
</html>
`
}

/** 旧URLに置く転送ページ。GitHub Pages はサーバ側の転送ができないため。 */
function renderRedirect(person) {
  const target = `/actress/${person.slug}/`

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="robots" content="noindex,follow" />
    <link rel="canonical" href="${SITE_URL}${target}" />
    <meta http-equiv="refresh" content="0; url=${target}" />
    <title>${escapeHtml(person.name)}のページへ移動します</title>
  </head>
  <body>
    <p>${escapeHtml(person.name)}のページは <a href="${target}">${SITE_URL}${target}</a> に移動しました。</p>
  </body>
</html>
`
}

/** 五十音索引の入口。頭文字ごとのページへ振り分ける。 */
function renderIndexPage(groups, total, detailed, confirmedOn) {
  const counts = new Map(groups.map(([head, members]) => [head, members.length]))

  const rows = KANA_ROWS.map(([row, initials]) => {
    const links = initials
      .filter(([head]) => counts.get(head))
      .map(([head]) =>
        `<a href="/kana/${encodeURIComponent(head)}/">${escapeHtml(head)}<span>${counts.get(head).toLocaleString('ja-JP')}人</span></a>`)
      .join('')
    return links ? `<section><h2>${escapeHtml(row)}行</h2><nav class="kana-nav big">${links}</nav></section>` : ''
  }).join('')

  const others = counts.get('その他')
    ? `<section><h2>その他</h2><nav class="kana-nav big"><a href="/kana/${encodeURIComponent('その他')}/">その他<span>${counts.get('その他').toLocaleString('ja-JP')}人</span></a></nav></section>`
    : ''

  const title = `五十音索引｜${SITE_NAME}`
  const description = `FANZA・DUGA・ソクミル・B10F が公開している出演者${total.toLocaleString('ja-JP')}人を、`
    + `読みの頭文字ごとに並べています。うち${detailed.toLocaleString('ja-JP')}人は生年月日や身長などのプロフィールを確認できています。`

  return shell({
    title,
    description,
    canonical: `${SITE_URL}/actress/`,
    crumbs: '五十音索引',
    body: `
      <h1>五十音索引</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      ${rows}${others}`,
  })
}

/** 頭文字ごとの一覧ページ。 */
function renderHeadPage(head, members, confirmedOn, groups) {
  // 名前を押すと当サイトの出演者ページへ。その横に、各社の作品一覧への
  // リンクを小さく置く。URLは各社のAPIが返したものだけを使う。
  const links = members
    .map((p) => {
      const shops = [
        ['FANZA', p.fanza?.listUrl],
        ['ソクミル', p.sokmil?.affiliateURL],
        ['DUGA', p.duga?.productId
          ? `https://click.duga.jp/ppv/${encodeURIComponent(p.duga.productId)}/${DUGA_AGENT_ID}-01`
          : ''],
        ['B10F', p.b10f?.productUrl],
      ]
        .filter(([, url]) => url)
        .map(([label, url]) =>
          `<a class="shop" href="${escapeHtml(url)}" target="_blank" rel="nofollow sponsored noopener">${label}</a>`)
        .join('')

      return `<li>`
        + `<a class="who" href="/actress/${p.slug}/">${escapeHtml(p.name)}`
        + `${p.reading ? `<span class="reading-small">${escapeHtml(p.reading)}</span>` : ''}</a>`
        + (shops ? `<span class="shops">${shops}</span>` : '')
        + `</li>`
    })
    .join('')

  const nav = groups
    .map(([other]) =>
      other === head
        ? `<span class="current">${escapeHtml(other)}</span>`
        : `<a href="/kana/${encodeURIComponent(other)}/">${escapeHtml(other)}</a>`)
    .join('')

  const label = head === 'その他' ? 'その他の読み' : `${head}から始まる読み`
  const title = `${label}の出演者一覧（${members.length.toLocaleString('ja-JP')}人）｜${SITE_NAME}`
  const description = `${label}の出演者${members.length.toLocaleString('ja-JP')}人の一覧です。FANZA・DUGA が公開している情報をもとにしています。`

  return shell({
    title,
    description,
    canonical: `${SITE_URL}/kana/${encodeURIComponent(head)}/`,
    crumbs: `<a href="/actress/">五十音索引</a> ＞ ${escapeHtml(head)}`,
    body: `
      <h1>${escapeHtml(label)}の出演者</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <nav class="kana-nav">${nav}</nav>
      <ul class="name-list">${links}</ul>
      <p class="note">名前を押すと当サイトのページへ、社名を押すと各社の作品一覧へ移動します。社名のリンクは広告です。</p>`,
  })
}

/** 当サイトの投票数によるランキング。 */
function renderRankingPage() {
  const description = '当サイトで押された投票の数で並べたランキングです。'
    + '外部の人気度ではなく、このサイトの投票数です。'

  return shell({
    title: `投票ランキング｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/ranking/`,
    crumbs: '投票ランキング',
    body: `
      <h1>投票ランキング</h1>
      <p class="reading">${escapeHtml(description)}出演者のページから投票できます。</p>
      <section id="ranking"
               data-api="${escapeHtml(SUPABASE_URL)}"
               data-key="${escapeHtml(SUPABASE_ANON_KEY)}">
        <p class="note">読み込んでいます…</p>
      </section>
      <script defer src="/assets/ranking.js"></script>`,
  })
}

/** ジャンル別に、出演本数の多い順で並べたページ。 */
function renderGenrePage(genre, rows, confirmedOn) {
  const list = rows
    .map((row, index) => `
      <li>
        <span class="rank-no">${index + 1}</span>
        ${row.slug
          ? `<a href="/actress/${encodeURIComponent(row.slug)}/">${escapeHtml(row.name)}</a>`
          : escapeHtml(row.name)}
        <span class="rank-count">${row.works}本</span>
      </li>`)
    .join('')

  const bySource = genre.worksBySource ?? {}
  const sourceNames = { fanza: 'FANZA', duga: 'DUGA', sokmil: 'ソクミル', b10f: 'B10F' }
  const used = Object.keys(sourceNames).filter((k) => bySource[k])
  const breakdown = used.map((k) => `${sourceNames[k]} ${bySource[k].toLocaleString('ja-JP')}件`).join('・')

  // 世間で通っている別の言い方。集計には関係しない、探すときの手がかり。
  const aka = genre.aka ?? []
  const akaText = aka.length ? `${aka.join('・')}とも呼ばれます。` : ''

  // 各社への行き先。fetch-genres.py が **APIから受け取ったURLだけ** を持っている。
  // FANZAとDUGAはジャンル一覧のURLを返さないため、人気順1位の作品へ送る。
  // B10F はタグのページのURLがCSVに入っている。表記が違うので、向こうの名前で書く。
  const b10fTag = genre.b10fTags?.[0] ?? genre.name
  const shopLabels = {
    fanza: `FANZA で「${genre.name}」の人気1位の作品を見る`,
    duga: `DUGA で「${genre.name}」の人気1位の作品を見る`,
    sokmil: `ソクミル で「${genre.name}」の作品一覧を見る`,
    b10f: `B10F で「${b10fTag}」の作品一覧を見る`,
  }
  const shops = Object.entries(genre.links ?? {}).filter(([key, url]) => url && shopLabels[key])
  const shopsHtml = shops.length
    ? `<p class="works">${shops
        .map(([key, url]) => `<a class="button" href="${escapeHtml(url)}" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(shopLabels[key])}</a>`)
        .join('')}<span class="pr">広告</span></p>`
    : ''

  const description = `${used.map((k) => sourceNames[k]).join('・')} が「${genre.name}」に分類している`
    + `作品${genre.works.toLocaleString('ja-JP')}件から、`
    + `出演本数の多い方${rows.length.toLocaleString('ja-JP')}人を並べています。`
    + akaText

  return shell({
    title: `${genre.name}の作品に多く出ている方${rows.length.toLocaleString('ja-JP')}人｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/genre/${genre.slug}/`,
    crumbs: `<a href="/genre/">ジャンル別</a> ＞ ${escapeHtml(genre.name)}`,
    body: `
      <h1>${escapeHtml(genre.name)}の作品に多く出ている方</h1>
      ${aka.length ? `<p class="aka">${escapeHtml(aka.join('・'))}とも呼ばれます</p>` : ''}
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <p class="confirmed">
        各社が作品に付けているジャンルを、そのまま数えたものです。
        題名や紹介文からの推測は含みません。内訳は ${escapeHtml(breakdown)}。
        同じ人が複数の社に出ている場合は合算しています。
        DUGA とソクミルは人気順の上位までを数えているため、
        実際の出演本数より少なく出ることがあります。
        ${bySource.b10f && genre.b10fPerformers
          ? 'B10F は全作品から数えていますが、出演者名が入っている作品が'
            + '全体の6%ほどしかないため、こちらも少なく出ます。'
          : ''}
        ${bySource.b10f && !genre.b10fPerformers
          ? `B10F の${bySource.b10f.toLocaleString('ja-JP')}件には出演者名が入っていないため、`
            + '下の並びには反映していません。作品一覧へのリンクだけを置いています。'
          : ''}
      </p>
      ${shopsHtml}
      <ol class="rank-list">${list}</ol>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${genre.name}の作品に多く出ている方`,
        url: `${SITE_URL}/genre/${genre.slug}/`,
        description,
        inLanguage: 'ja',
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/` },
        breadcrumb: {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
            { '@type': 'ListItem', position: 2, name: 'ジャンル別', item: `${SITE_URL}/genre/` },
            { '@type': 'ListItem', position: 3, name: genre.name, item: `${SITE_URL}/genre/${genre.slug}/` },
          ],
        },
        // 上位50人だけ。全員入れるとページが重くなる。
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: rows.length,
          itemListElement: rows.slice(0, 50).map((row, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: row.name,
            ...(row.slug ? { url: `${SITE_URL}/actress/${encodeURIComponent(row.slug)}/` } : {}),
          })),
        },
      })}</script>`,
  })
}

/** ジャンル別ページの入口。どのジャンルがあるかを並べる。 */
function renderGenreIndexPage(genres, confirmedOn) {
  const list = genres
    .map((genre) => `
      <li>
        <a href="/genre/${encodeURIComponent(genre.slug)}/">${escapeHtml(genre.name)}</a>
        ${(genre.aka ?? []).length ? `<span class="aka">（${escapeHtml(genre.aka.join('・'))}）</span>` : ''}
        <span class="rank-count">作品${genre.works.toLocaleString('ja-JP')}件</span>
      </li>`)
    .join('')

  const description = `FANZA・DUGA・ソクミル・B10F が作品に付けているジャンルのうち${genres.length}件について、`
    + '出演本数の多い方を並べたページの一覧です。'

  return shell({
    title: `ジャンル別｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/genre/`,
    crumbs: 'ジャンル別',
    body: `
      <h1>ジャンル別</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <p class="confirmed">
        ジャンルの名前と分類は各社の表記をそのまま使っています。
        当サイトが独自に付け直したものはありません。
        社によって呼び方が違う場合（制服／制服女子など）は、
        実在する名前だけを突き合わせています。
      </p>
      <ul class="rank-list">${list}</ul>
      <script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `ジャンル別｜${SITE_NAME}`,
        url: `${SITE_URL}/genre/`,
        description,
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/` },
        mainEntity: {
          '@type': 'ItemList',
          numberOfItems: genres.length,
          itemListElement: genres.map((genre, index) => ({
            '@type': 'ListItem',
            position: index + 1,
            name: genre.name,
            url: `${SITE_URL}/genre/${genre.slug}/`,
          })),
        },
      })}</script>`,
  })
}

/** 索引まわりのページの、共通のひな型。 */
function shell({ title, description, canonical, crumbs, body }) {
  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <meta name="rating" content="adult" />
    <link rel="canonical" href="${canonical}" />
    <script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
    <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}');</script>
    <link rel="stylesheet" href="/actress/page.css" />
  </head>
  <body>
    <div class="wrap">
      <header class="site-head"><a class="site-name" href="/">${escapeHtml(SITE_NAME)}</a></header>
      <nav class="crumbs"><a href="/">${escapeHtml(SITE_NAME)}</a> ＞ ${crumbs}</nav>
      ${body}
      <footer>
        <p class="adult">このページは18歳未満の方に向けたものではありません。</p>
        <p>掲載内容の訂正・削除のご依頼は <a href="mailto:${CONTACT}">${CONTACT}</a> へご連絡ください。</p>
        <nav class="site-nav">
          <a href="/">${escapeHtml(SITE_NAME)} トップ</a>
          <a href="/actress/">五十音索引</a>
          <a href="/genre/">ジャンル別</a>
          <a href="/ranking/">投票ランキング</a>
          <a href="/privacy/">プライバシーポリシー</a>
        </nav>
        <p class="credit">${DUGA_CREDIT} ${SOKMIL_CREDIT}</p>
      </footer>
    </div>
  </body>
</html>
`
}

const PAGE_CSS = `:root { color-scheme: light dark; }
.aka { color: #777; font-size: .85rem; margin: -.4rem 0 .8rem; }
body { margin:0; font-family:"Hiragino Sans","Yu Gothic",system-ui,sans-serif; color:#1c1a22; background:#fbf8f6; line-height:1.7; }
/* 切れ目の無い長い語（ローマ字の別名、レーベル名の羅列）が横にはみ出さないように。 */
body, .profile td, .rank-list a, .name-list a, .chips a { overflow-wrap:anywhere; word-break:normal; }
img { max-width:100%; height:auto; }
.wrap { max-width:760px; margin:0 auto; padding:24px 20px 64px; }
.crumbs { font-size:13px; color:#7a7484; margin-bottom:18px; }
.crumbs a { color:#8b4054; text-decoration:none; }
h1 { font-size:clamp(26px,5vw,38px); margin:0 0 6px; }
h2 { font-size:18px; margin:32px 0 10px; }
.reading { color:#5a5566; font-size:14px; margin:0 0 20px; }
.profile { border-collapse:collapse; width:100%; background:#fff; border:1px solid #ecdfe2; border-radius:10px; overflow:hidden; }
.profile th, .profile td { text-align:left; padding:11px 14px; border-bottom:1px solid #f2e8ea; font-size:15px; }
.profile th { width:9em; background:#fdf6f7; color:#6b6474; font-weight:600; }
.profile tr:last-child th, .profile tr:last-child td { border-bottom:0; }
.thin { background:#fff; border:1px solid #ecdfe2; border-radius:10px; padding:14px; color:#6b6474; font-size:14px; }
.lead-block { display:flex; gap:18px; align-items:flex-start; flex-wrap:wrap; }
.lead-block .profile, .lead-block .thin { flex:1 1 300px; }
.photo { margin:0; flex:0 0 auto; }
.photo img { display:block; width:160px; height:auto; border-radius:10px; border:1px solid #ecdfe2; background:#fff; }
.photo figcaption { font-size:11px; color:#8a838f; margin-top:4px; text-align:center; }
.works { margin:22px 0; display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.works .button + .button { background:#7a4bb5; }
.button { display:inline-block; background:#e0574a; color:#fff; text-decoration:none; padding:11px 20px; border-radius:8px; font-weight:700; font-size:15px; }
.pr { font-size:11px; color:#8a838f; border:1px solid #ddd6dc; border-radius:4px; padding:1px 6px; }
.source-block { margin-top:34px; border-top:1px solid #ecdfe2; padding-top:8px; }
.sources { padding-left:1.2em; font-size:14px; color:#5a5566; margin:8px 0; }
.sources a { color:#8b4054; }
.confirmed { font-size:13px; color:#8a838f; margin:6px 0 0; }
.related, .history { margin-top:30px; border-top:1px solid #ecdfe2; padding-top:8px; }
.chips { display:flex; flex-wrap:wrap; gap:8px; }
.chips a { color:#8b4054; text-decoration:none; font-size:13px; border:1px solid #ecdfe2; border-radius:18px; padding:4px 12px; background:#fff; }
.kana-nav { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 24px; }
.kana-nav a, .kana-nav .current { color:#8b4054; text-decoration:none; font-size:14px; border:1px solid #ecdfe2; border-radius:8px; padding:6px 12px; background:#fff; }
.kana-nav .current { background:#8b4054; color:#fff; border-color:#8b4054; }
.kana-nav.big { gap:12px; }
.kana-nav.big a { display:flex; flex-direction:column; align-items:center; min-width:88px; padding:14px 12px; font-size:18px; font-weight:700; }
.kana-nav.big a span { font-size:12px; font-weight:400; color:#8a838f; margin-top:2px; }
.reading-small { display:block; font-size:11px; color:#8a838f; }
.name-list { list-style:none; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:2px 12px; }
.name-list a { display:block; padding:3px 0; color:#3b3546; text-decoration:none; font-size:14px; }
.name-list a:hover { color:#8b4054; text-decoration:underline; }
.name-list li { padding:4px 0; border-bottom:1px solid #f5eef0; }
.name-list .who { display:block; }
.shops { display:flex; gap:6px; margin-top:2px; flex-wrap:wrap; }
.shops .shop { display:inline-flex; align-items:center; min-height:26px; padding:0 8px; font-size:11px; color:#8b4054; text-decoration:none; border:1px solid #ecdfe2; border-radius:999px; background:#fff; }
.shops .shop:hover { border-color:#8b4054; background:#f3e6ea; text-decoration:none; }
footer { margin-top:44px; border-top:1px solid #ecdfe2; padding-top:16px; font-size:13px; color:#7a7484; }
footer a { color:#8b4054; }
/* 主要な行き先。指で押せる大きさ（40px以上）を確保する。 */
.site-nav { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0 12px; }
.site-nav a { display:inline-flex; align-items:center; min-height:40px; padding:0 14px; font-size:14px; font-weight:600; text-decoration:none; border:1px solid #ecdfe2; border-radius:999px; background:#fff; }
.site-nav a:hover, .site-nav a:focus-visible { border-color:#8b4054; background:#f3e6ea; }
.crumbs { font-size:14px; }
/* どのページからでもトップへ戻れるように、上に名前を出す。 */
.site-head { padding:14px 0 12px; border-bottom:1px solid #ecdfe2; margin-bottom:16px; }
.site-head .site-name { font-size:clamp(19px,4vw,24px); font-weight:800; text-decoration:none; background:linear-gradient(92deg,#8b4054,#3f5d75); -webkit-background-clip:text; background-clip:text; color:transparent; }
.credit { margin-top:10px; }
.ugc { margin-top:34px; border-top:1px solid #ecdfe2; padding-top:8px; }
.vote-box { display:flex; align-items:center; gap:12px; margin:12px 0 4px; }
.vote { background:#8b4054; color:#fff; border:0; border-radius:8px; padding:10px 20px; font-size:15px; font-weight:700; cursor:pointer; }
.vote[disabled] { background:#c9c2cf; cursor:default; }
.vote-count { font-size:15px; color:#5a5566; }
.reviews { list-style:none; padding:0; margin:10px 0; }
.reviews li { background:#fff; border:1px solid #ecdfe2; border-radius:10px; padding:12px 14px; margin-bottom:10px; }
.review-body { margin:0 0 6px; font-size:15px; white-space:pre-wrap; }
.review-meta { margin:0; font-size:12px; color:#8a838f; }
.review-form { display:flex; flex-direction:column; gap:6px; margin-top:16px; }
.review-form label { font-size:13px; color:#6b6474; }
.review-form input, .review-form textarea { font:inherit; padding:10px 12px; border:1px solid #ecdfe2; border-radius:8px; background:#fff; color:inherit; }
.review-form .button { align-self:flex-start; border:0; cursor:pointer; }
.note { font-size:13px; color:#8a838f; }
.rank-list { list-style:none; padding:0; margin:0; }
.rank-list li { display:flex; align-items:baseline; gap:10px; padding:6px 0; border-bottom:1px solid #ecdfe2; font-size:15px; }
.rank-no { min-width:2.4em; color:#8a838f; font-size:13px; }
.rank-list a { color:#8b4054; text-decoration:none; }
.rank-count { font-size:13px; color:#8a838f; margin-left:8px; }
/* 狭い画面。余白と部品を詰めて、横に溢れないようにする。 */
@media (max-width:480px) {
  .wrap { padding:16px 14px 56px; }
  .kana-nav.big a { min-width:64px; padding:10px 8px; font-size:16px; }
  .photo { width:100%; }
  .photo img { width:132px; margin:0 auto; }
  .rank-list li { flex-wrap:wrap; gap:4px 8px; }
  .rank-count { margin-left:0; }
  .site-nav { gap:6px; }
  .site-nav a { padding:0 12px; font-size:13px; }
  .vote-box { flex-wrap:wrap; }
}

@media (prefers-color-scheme: dark) {
  .reviews li, .review-form input, .review-form textarea { background:#211e28; border-color:#332d3d; }
}
.adult { font-weight:700; color:#b0453c; }
@media (prefers-color-scheme: dark) {
  body { background:#16141a; color:#ece8f0; }
  .profile, .thin, .chips a, .kana-nav a { background:#211e28; }
  .profile th { background:#272230; color:#b8b1c2; }
  .profile th, .profile td, .profile, .thin, .chips a, .kana-nav a { border-color:#332d3d; }
  .name-list a { color:#ded8e6; }
  .name-list li { border-color:#2a2532; }
  .shops .shop { border-color:#332d3d; background:#211e28; color:#f0908a; }
  .crumbs a, .sources a, .chips a, .kana-nav a, footer a, .name-list a:hover { color:#f0908a; }
  .site-head { border-color:#332d3d; }
  .site-head .site-name { background:linear-gradient(92deg,#f0908a,#8fb4d0); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .site-nav a { border-color:#332d3d; background:#211e28; color:#f0908a; }
  .site-nav a:hover, .site-nav a:focus-visible { border-color:#f0908a; background:#3a2932; }
}
`

async function main() {
  const fanzaFile = await readJson(path.join(publicDir, 'data/actresses.json'))
  const fanzaRecords = (fanzaFile.actresses ?? fanzaFile).map((record) => {
    const { name, aliases } = splitAliases(record.name)
    const reading = splitAliases(record.ruby)

    return {
      ...record,
      name,
      rawName: record.name,
      ruby: reading.name,
      aliases: [...new Set([...aliases, ...reading.aliases])],
    }
  })

  let dugaRecords = []
  let dugaConfirmed = ''
  try {
    const dugaFile = await readJson(path.join(publicDir, 'data/duga-performers.json'))
    dugaRecords = dugaFile.performers ?? []
    dugaConfirmed = dugaFile.confirmedOn ?? ''
  } catch {
    console.log('DUGA のデータが無いので、FANZA だけで作ります。')
  }

  // 作品データCSVから、作品数と代表作品を補う。氏名で突き合わせる。
  let dugaProducts = new Map()
  try {
    const file = await readJson(path.join(publicDir, 'data/duga-products.json'))
    dugaProducts = new Map((file.performers ?? []).map((p) => [normaliseName(p.name), p]))
  } catch {
    console.log('DUGA の作品データCSVが無いので、作品ページへのリンクは付けません。')
  }

  for (const record of dugaRecords) {
    const found = dugaProducts.get(normaliseName(record.name))
    if (!found) continue
    record.productId = found.productId
    record.works = found.works       // CSV のほうが収録範囲が広い
    record.firstOpenedOn = found.firstOpenedOn
    record.lastOpenedOn = found.lastOpenedOn
    record.productOpenedOn = found.productOpenedOn
    record.labels = found.labels
  }

  // ソクミル。3社目の出典。カップ数は FANZA にも DUGA にも無い項目。
  let sokmilRecords = []
  try {
    const file = await readJson(path.join(publicDir, 'data/sokmil.json'))
    sokmilRecords = file.performers ?? []
  } catch {
    console.log('ソクミルのデータが無いので、そのぶんは載せません。')
  }

  const { people, matched, added } = merge(fanzaRecords, dugaRecords)

  // 氏名で突き合わせ、無ければ新しい人として足す。
  const byName = new Map(people.map((p) => [normaliseName(p.name), p]))
  let sokmilMatched = 0
  let sokmilAdded = 0

  for (const record of sokmilRecords) {
    const key = normaliseName(record.name)
    const found = byName.get(key)

    if (found) {
      if (!found.sokmil) {
        found.sokmil = record
        sokmilMatched += 1
      }
      continue
    }

    const person = {
      name: record.name,
      reading: record.reading || '',
      fanza: null,
      duga: null,
      sokmil: record,
    }
    people.push(person)
    byName.set(key, person)
    sokmilAdded += 1
  }

  // B10F。4社目の出典。ウェブサービスが無く、管理画面のカテゴリー別CSVだけ。
  // 出演者名が入っている作品が2割ほどしかないので、新しい人は足さず、
  // すでに他社で名前が分かっている人にだけ結び付ける。
  try {
    const file = await readJson(path.join(publicDir, 'data/b10f-products.json'))
    const categories = file.categories ?? []
    let b10fMatched = 0

    for (const record of file.performers ?? []) {
      const found = byName.get(normaliseName(record.name))
      if (!found || found.b10f) continue
      found.b10f = { ...record, categories }
      b10fMatched += 1
    }

    console.log(`B10F: ${(file.performers ?? []).length}人のうち ${b10fMatched}人が他社の名前と一致しました。`)
  } catch {
    console.log('B10F のデータが無いので、そのぶんは載せません。')
  }

  // 名義ごとの収録期間。改名して名前が変わっている人は、
  // それぞれの名前で作品が残っているので、いつ頃どの名前だったかが分かる。
  for (const person of people) {
    const names = [person.name, ...(person.fanza?.aliases ?? [])]
    const history = []

    for (const name of names) {
      const found = dugaProducts.get(normaliseName(name))
      if (!found?.firstOpenedOn) continue
      history.push({
        name,
        works: found.works,
        first: found.firstOpenedOn,
        last: found.lastOpenedOn,
      })
    }

    // 2つ以上の名義で作品が残っているときだけ、改名歴として意味がある。
    if (history.length > 1) {
      history.sort((a, b) => a.first.localeCompare(b.first))
      person.nameHistory = history
    }
  }

  // すでに公開してあったURLは、内容が薄くても残す（404 を作らないため）。
  let published = new Set()
  try {
    const text = await readFile(path.join(publicDir, 'data/published-slugs.txt'), 'utf8')
    published = new Set(text.split('\n').map((line) => line.trim()).filter(Boolean))
  } catch {
    // 初回は無くてよい。
  }

  const usedSlugs = new Set()
  for (const person of people) {
    let slug = slugify(person.name)
    let suffix = 2
    while (usedSlugs.has(slug)) {
      slug = `${slugify(person.name)}-${suffix}`
      suffix += 1
    }
    usedSlugs.add(slug)
    person.slug = slug
    person.profile = profileOf(person)
    person.indexable = person.profile.length > 0 || (person.duga?.works ?? 0) > 0 || (person.b10f?.works ?? 0) > 0 || Boolean(person.fanza?.image) || Boolean(person.sokmil?.imageURL)
  }

  const confirmedOn = fanzaFile.confirmedOn || dugaConfirmed || new Date().toISOString().slice(0, 10)
  const targets = people.filter((p) => p.indexable || published.has(p.slug))

  // 読みの行ごとにまとめる（関連リンクと索引ページに使う）。
  const rows = new Map()
  for (const person of targets) {
    const row = kanaHead(person.reading)
    if (!rows.has(row)) rows.set(row, [])
    rows.get(row).push(person)
  }
  for (const members of rows.values()) {
    members.sort((a, b) => (a.reading || a.name).localeCompare(b.reading || b.name, 'ja'))
  }

  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })
  await writeFile(path.join(outDir, 'page.css'), PAGE_CSS, 'utf8')

  for (const person of targets) {
    const siblings = rows.get(kanaHead(person.reading)) ?? []
    const at = siblings.indexOf(person)
    const related = siblings
      .slice(Math.max(0, at - 4), at + 5)
      .filter((p) => p !== person && p.indexable)
      .slice(0, 8)
      .map((p) => ({ name: p.name, slug: p.slug }))

    const html = renderPage(person, {
      profile: person.profile,
      sources: sourcesOf(person, confirmedOn),
      related,
      indexable: person.indexable,
    })

    const dir = path.join(outDir, person.slug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), html, 'utf8')
  }

  // 以前は別名義を結合したままURLにしていた（例: /actress/相原れな-三浦加奈-篠原リョウ/）。
  // 検索エンジンに登録済みなので、そのURLは残して新しいURLへ転送する。
  const redirectSlugs = []
  const written = new Set(targets.map((p) => p.slug))

  const addRedirect = async (fromSlug, person) => {
    if (!fromSlug || written.has(fromSlug)) return
    if (!published.has(fromSlug)) return

    const dir = path.join(outDir, fromSlug)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), renderRedirect(person), 'utf8')
    written.add(fromSlug)
    redirectSlugs.push(fromSlug)
  }

  for (const person of targets) {
    await addRedirect(slugify(person.fanza?.rawName ?? ''), person)
  }

  // 改名して、以前の名前が別名義として残っている場合も、旧URLから転送する。
  for (const person of targets) {
    for (const alias of person.fanza?.aliases ?? []) {
      await addRedirect(slugify(alias), person)
    }
  }
  console.log(`旧URLからの転送ページ: ${redirectSlugs.length.toLocaleString('ja-JP')}件`)

  // 索引ページには、中身のあるページだけを載せる。
  const indexable = targets.filter((p) => p.indexable)

  // indexable は「ページを作る価値がある人」で、画像しか無い人も含む。
  // 「プロフィールを確認できた人」として数えてよいのは、項目が1つ以上ある人だけ。
  const withProfile = indexable.filter((p) => p.profile.length > 0)
  const indexGroups = [...KANA_ROWS.flatMap(([, initials]) => initials.map(([head]) => head)), 'その他']
    .map((head) => [head, (rows.get(head) ?? []).filter((p) => p.indexable)])
    .filter(([, members]) => members.length > 0)

  await writeFile(
    path.join(outDir, 'index.html'),
    renderIndexPage(indexGroups, indexable.length, withProfile.length, confirmedOn),
    'utf8'
  )

  // 行ごとの一覧。1ページに 18,000人を並べると重すぎるので分ける。
  const kanaDir = path.join(publicDir, 'kana')
  await rm(kanaDir, { recursive: true, force: true })

  for (const [head, members] of indexGroups) {
    const dir = path.join(kanaDir, head)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'index.html'), renderHeadPage(head, members, confirmedOn, indexGroups), 'utf8')
  }

  // 当サイトの投票数によるランキング。中身は表示時に Supabase から読む。
  const rankingDir = path.join(publicDir, 'ranking')
  await mkdir(rankingDir, { recursive: true })
  await writeFile(path.join(rankingDir, 'index.html'), renderRankingPage(), 'utf8')

  // ジャンル別ページ。FANZA動画のジャンルで、出演本数を数えたもの。
  let genreList = []
  try {
    const file = await readJson(path.join(publicDir, 'data/genres.json'))
    genreList = file.genres ?? []
  } catch {
    console.log('ジャンルのデータが無いので、ジャンル別ページは作りません。')
  }

  // B10F のタグ別集計を足す。名前が重なるジャンルだけ（fetch-b10f-csv.py の GENRE_TAGS）。
  if (genreList.length) {
    try {
      const file = await readJson(path.join(publicDir, 'data/b10f-genres.json'))
      const bySlug = new Map((file.genres ?? []).map((g) => [g.slug, g]))
      let merged = 0

      for (const genre of genreList) {
        const found = bySlug.get(genre.slug)
        if (!found) continue

        genre.worksBySource = { ...(genre.worksBySource ?? {}), b10f: found.works }
        genre.works = (genre.works ?? 0) + found.works
        genre.links = { ...(genre.links ?? {}), b10f: found.link }
        genre.b10fTags = found.b10fTags
        // 名前が入った作品が無いジャンルもある。件数とリンクは出すが、並びには入らない。
        genre.b10fPerformers = found.performers.length

        const byName = new Map(genre.performers.map((row) => [normaliseName(row.name), row]))

        for (const row of found.performers) {
          const key = normaliseName(row.name)
          const exist = byName.get(key)

          if (exist) {
            exist.works += row.works
            exist.b10f = row.works
            continue
          }

          const record = { name: row.name, works: row.works, b10f: row.works }
          genre.performers.push(record)
          byName.set(key, record)
        }

        genre.performers.sort((a, b) => b.works - a.works || a.name.localeCompare(b.name, 'ja'))
        merged += 1
      }

      console.log(`B10F: ${merged}ジャンルに足しました。`)
    } catch {
      console.log('B10F のジャンル別データが無いので、そのぶんは足しません。')
    }

    const slugOf = new Map(targets.map((p) => [normaliseName(p.name), p.slug]))
    await rm(path.join(publicDir, 'genre'), { recursive: true, force: true })

    for (const genre of genreList) {
      const rows = genre.performers
        .filter((row) => row.works >= 2)     // 1本だけの人は並べても意味が薄い
        .map((row) => ({ ...row, slug: slugOf.get(normaliseName(row.name)) || '' }))

      const dir = path.join(publicDir, 'genre', genre.slug)
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'index.html'), renderGenrePage(genre, rows, confirmedOn), 'utf8')
      console.log(`ジャンル「${genre.name}」: ${rows.length.toLocaleString('ja-JP')}人`)
    }

    await writeFile(
      path.join(publicDir, 'genre', 'index.html'),
      renderGenreIndexPage(genreList, confirmedOn),
      'utf8'
    )

    // トップページの見出しに並べるための、軽い一覧。
    // 出演者は入れない（数百KBになるため）。
    await writeFile(
      path.join(publicDir, 'data/genre-index.json'),
      JSON.stringify({
        confirmedOn,
        genres: genreList.map((g) => ({
          name: g.name,
          slug: g.slug,
          aka: g.aka ?? [],
          works: g.works,
          people: g.performers.filter((row) => row.works >= 2).length,
        })),
      }),
      'utf8'
    )
  }

  // 検索用の索引。JSON より軽いので TSV にする。
  // スラッグは名前から作れる（ブラウザ側でも同じ処理をする）。
  // 名前どおりにならなかったときだけ3列目に書く。3MB → 1.9MB になる。
  const tsv = people
    .map((p) => {
      const slug = slugify(p.name) === p.slug ? '' : p.slug
      const aliases = (p.fanza?.aliases ?? []).join(' ')
      return `${p.name}\t${p.reading}\t${slug}\t${aliases}`.replace(/\t+$/, '')
    })
    .join('\n')
  await writeFile(path.join(publicDir, 'data/search-index.tsv'), `${tsv}\n`, 'utf8')

  // 投票の読み先。トップページ（React）からも読めるように書き出す。
  // 匿名キーは公開してよい値で、守りはデータベース側の RLS。
  await writeFile(
    path.join(publicDir, 'data/ugc-config.json'),
    JSON.stringify(SUPABASE_URL && SUPABASE_ANON_KEY
      ? { api: SUPABASE_URL, key: SUPABASE_ANON_KEY }
      : {}),
    'utf8'
  )

  // トップページの初期表示。**プロフィールが実際にある人だけ**を並べる。
  // 以前は indexable（画像しか無い人を含む）を使っていたため、
  // 「プロフィールを確認できている」と書きながら名前だけの人が混ざっていた。
  await writeFile(
    path.join(publicDir, 'data/featured.json'),
    JSON.stringify({
      confirmedOn,
      total: people.length,
      indexed: indexable.length,
      detailed: withProfile.length,
      // 出演作品数の多い方。DUGA の作品データCSVに記録された収録数で並べる。
      // 「人気」の順位は各社のAPIに無いので作らない。数えたのは DUGA のぶんだけ。
      mostWorks: targets
        .filter((p) => (p.duga?.works ?? 0) > 0)
        .sort((a, b) => (b.duga.works - a.duga.works) || a.name.localeCompare(b.name, 'ja'))
        // 右のジャンル一覧（34件）と縦の長さが釣り合うくらいに出す。
        .slice(0, 50)
        .map((p) => ({
          name: p.name,
          reading: p.reading,
          slug: p.slug,
          works: p.duga.works,
        })),
    }),
    'utf8'
  )

  // サイトマップには、中身のあるページだけを入れる。
  const today = new Date().toISOString().slice(0, 10)
  // changefreq と priority は Google が見ていないので入れない（3.3MB → 1.2MB になる）。
  const entries = [
    `${SITE_URL}/`,
    `${SITE_URL}/actress/`,
    `${SITE_URL}/ranking/`,
    ...(genreList.length ? [`${SITE_URL}/genre/`] : []),
    ...genreList.map((g) => `${SITE_URL}/genre/${g.slug}/`),
    `${SITE_URL}/privacy/`,
    ...indexGroups.map(([head]) => `${SITE_URL}/kana/${encodeURIComponent(head)}/`),
    ...indexable.map((p) => `${SITE_URL}/actress/${encodeURI(p.slug)}/`),
  ]
  const urls = entries
    .map((loc) => `  <url><loc>${loc}</loc><lastmod>${today}</lastmod></url>`)
    .join('\n')

  await writeFile(
    path.join(publicDir, 'sitemap.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
    'utf8'
  )

  // 次回のために、公開したURLを記録する。
  await writeFile(
    path.join(publicDir, 'data/published-slugs.txt'),
    `${[...new Set([...published, ...targets.map((p) => p.slug), ...redirectSlugs])].sort().join('\n')}\n`,
    'utf8'
  )

  console.log(`FANZA ${fanzaRecords.length.toLocaleString('ja-JP')}人 / DUGA ${dugaRecords.length.toLocaleString('ja-JP')}人 / ソクミル ${sokmilRecords.length.toLocaleString('ja-JP')}人`)
  console.log(`  ソクミル: 同一人物 ${sokmilMatched.toLocaleString('ja-JP')}人 / ソクミルだけの人 ${sokmilAdded.toLocaleString('ja-JP')}人`)
  console.log(`  突き合わせ: 同一人物 ${matched.toLocaleString('ja-JP')}人 / DUGA だけの人 ${added.toLocaleString('ja-JP')}人`)
  console.log(`  のべ ${people.length.toLocaleString('ja-JP')}人`)
  console.log(`ページ: ${targets.length.toLocaleString('ja-JP')}件（うち索引に載せる ${indexable.length.toLocaleString('ja-JP')}件）`)
  console.log(`サイトマップ: ${entries.length.toLocaleString('ja-JP')}URL`)
}

main()
