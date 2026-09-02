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
// 作品データはページに埋め込むだけで、そのまま配信する必要がない。
// public/ に置くと dist にも入って配信量が増えるので、外に置く。
const dataDir = path.join(root, 'data')

const SITE_URL = 'https://darekore.jp'
const SITE_NAME = 'この子だれ？'
const GA_ID = 'G-5P2QCWYG8V'
const SITE_VERIFICATION = 'UkVs5hg-pf8rhHl-6SjNmf5AVU5fHm-ha3eBCk5Y5wA'
const CONTACT = 'info@darekore.jp'

// DUGA の代理店ID。リンクに現れる公開の値で、秘密のキーではない。
// （FANZA のアフィリエイトIDも、API が返す一覧URLに含まれている。）
const DUGA_AGENT_ID = process.env.DUGA_AGENT_ID || '21786'

// FANZA のアフィリエイトID。API が返す一覧URLに現れる公開の値。
// これまで作品単位のリンクが1本も無く、DMM アフィリエイトの
// 「ダイレクト報酬」が構造的に発生しない状態だった。
const FANZA_AFFILIATE_ID = process.env.FANZA_AFFILIATE_ID || 'syunnda1-997'

// FANZA のバナー（ウィジェット）。ライブチャットやくじのように
// ItemList API が無いサービスは、これでしか出せない。
//
// **アフィリエイトIDが作品リンクとは別**（-011 と -997）。
// ウィジェット用に発行されたものなので、混ぜない。
//
// URL の & は &amp; と書く。素の & は実体参照として解釈されうる。
const BANNER_AFFILIATE_ID = 'syunnda1-011'
const BANNER_IDS = [
  '1169_300_250', '1277_300_250', '1301_300_250', '1481_300_250', '1490_300_250', '1503_300_250', '1829_300_250',
  '1987_300_250', '1988_300_250', '2026_300_250', '2029_300_250',
  '2053_300_250', '2054_300_250', '2059_300_250',
]

/** ページごとに1枚だけ割り当てる。
 *
 * **1ページに何枚も並べない。** 広告だらけのページは読む人にも
 * 検索エンジンにも嫌われる。ページの名前から決めるので、
 * 同じページを開き直しても同じ広告が出る（毎回変わると落ち着かない）。
 */
function bannerFor(key) {
  let hash = 0
  for (const char of String(key ?? '')) {
    hash = (hash * 31 + char.codePointAt(0)) % 100000
  }

  return BANNER_IDS[hash % BANNER_IDS.length]
}

/** バナーを、広告と分かる形で置く。 */
function renderBanner(key) {
  const bannerId = bannerFor(key)
  const src = 'https://widget-view.dmm.co.jp/js/banner_placement.js'
    + `?affiliate_id=${BANNER_AFFILIATE_ID}&amp;banner_id=${bannerId}`

  return '<aside class="banner"><span class="pr">広告</span>'
    + '<ins class="widget-banner"></ins>'
    + `<script class="widget-banner-script" src="${src}"></script>`
    + '</aside>'
}

// 作品ページ・表紙画像のURLは品番から組み立てられる。
// 実際に叩いて確かめてある（旧 detail URL は content へ301する）。
function fanzaLink(target) {
  return `https://al.fanza.co.jp/?lurl=${encodeURIComponent(target)}&af_id=${FANZA_AFFILIATE_ID}&ch=api`
}

function fanzaItemLink(cid) {
  return fanzaLink(`https://video.dmm.co.jp/av/content/?id=${cid}`)
}

function fanzaCover(cid) {
  return `https://pics.dmm.co.jp/digital/video/${cid}/${cid}ps.jpg`
}

// 動画以外のフロア。**作品URLの形がフロアごとに違う**（2026-09-02 実測）。
// 写真集だけは品番から組み立てられないので、取得時に URL を持たせてある。
const MORE_FLOORS = {
  dvd: { label: 'DVD', url: (cid) => `https://www.dmm.co.jp/mono/dvd/-/detail/=/cid=${cid}/` },
  monthly: { label: '見放題ch', url: (cid) => `https://www.dmm.co.jp/monthly/premium/-/detail/=/cid=${cid}/` },
  cinema: { label: '成人映画', url: (cid) => `https://video.dmm.co.jp/cinema/content/?id=${cid}` },
  photo: { label: '写真集', url: null },
}

// 作者が入るフロア。**URLの形がフロアごとに違う**（2026-09-02 実測）。
// コミックとノベルだけは品番から組み立てられないので、取得時にURLを持たせてある。
const AUTHOR_FLOORS = {
  comic: { label: 'コミック', url: null },
  novel: { label: '美少女ノベル', url: null },
  pcgame: { label: 'アダルトPCゲーム', url: (cid) => `https://dlsoft.dmm.co.jp/detail/${cid}/` },
  monopcgame: { label: 'PCゲーム', url: (cid) => `https://www.dmm.co.jp/mono/pcgame/-/detail/=/cid=${cid}/` },
  book: { label: 'ブック', url: (cid) => `https://www.dmm.co.jp/mono/book/-/detail/=/cid=${cid}/` },
}

/** 作者の作品を、表紙つきで並べる。 */
function renderAuthorWorks(kind, works) {
  const floor = AUTHOR_FLOORS[kind]
  if (!floor || !works?.length) return ''

  const items = works.map((work) => {
    const target = floor.url ? floor.url(work.c) : (work.u || '')
    if (!target) return ''

    const cover = work.i
      ? `<img src="${escapeHtml(work.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="145" />`
      : ''

    return `<li class="work"><a href="${escapeHtml(fanzaLink(target))}" target="_blank" rel="nofollow sponsored noopener">`
      + cover
      + `<span class="work-title">${escapeHtml(work.t)}</span>`
      + `<span class="work-meta">${escapeHtml(jpDate(work.d))}</span>`
      + '</a></li>'
  }).join('')

  return items ? `<ul class="work-list">${items}</ul>` : ''
}

/** 作者ページ。出演者ページと同じ作りで、分野ごとに作品を並べる。 */
function renderAuthorPage(author, confirmedOn) {
  const canonical = `${SITE_URL}/author/${author.id}/`
  const kinds = Object.keys(author.w ?? {}).filter((k) => AUTHOR_FLOORS[k] && author.w[k]?.length)
  const fields = kinds.map((k) => AUTHOR_FLOORS[k].label).join('・')

  const description = `${author.name}さんの作品${author.n.toLocaleString('ja-JP')}件を、`
    + `FANZA が公開しているデータからまとめています。`
    + (fields ? `分野は${fields}。` : '')

  const blocks = kinds.map((kind) => `<section class="work-block">
      <h2>${escapeHtml(AUTHOR_FLOORS[kind].label)}<span class="pr">広告</span></h2>
      ${renderAuthorWorks(kind, author.w[kind])}
    </section>`).join('')

  return shell({
    title: `${author.name}の作品｜${SITE_NAME}`,
    description,
    canonical,
    crumbs: `<a href="/author/">作者から探す</a> ＞ ${escapeHtml(author.name)}`,
    body: `
      <h1>${escapeHtml(author.name)}</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      ${blocks}
      <section class="source-block">
        <h2>出典</h2>
        <ul class="sources"><li><a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">FANZA アフィリエイト Web サービス（ItemList）</a>（作者ID ${escapeHtml(author.id)}）</li></ul>
        <p class="confirmed">FANZA が作品に付けている作者名をそのまま数えたものです。実在の方なので、確認できない経歴や評価は書いていません。</p>
      </section>
      <script type="application/ld+json">${jsonLd({
        '@context': 'https://schema.org',
        '@type': 'Person',
        name: author.name,
        url: canonical,
      })}</script>`,
  })
}

/** 作者の入口。 */
function renderAuthorIndexPage(authors, confirmedOn) {
  const description = `FANZA のコミック・ノベル・PCゲーム・ブックから、`
    + `作品の多い作者 ${authors.length.toLocaleString('ja-JP')}人を並べています。`

  return shell({
    title: `作者から探す（${authors.length.toLocaleString('ja-JP')}人）｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/author/`,
    crumbs: '作者から探す',
    body: `
      <h1>作者から探す</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <ul class="name-list">${authors
        .map((a) => `<li><a href="/author/${a.id}/">${escapeHtml(a.name)}</a><span class="rank-count">${a.n.toLocaleString('ja-JP')}作品</span></li>`)
        .join('')}</ul>`,
  })
}

/** 動画以外のフロアの作品を、表紙つきで並べる。 */
function renderMoreWorks(kind, works) {
  const floor = MORE_FLOORS[kind]
  if (!floor || !works?.length) return ''

  const items = works.map((work) => {
    const target = floor.url ? floor.url(work.c) : (work.u || '')
    if (!target) return ''

    const cover = work.i
      ? `<img src="${escapeHtml(work.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="145" />`
      : ''

    return `<li class="work"><a href="${escapeHtml(fanzaLink(target))}" target="_blank" rel="nofollow sponsored noopener">`
      + cover
      + `<span class="work-title">${escapeHtml(work.t)}</span>`
      + `<span class="work-meta">${escapeHtml(jpDate(work.d))}</span>`
      + '</a></li>'
  }).join('')

  return items ? `<ul class="work-list">${items}</ul>` : ''
}

// MGS動画の紹介コード。**空のときはリンクを出さない。**
// リポジトリには書かず、GitHub Secrets の MGS_AFFILIATE_CODE から渡す。
// MGS には作品データのAPIもCSVも無いため、作品単位のリンクは作れない。
// せめて「この方の名前で検索した結果」へ送る（総合トップや
// ジャンル検索よりは、見ている人の目当てに近い）。
const MGS_AFFILIATE_CODE = process.env.MGS_AFFILIATE_CODE || ''

function mgsSearchLink(word) {
  if (!MGS_AFFILIATE_CODE) return ''

  const code = encodeURIComponent(MGS_AFFILIATE_CODE)
  return `https://www.mgstage.com/search/cSearch.php?search_word=${encodeURIComponent(word)}`
    + `&type=top&agef=1&utm_medium=mgs_affiliate&utm_source=mgs_affiliate_linktool`
    + `&aff=${code}&utm_campaign=mgs_affiliate_linktool&utm_content=${code}`
    + `&form=mgs_asp_linktool_${code}`
}

// ソクミルの紹介ID。これもリンクに現れる公開の値。
const SOKMIL_AFFILIATE_ID = process.env.SOKMIL_AFFILIATE_ID || '25173-001'

// 作品ページのURLは category と id から組み立てられる（APIの応答で確認済み）。
function sokmilItemLink(category, id) {
  const url = `https://sokmil.com/${category}/_item/item${id}.htm`
  const affi = encodeURIComponent(SOKMIL_AFFILIATE_ID)
  return `${url}?affi=${affi}&utm_source=sokmil_ad&utm_medium=affiliate&utm_campaign=${affi}`
}

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

function jpDate(iso) {
  return /^\d{4}-\d{2}-\d{2}$/.test(iso || '')
    ? iso.replace(/^(\d+)-(\d+)-(\d+)$/, (_m, y, m, d) => `${Number(y)}年${Number(m)}月${Number(d)}日`)
    : ''
}

/** FANZA の作品を表紙つきで並べる。リンク先は作品単位のURL。
 *
 * これが無いと、買われた作品とこちらのリンクが結びつかないため
 * 「ダイレクト報酬」が発生しない。作品タイトルは権利者が API で
 * 公開している商品名をそのまま出すが、**<title>・meta・構造化データには
 * 入れない**（検索結果や SNS カードに露骨な語を出さないため）。
 */
function renderWorkList(works) {
  if (!works?.length) return ''

  const items = works
    .map((work) => `<li class="work"><a href="${escapeHtml(fanzaItemLink(work.c))}" target="_blank" rel="nofollow sponsored noopener">`
      + `<img src="${escapeHtml(fanzaCover(work.c))}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="145" />`
      + `<span class="work-title">${escapeHtml(work.t)}</span>`
      + `<span class="work-meta">${escapeHtml(jpDate(work.d))}／${escapeHtml(work.c)}</span>`
      + '</a></li>')
    .join('')

  return `<ul class="work-list">${items}</ul>`
}

/** DUGA の作品を、題名と公開日の一覧で出す。リンク先は作品単位のURL。
 *
 * DUGA は「規定のHTMLソースを利用してください。ソースや画像の改変はできません」と
 * しているため、**表紙画像は使わない**（FANZA のように自前の並びに嵌め込まない）。
 * 直したいのはリンクの単位のほうで、これまでは1ページに代表作品1本しか無かった。
 */
function renderDugaWorks(works) {
  if (!works?.length) return ''

  return `<ul class="work-lines">${works
    .map((work) => `<li><a href="https://click.duga.jp/ppv/${encodeURIComponent(work.c)}/${DUGA_AGENT_ID}-01" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(work.t)}</a><span class="work-meta">${escapeHtml(jpDate(work.d))}</span></li>`)
    .join('')}</ul>`
}

/** ソクミルの作品を、題名と配信日の一覧で出す。リンク先は作品単位のURL。 */
function renderSokmilWorks(works) {
  if (!works?.length) return ''

  return `<ul class="work-lines">${works
    .map((work) => `<li><a href="${escapeHtml(sokmilItemLink(work.g, work.c))}" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(work.t)}</a><span class="work-meta">${escapeHtml(jpDate(work.d))}</span></li>`)
    .join('')}</ul>`
}

/** DTI CASH の作品。CSVに作品単位のアフィリエイトリンクが入っているのでそれを使う。
 *
 * **中身は無修正なので、その旨を書き添える。** 出すのは、その人に実際に
 * 作品がある出演者ページだけ。サイト全体に貼るような出し方はしない。
 */
function renderDtiWorks(works) {
  if (!works?.length) return ''

  return `<ul class="work-lines">${works
    .map((work) => `<li><a href="${escapeHtml(work.u)}" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(maskExplicit(work.t))}</a><span class="work-meta">${escapeHtml(maskExplicit(work.s))}${work.d ? `／${escapeHtml(jpDate(work.d))}` : ''}</span></li>`)
    .join('')}</ul>`
}

/** B10F の作品を、題名と配信日の一覧で出す。
 *
 * URLはCSVに入っている紹介IDつきのものをそのまま使う。
 * これまでは代表作品1本しかリンクが無かった。
 */
function renderB10fWorks(works) {
  if (!works?.length) return ''

  return `<ul class="work-lines">${works
    .map((work) => `<li><a href="${escapeHtml(work.u)}" target="_blank" rel="nofollow sponsored noopener">${escapeHtml(work.t)}</a><span class="work-meta">${escapeHtml(jpDate(work.d))}</span></li>`)
    .join('')}</ul>`
}

/** 大人のおもちゃを並べる。リンクと画像はAPIが返したものをそのまま使う。
 *
 * **分類ではなく語で引いているだけ**なので、その旨をページに書く。
 * 題名にその語が入っているものだけを残してある（本文への誤爆を落とすため）。
 */
function renderGoods(items) {
  if (!items?.length) return ''

  return `<ul class="work-list">${items
    .map((item) => `<li class="work"><a href="${escapeHtml(item.u)}" target="_blank" rel="nofollow sponsored noopener">`
      + (item.i
        ? `<img src="${escapeHtml(item.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="100" />`
        : '')
      + `<span class="work-title">${escapeHtml(item.t)}</span>`
      + (item.p ? `<span class="work-meta">${escapeHtml(item.p)}</span>` : '')
      + '</a></li>')
    .join('')}</ul>`
}

function renderPage(person, { profile, sources, related, indexable, fanzaWorks, sokmilWorks, dtiWorks, moreWorks }) {
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
  const mgs = mgsSearchLink(person.name)
  if (mgs) {
    works.push([`MGS動画 で「${person.name}」の作品を探す`, mgs])
  }

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

  // FANZA の出演作品。表紙と作品単位のリンクを出す。
  const fanzaWorksHtml = fanzaWorks?.w?.length
    ? `<section class="work-block">
        <h2>FANZA での出演作品<span class="pr">広告</span></h2>
        ${renderWorkList(fanzaWorks.w)}
        <p class="confirmed">FANZA の動画（videoa）に収録されている ${fanzaWorks.n.toLocaleString('ja-JP')} 作品のうち、新しい ${fanzaWorks.w.length} 本です。${
          person.fanza?.listUrl
            ? `<a href="${escapeHtml(person.fanza.listUrl)}" target="_blank" rel="nofollow sponsored noopener">すべての出演作品を見る</a>`
            : ''
        }</p>
      </section>`
    : ''

  // 動画以外の FANZA。同じ出演者IDで引けるので、同じページに並べられる。
  const moreHtml = Object.entries(moreWorks ?? {})
    .filter(([kind, works]) => MORE_FLOORS[kind] && works?.length)
    .map(([kind, works]) => `<section class="work-block">
        <h2>FANZA ${escapeHtml(MORE_FLOORS[kind].label)}での出演作品<span class="pr">広告</span></h2>
        ${renderMoreWorks(kind, works)}
      </section>`)
    .join('')

  // DUGA の出演作品。これまでは代表作品1本へのリンクだけだった。
  const dugaWorksHtml = person.duga?.recent?.length
    ? `<section class="work-block">
        <h2>DUGA での出演作品<span class="pr">広告</span></h2>
        ${renderDugaWorks(person.duga.recent)}
        <p class="confirmed">DUGA の作品データCSVに収録されている ${(person.duga.works ?? 0).toLocaleString('ja-JP')} 作品のうち、公開の新しい ${person.duga.recent.length} 本です。</p>
      </section>`
    : ''

  // ソクミルの出演作品。これまでは出演者のページへのリンクだけだった。
  const sokmilWorksHtml = sokmilWorks?.w?.length
    ? `<section class="work-block">
        <h2>ソクミル での出演作品<span class="pr">広告</span></h2>
        ${renderSokmilWorks(sokmilWorks.w)}
        <p class="confirmed">ソクミルに収録されている ${sokmilWorks.n.toLocaleString('ja-JP')} 作品のうち、配信の新しい ${sokmilWorks.w.length} 本です。${
          person.sokmil?.affiliateURL
            ? `<a href="${escapeHtml(person.sokmil.affiliateURL)}" target="_blank" rel="nofollow sponsored noopener">すべての出演作品を見る</a>`
            : ''
        }</p>
      </section>`
    : ''

  // DTI CASH の出演作品。無修正なので、見る前に分かるように書く。
  const dtiWorksHtml = dtiWorks?.w?.length
    ? `<section class="work-block">
        <h2>無修正サイトでの出演作品<span class="pr">広告</span></h2>
        <p class="confirmed">DTI CASH が扱う配信サイトに、この方の名前で ${dtiWorks.n.toLocaleString('ja-JP')} 作品が収録されています。<strong>いずれも無修正の作品です。</strong>配信元は作品ごとに書いてあり、リンク先は各サイトの作品ページです。</p>
        ${renderDtiWorks(dtiWorks.w)}
      </section>`
    : ''

  // B10F の出演作品。これまでは代表作品1本へのリンクだけだった。
  const b10fWorksHtml = person.b10f?.recent?.length
    ? `<section class="work-block">
        <h2>B10F での出演作品<span class="pr">広告</span></h2>
        ${renderB10fWorks(person.b10f.recent)}
        <p class="confirmed">B10F の作品データCSVに収録されている ${(person.b10f.works ?? 0).toLocaleString('ja-JP')} 作品のうち、配信の新しい ${person.b10f.recent.length} 本です。</p>
      </section>`
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
      ${fanzaWorksHtml}
      ${moreHtml}
      ${dugaWorksHtml}
      ${sokmilWorksHtml}
      ${b10fWorksHtml}
      ${dtiWorksHtml}
      <section class="source-block">
        <h2>出典</h2>
        ${sourcesHtml}
        <p class="confirmed">各サービスの API が公開している情報をそのまま載せています。取得時期は<a href="/actress/">五十音索引</a>に記載しています。</p>
      </section>
      ${historyHtml}
      ${renderBanner(person.slug)}
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
          <a href="/series/">シリーズ別</a>
          <a href="/label/">レーベル別</a>
          <a href="/author/">作者から探す</a>
          <a href="/doujin/">同人</a>
          <a href="/goods/">大人のおもちゃ</a>
          <a href="/new/">新着作品</a>
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
        ${genre.b10fOnly
          ? 'この区分は B10F にしかないため、B10F の作品だけを数えています。'
          : 'DUGA とソクミルは人気順の上位までを数えているため、'
            + '実際の出演本数より少なく出ることがあります。'}
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
      ${genre.fanzaWorks?.length
        ? `<section class="work-block">
            <h2>このジャンルの作品<span class="pr">広告</span></h2>
            ${renderWorkList(genre.fanzaWorks)}
            <p class="confirmed">FANZA の人気順で上位 ${genre.fanzaWorks.length} 本です。作品名は FANZA が公開している商品名をそのまま出しています。</p>
          </section>`
        : ''}
      ${genre.goods?.w?.length
        ? `<section class="work-block">
            <h2>「${escapeHtml(genre.name)}」で見つかる大人のおもちゃ<span class="pr">広告</span></h2>
            ${renderGoods(genre.goods.w)}
            <p class="confirmed">FANZA の大人のおもちゃ 21,027件を「${escapeHtml(genre.name)}」で検索し、<strong>題名にその語が入っている商品だけ</strong>を出しています。作品のジャンル分類とは別のものです。</p>
          </section>`
        : ''}
      ${renderBanner(genre.slug)}
      <h2>出演本数の多い方</h2>
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
// 露骨な語を含む名前は、検索に載るページの題として出さない。
// DUGA のレーベル名で使っている判定と同じ考え方（fetch-duga-csv.py の EXPLICIT）。
const EXPLICIT_WORDS = [
  '排泄', '浣腸', '放尿', '小便', 'ウンコ', '糞', 'ゲロ', '嘔吐', 'スカトロ',
  'フェラ', '手コキ', '素股', 'ハメ', '中出し', 'アナル', '潮吹', '射精', '精子',
  '乱交', '輪姦', 'レイプ', '強姦', '近親', '痴漢', '露出', '奴隷', '調教',
  '無修正', 'ロリ', '児童', 'JK', '女子校', 'アヘ', 'アへ', '羞恥',
]

function displayableName(name) {
  return Boolean(name) && !EXPLICIT_WORDS.some((word) => name.includes(word))
}

// 無修正サイトの作品名にだけ出てくる語。**伏せ字にするためだけに使う。**
// EXPLICIT_WORDS のほうはページを作るかどうかの判定に使っているので、
// そちらを膨らませるとシリーズ・レーベルのページが不必要に減る。
const EXPLICIT_EXTRA = [
  'マンコ', 'まんこ', 'オマンコ', 'おまんこ', 'マン汁',
  'チンコ', 'ちんこ', 'チンポ', 'ちんぽ', 'オチンチン', 'おちんちん',
  'ペニス', '肉棒', '巨根', '極太', 'ザーメン', '精液',
  '挿入', 'パイパン', 'クンニ', 'ぶっかけ', '顔面騎乗',
  '淫乱', '淫語', '性交', 'セックス', 'SEX', '膣', '陰毛', '剛毛',
  'マンズリ', 'まんずり', 'パイズリ', '手マン', '指マン', '玉舐め', '亀頭',
  'ごっくん', 'オナニー', 'おなにー', '中出', '生ハメ', '生挿', '顔騎',
]

/** 露骨な語を同じ長さの○に置き換える。
 *
 * **無修正サイトの作品名に使う。** FANZA・DUGA・ソクミルは配信元が
 * すでに伏せ字にしているものが多いが、無修正サイトはそのままの語で出す。
 * 題名そのものは残しつつ、どの作品か分かる形にしておく。
 */
function maskExplicit(text) {
  let masked = String(text ?? '')

  // 長い語から先に置き換える（「中出し」を「中出」で崩さないため）
  const words = [...EXPLICIT_WORDS, ...EXPLICIT_EXTRA].sort((a, b) => b.length - a.length)

  for (const word of words) {
    if (!masked.includes(word)) continue
    masked = masked.split(word).join('○'.repeat(word.length))
  }

  return masked
}

const GROUP_KINDS = {
  series: { path: 'series', nav: 'シリーズ別', unit: 'シリーズ' },
  label: { path: 'label', nav: 'レーベル別', unit: 'レーベル' },
}

/** シリーズ別・レーベル別のページ。収録作品と、そこに出ている方を並べる。 */
function renderGroupPage(kind, entry, cast, confirmedOn) {
  const meta = GROUP_KINDS[kind]
  const canonical = `${SITE_URL}/${meta.path}/${entry.id}/`

  const description = `FANZA の${meta.unit}「${entry.name}」に収録されている`
    + `${entry.n.toLocaleString('ja-JP')}作品のうち、新しい${entry.w.length}本と、`
    + `出演している方${cast.length.toLocaleString('ja-JP')}人を並べています。`

  const castHtml = cast.length
    ? `<section class="related"><h2>この${meta.unit}に出ている方</h2><div class="chips">${cast
        .map((row) => `<a href="/actress/${encodeURIComponent(row.slug)}/">${escapeHtml(row.name)}<span class="rank-count">${row.works}本</span></a>`)
        .join('')}</div></section>`
    : ''

  return shell({
    title: `${entry.name}の収録作品｜${SITE_NAME}`,
    description,
    canonical,
    crumbs: `<a href="/${meta.path}/">${escapeHtml(meta.nav)}</a> ＞ ${escapeHtml(entry.name)}`,
    body: `
      <h1>${escapeHtml(entry.name)}</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <section class="work-block">
        <h2>収録作品<span class="pr">広告</span></h2>
        ${renderWorkList(entry.w)}
      </section>
      ${castHtml}
      <section class="source-block">
        <h2>出典</h2>
        <ul class="sources"><li><a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">FANZA アフィリエイト Web サービス（ItemList）</a>（${escapeHtml(meta.unit)}ID ${escapeHtml(entry.id)}）</li></ul>
        <p class="confirmed">FANZA の動画（videoa）で、この${escapeHtml(meta.unit)}に分類されている作品を数えたものです。作品名は FANZA が公開している商品名をそのまま出しています。</p>
      </section>
      <script type="application/ld+json">${jsonLd({
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: `${entry.name}の収録作品`,
        url: canonical,
        description,
        inLanguage: 'ja',
        isPartOf: { '@type': 'WebSite', name: SITE_NAME, url: `${SITE_URL}/` },
        breadcrumb: {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: SITE_NAME, item: `${SITE_URL}/` },
            { '@type': 'ListItem', position: 2, name: meta.nav, item: `${SITE_URL}/${meta.path}/` },
            { '@type': 'ListItem', position: 3, name: entry.name, item: canonical },
          ],
        },
      })}</script>`,
  })
}

/** シリーズ別・レーベル別の入口。 */
function renderGroupIndexPage(kind, entries, confirmedOn) {
  const meta = GROUP_KINDS[kind]
  const description = `FANZA の動画に付けられている${meta.unit}のうち、`
    + `収録作品の多い${entries.length.toLocaleString('ja-JP')}件を並べています。`

  const list = entries
    .map((entry) => `<li><a href="/${meta.path}/${entry.id}/">${escapeHtml(entry.name)}</a><span class="rank-count">${entry.n.toLocaleString('ja-JP')}作品</span></li>`)
    .join('')

  return shell({
    title: `${meta.nav}に見る出演作品（${entries.length.toLocaleString('ja-JP')}${meta.unit}）｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/${meta.path}/`,
    crumbs: escapeHtml(meta.nav),
    body: `
      <h1>${escapeHtml(meta.nav)}</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <p class="confirmed">FANZA が作品に付けている${escapeHtml(meta.unit)}をそのまま数えたものです。作品数の少ないものはページを作っていません。</p>
      <ul class="name-list">${list}</ul>`,
  })
}

/** 新着作品。発売日の新しい順。 */
function renderNewPage(works, confirmedOn) {
  const description = `FANZA の動画に新しく加わった${works.length}作品を、発売日の新しい順に並べています。`

  return shell({
    title: `FANZA の新着作品${works.length}本｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/new/`,
    crumbs: '新着作品',
    body: `
      <h1>FANZA の新着作品</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <section class="work-block">
        <h2>発売日の新しい順<span class="pr">広告</span></h2>
        ${renderWorkList(works)}
      </section>
      <section class="source-block">
        <h2>出典</h2>
        <ul class="sources"><li><a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">FANZA アフィリエイト Web サービス（ItemList）</a></li></ul>
        <p class="confirmed">作品名は FANZA が公開している商品名をそのまま出しています。</p>
      </section>`,
  })
}

const DOUJIN_KINDS = {
  circle: { path: 'circle', nav: 'サークル別', unit: 'サークル' },
  genre: { path: 'doujin', nav: '同人のジャンル別', unit: 'ジャンル' },
}

/** 同人の作品を表紙つきで並べる。画像もURLもAPIが返したものをそのまま使う。 */
function renderDoujinWorks(works) {
  if (!works?.length) return ''

  return `<ul class="work-list">${works
    .map((work) => `<li class="work"><a href="${escapeHtml(work.u)}" target="_blank" rel="nofollow sponsored noopener">`
      + (work.i
        ? `<img src="${escapeHtml(work.i)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" width="100" height="141" />`
        : '')
      + `<span class="work-title">${escapeHtml(work.t)}</span>`
      + `<span class="work-meta">${escapeHtml(jpDate(work.d))}</span>`
      + '</a></li>')
    .join('')}</ul>`
}

/** 同人のサークル別・ジャンル別のページ。 */
function renderDoujinPage(kind, entry, confirmedOn) {
  const meta = DOUJIN_KINDS[kind]
  const canonical = `${SITE_URL}/${meta.path}/${entry.id}/`
  const description = `FANZA同人の${meta.unit}「${entry.name}」に${entry.n.toLocaleString('ja-JP')}作品が`
    + `収録されています。新しい${entry.w.length}本を並べています。`

  return shell({
    title: `${entry.name}の同人作品｜${SITE_NAME}`,
    description,
    canonical,
    crumbs: `<a href="/${meta.path}/">${escapeHtml(meta.nav)}</a> ＞ ${escapeHtml(entry.name)}`,
    body: `
      <h1>${escapeHtml(entry.name)}</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <section class="work-block">
        <h2>収録作品<span class="pr">広告</span></h2>
        ${renderDoujinWorks(entry.w)}
      </section>
      <section class="source-block">
        <h2>出典</h2>
        <ul class="sources"><li><a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">FANZA アフィリエイト Web サービス（同人）</a></li></ul>
        <p class="confirmed">同人は作品に出演者が入らないため、${escapeHtml(meta.unit)}でまとめています。未成年を思わせるもの・同意のないもの・近親相姦・排泄を含む作品は載せていません。</p>
      </section>`,
  })
}

/** 同人の入口。 */
function renderDoujinIndex(kind, entries, confirmedOn) {
  const meta = DOUJIN_KINDS[kind]
  const description = `FANZA同人の${meta.unit}のうち、収録作品の多い${entries.length.toLocaleString('ja-JP')}件を並べています。`

  return shell({
    title: `${meta.nav}（${entries.length.toLocaleString('ja-JP')}${meta.unit}）｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/${meta.path}/`,
    crumbs: escapeHtml(meta.nav),
    body: `
      <h1>${escapeHtml(meta.nav)}</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <ul class="name-list">${entries
        .map((entry) => `<li><a href="/${meta.path}/${entry.id}/">${escapeHtml(entry.name)}</a><span class="rank-count">${entry.n.toLocaleString('ja-JP')}作品</span></li>`)
        .join('')}</ul>`,
  })
}

/** 大人のおもちゃのメーカー別ページ。 */
function renderGoodsMakerPage(maker, confirmedOn) {
  const canonical = `${SITE_URL}/goods/${maker.id}/`
  const description = `${maker.name}の大人のおもちゃ ${maker.n.toLocaleString('ja-JP')}件のうち、`
    + `新しい${maker.w.length}件を並べています。`

  return shell({
    title: `${maker.name}の大人のおもちゃ｜${SITE_NAME}`,
    description,
    canonical,
    crumbs: `<a href="/goods/">大人のおもちゃ</a> ＞ ${escapeHtml(maker.name)}`,
    body: `
      <h1>${escapeHtml(maker.name)}</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      <section class="work-block">
        <h2>取り扱い商品<span class="pr">広告</span></h2>
        ${renderGoods(maker.w)}
      </section>
      <section class="source-block">
        <h2>出典</h2>
        <ul class="sources"><li><a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">FANZA アフィリエイト Web サービス（大人のおもちゃ）</a></li></ul>
        <p class="confirmed">FANZA が公開している商品情報をそのまま出しています。価格・在庫は変わるため、最新の内容は販売ページでご確認ください。</p>
      </section>`,
  })
}

/** 大人のおもちゃの入口。ジャンルからも、メーカーからも辿れるようにする。 */
function renderGoodsIndexPage(makers, genres, newest, scanned, confirmedOn) {
  const description = `FANZA の大人のおもちゃ ${scanned.toLocaleString('ja-JP')}件から、`
    + `ジャンル ${genres.length}件・メーカー ${makers.length}社ぶんの入口を作っています。`

  return shell({
    title: `大人のおもちゃ（${scanned.toLocaleString('ja-JP')}商品）｜${SITE_NAME}`,
    description,
    canonical: `${SITE_URL}/goods/`,
    crumbs: '大人のおもちゃ',
    body: `
      <h1>大人のおもちゃ</h1>
      <p class="reading">${escapeHtml(description)}${escapeHtml(confirmedOn)} 時点のデータです。</p>
      ${newest.length
        ? `<section class="work-block">
            <h2>新しく入った商品<span class="pr">広告</span></h2>
            ${renderGoods(newest.slice(0, 12))}
          </section>`
        : ''}
      ${genres.length
        ? `<h2>ジャンルから探す</h2>
           <div class="chips">${genres
             .map((g) => `<a href="/genre/${escapeHtml(g.slug)}/">${escapeHtml(g.name)}<span class="rank-count">${g.count}</span></a>`)
             .join('')}</div>`
        : ''}
      <h2>メーカーから探す</h2>
      <ul class="name-list">${makers
        .map((m) => `<li><a href="/goods/${m.id}/">${escapeHtml(m.name)}</a><span class="rank-count">${m.n.toLocaleString('ja-JP')}商品</span></li>`)
        .join('')}</ul>`,
  })
}

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
          <a href="/series/">シリーズ別</a>
          <a href="/label/">レーベル別</a>
          <a href="/author/">作者から探す</a>
          <a href="/doujin/">同人</a>
          <a href="/goods/">大人のおもちゃ</a>
          <a href="/new/">新着作品</a>
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
/* 出演作品。表紙を並べて、1本ずつ作品ページへ送る。 */
.work-block { margin-top:34px; border-top:1px solid #ecdfe2; padding-top:8px; }
.work-block h2 { display:flex; align-items:center; gap:8px; }
.work-list { list-style:none; padding:0; margin:12px 0 8px; display:grid; grid-template-columns:repeat(auto-fill,minmax(112px,1fr)); gap:16px 12px; }
.work a { display:block; color:#3b3546; text-decoration:none; }
.work img { display:block; width:100%; height:auto; aspect-ratio:100/145; object-fit:cover; border-radius:6px; border:1px solid #ecdfe2; background:#fff; }
.work-title { display:-webkit-box; -webkit-line-clamp:3; line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; font-size:12px; line-height:1.45; margin-top:6px; }
.work-meta { display:block; font-size:11px; color:#8a838f; margin-top:3px; }
.work a:hover .work-title { color:#8b4054; text-decoration:underline; }
.work-lines { list-style:none; padding:0; margin:12px 0 8px; }
.work-lines li { padding:8px 0; border-bottom:1px solid #f2e8ea; font-size:14px; }
.work-lines a { color:#3b3546; text-decoration:none; }
.work-lines a:hover { color:#8b4054; text-decoration:underline; }
.work-lines .work-meta { display:block; }
.banner { display:flex; flex-direction:column; align-items:center; gap:6px; margin:28px 0; }
.banner .pr { align-self:flex-start; }
.banner ins { display:block; max-width:100%; }
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
  .work a { color:#ded8e6; }
  .work img { border-color:#332d3d; background:#211e28; }
  .work-block { border-color:#332d3d; }
  .work a:hover .work-title { color:#f0908a; }
  .work-lines a { color:#ded8e6; }
  .work-lines li { border-color:#2a2532; }
  .work-lines a:hover { color:#f0908a; }
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
    record.recent = found.recent ?? []
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

  // FANZA の作品データ。出演者ごとの出演作品と、シリーズ・レーベル別ページのもと。
  // まだ取っていないときは、無いまま作る（これまでどおりのページになる）。
  let fanzaWorksOf = new Map()
  try {
    const file = await readJson(path.join(dataDir, 'fanza-actress-works.json'))
    fanzaWorksOf = new Map(Object.entries(file.actresses ?? {}))
    console.log(`FANZA の作品: ${fanzaWorksOf.size.toLocaleString('ja-JP')}人ぶん（見た作品 ${(file.scanned ?? 0).toLocaleString('ja-JP')}件）`)
  } catch {
    console.log('FANZA の作品データが無いので、出演作品は並べません。')
  }

  // 動画以外のフロア（DVD・見放題ch・写真集・成人映画）。
  let moreWorksOf = new Map()
  try {
    const file = await readJson(path.join(dataDir, 'fanza-actress-more.json'))
    moreWorksOf = new Map(Object.entries(file.actresses ?? {}))
    console.log(`FANZA の動画以外: ${moreWorksOf.size.toLocaleString('ja-JP')}人ぶん（見た作品 ${(file.scanned ?? 0).toLocaleString('ja-JP')}件）`)
  } catch {
    console.log('FANZA の動画以外のデータが無いので、そのぶんは並べません。')
  }

  // ソクミルの作品データ。
  let sokmilWorksOf = new Map()
  try {
    const file = await readJson(path.join(dataDir, 'sokmil-actor-works.json'))
    sokmilWorksOf = new Map(Object.entries(file.actors ?? {}))
    console.log(`ソクミルの作品: ${sokmilWorksOf.size.toLocaleString('ja-JP')}人ぶん（見た作品 ${(file.scanned ?? 0).toLocaleString('ja-JP')}件）`)
  } catch {
    console.log('ソクミルの作品データが無いので、出演作品は並べません。')
  }

  // DTI CASH の作品データ。氏名で突き合わせる（出演者IDが無いため）。
  let dtiWorksOf = new Map()
  try {
    const file = await readJson(path.join(dataDir, 'dti-performer-works.json'))
    dtiWorksOf = new Map((file.performers ?? []).map((row) => [normaliseName(row.name), row]))
    console.log(`DTI CASH の作品: ${dtiWorksOf.size.toLocaleString('ja-JP')}人ぶん（見た作品 ${(file.scanned ?? 0).toLocaleString('ja-JP')}件）`)
  } catch {
    console.log('DTI CASH の作品データが無いので、出演作品は並べません。')
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
      fanzaWorks: person.fanza?.dmmId ? fanzaWorksOf.get(String(person.fanza.dmmId)) : null,
      moreWorks: person.fanza?.dmmId ? moreWorksOf.get(String(person.fanza.dmmId)) : null,
      sokmilWorks: person.sokmil?.sokmilId ? sokmilWorksOf.get(String(person.sokmil.sokmilId)) : null,
      dtiWorks: dtiWorksOf.get(normaliseName(person.name)) ?? null,
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

      // B10F にしか無い区分は、ジャンルそのものを足す（3社の集計には出てこない）。
      const known = new Set(genreList.map((g) => g.slug))

      for (const found of file.genres ?? []) {
        if (!found.b10fOnly || known.has(found.slug)) continue

        genreList.push({
          name: found.name,
          slug: found.slug,
          links: { b10f: found.link },
          works: found.works,
          worksBySource: { b10f: found.works },
          b10fTags: found.b10fTags,
          b10fPerformers: found.performers.length,
          b10fOnly: true,
          performers: found.performers.map((row) => ({ ...row, b10f: row.works })),
        })
        known.add(found.slug)
      }

      for (const genre of genreList) {
        if (genre.b10fOnly) continue

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
    // 大人のおもちゃ。ジャンル名で引いたものをジャンルページに出す。
    try {
      const goodsFile = await readJson(path.join(dataDir, 'fanza-goods.json'))
      const byGenre = goodsFile.byGenre ?? {}
      let attached = 0

      for (const genre of genreList) {
        const found = byGenre[genre.name]
        if (!found) continue
        genre.goods = found
        attached += 1
      }

      console.log(`大人のおもちゃ: ${attached}ジャンルに足しました（商品 ${(goodsFile.scanned ?? 0).toLocaleString('ja-JP')}件）`)
    } catch {
      console.log('大人のおもちゃのデータが無いので、そのぶんは足しません。')
    }

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

  // シリーズ別・レーベル別・新着。FANZA の作品データがあるときだけ作る。
  // 作品数の少ないものはページにしない（表紙が数枚だけの薄いページを増やさないため）。
  const GROUP_MIN_WORKS = { series: 8, label: 30 }
  const groupUrls = []
  let hasNewPage = false

  const slugOfDmmId = new Map(
    targets.filter((p) => p.fanza?.dmmId).map((p) => [String(p.fanza.dmmId), p])
  )

  for (const [kind, file] of [['series', 'fanza-series.json'], ['label', 'fanza-labels.json']]) {
    const key = kind === 'series' ? 'series' : 'labels'
    let raw = null

    try {
      raw = (await readJson(path.join(dataDir, file)))[key] ?? {}
    } catch {
      console.log(`${GROUP_KINDS[kind].nav}のデータが無いので、そのページは作りません。`)
      continue
    }

    const entries = Object.entries(raw)
      .map(([id, value]) => ({ id, name: value.name, n: value.n ?? 0, w: value.w ?? [], p: value.p ?? {} }))
      .filter((entry) => entry.n >= GROUP_MIN_WORKS[kind] && entry.w.length > 0 && displayableName(entry.name))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'))

    const dir = path.join(publicDir, GROUP_KINDS[kind].path)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    for (const entry of entries) {
      // 出演者は、このサイトにページがある方だけを並べる（行き先の無い名前は出さない）。
      const cast = Object.entries(entry.p)
        .map(([dmmId, works]) => ({ person: slugOfDmmId.get(dmmId), works }))
        .filter((row) => row.person)
        .sort((a, b) => b.works - a.works || a.person.name.localeCompare(b.person.name, 'ja'))
        .map((row) => ({ name: row.person.name, slug: row.person.slug, works: row.works }))

      const target = path.join(dir, entry.id)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'index.html'), renderGroupPage(kind, entry, cast, confirmedOn), 'utf8')
      groupUrls.push(`${SITE_URL}/${GROUP_KINDS[kind].path}/${entry.id}/`)
    }

    if (entries.length) {
      await writeFile(path.join(dir, 'index.html'), renderGroupIndexPage(kind, entries, confirmedOn), 'utf8')
      groupUrls.push(`${SITE_URL}/${GROUP_KINDS[kind].path}/`)
      console.log(`${GROUP_KINDS[kind].nav}: ${entries.length.toLocaleString('ja-JP')}ページ`)
    }
  }

  // 新着作品。
  try {
    const file = await readJson(path.join(dataDir, 'fanza-newest.json'))
    const works = file.items ?? []

    if (works.length) {
      const dir = path.join(publicDir, 'new')
      await mkdir(dir, { recursive: true })
      await writeFile(path.join(dir, 'index.html'), renderNewPage(works, confirmedOn), 'utf8')
      hasNewPage = true
      console.log(`新着作品: ${works.length}本`)
    }
  } catch {
    console.log('新着作品のデータが無いので、そのページは作りません。')
  }

  // 同人。サークル別とジャンル別。人が入らないのでこの2軸になる。
  const DOUJIN_MIN = { circle: 5, genre: 30 }
  const doujinUrls = []

  for (const [kind, file, key] of [
    ['circle', 'doujin-circles.json', 'circles'],
    ['genre', 'doujin-genres.json', 'genres'],
  ]) {
    let raw = null

    try {
      raw = (await readJson(path.join(dataDir, file)))[key] ?? {}
    } catch {
      console.log(`同人（${DOUJIN_KINDS[kind].nav}）のデータが無いので、そのページは作りません。`)
      continue
    }

    const entries = Object.entries(raw)
      .map(([id, value]) => ({ id, name: value.name, n: value.n ?? 0, w: value.w ?? [] }))
      .filter((entry) => entry.n >= DOUJIN_MIN[kind] && entry.w.length > 0 && displayableName(entry.name))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'))

    const dir = path.join(publicDir, DOUJIN_KINDS[kind].path)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    for (const entry of entries) {
      const target = path.join(dir, entry.id)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'index.html'), renderDoujinPage(kind, entry, confirmedOn), 'utf8')
      doujinUrls.push(`${SITE_URL}/${DOUJIN_KINDS[kind].path}/${entry.id}/`)
    }

    if (entries.length) {
      await writeFile(path.join(dir, 'index.html'), renderDoujinIndex(kind, entries, confirmedOn), 'utf8')
      doujinUrls.push(`${SITE_URL}/${DOUJIN_KINDS[kind].path}/`)
      console.log(`同人 ${DOUJIN_KINDS[kind].nav}: ${entries.length.toLocaleString('ja-JP')}ページ`)
    }
  }

  // 大人のおもちゃ。メーカー別ページと入口。
  // これまでジャンルページの中にしか無く、辿り着けなかった。
  const GOODS_MIN_ITEMS = 30
  const goodsUrls = []

  try {
    const goodsFile = await readJson(path.join(dataDir, 'fanza-goods.json'))

    const makers = Object.entries(goodsFile.makers ?? {})
      .map(([id, value]) => ({ id, name: value.name, n: value.n ?? 0, w: value.w ?? [] }))
      .filter((m) => m.n >= GOODS_MIN_ITEMS && m.w.length > 0 && displayableName(m.name))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'))

    const dir = path.join(publicDir, 'goods')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    for (const maker of makers) {
      const target = path.join(dir, maker.id)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'index.html'), renderGoodsMakerPage(maker, confirmedOn), 'utf8')
      goodsUrls.push(`${SITE_URL}/goods/${maker.id}/`)
    }

    // ジャンルからも入れるようにする。名前は genres.json の並びに合わせる。
    const genreLinks = genreList
      .filter((g) => g.goods?.w?.length)
      .map((g) => ({ name: g.name, slug: g.slug, count: g.goods.w.length }))

    await writeFile(
      path.join(dir, 'index.html'),
      renderGoodsIndexPage(makers, genreLinks, goodsFile.newest ?? [], goodsFile.scanned ?? 0, confirmedOn),
      'utf8'
    )
    goodsUrls.push(`${SITE_URL}/goods/`)

    console.log(`大人のおもちゃ: メーカー ${makers.length}ページ + 入口`)
  } catch {
    console.log('大人のおもちゃのデータが無いので、そのページは作りません。')
  }

  // 作者名鑑。出演者名鑑と並ぶもう1つの軸。
  // **1〜2作品の作者はページにしない**（薄いページを増やさないため）。
  const AUTHOR_MIN_WORKS = 3
  const authorUrls = []

  try {
    const file = await readJson(path.join(dataDir, 'fanza-authors.json'))

    const authors = Object.entries(file.authors ?? {})
      .map(([id, value]) => ({ id, name: value.name, n: value.n ?? 0, w: value.w ?? {} }))
      .filter((a) => a.n >= AUTHOR_MIN_WORKS
        && Object.values(a.w).some((works) => works?.length)
        && displayableName(a.name))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ja'))

    const dir = path.join(publicDir, 'author')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })

    for (const author of authors) {
      const target = path.join(dir, author.id)
      await mkdir(target, { recursive: true })
      await writeFile(path.join(target, 'index.html'), renderAuthorPage(author, confirmedOn), 'utf8')
      authorUrls.push(`${SITE_URL}/author/${author.id}/`)
    }

    if (authors.length) {
      // 入口が長くなりすぎないよう、多い順に上位だけ並べる
      await writeFile(path.join(dir, 'index.html'),
        renderAuthorIndexPage(authors.slice(0, 2000), confirmedOn), 'utf8')
      authorUrls.push(`${SITE_URL}/author/`)
      console.log(`作者: ${authors.length.toLocaleString('ja-JP')}ページ（見た作品 ${(file.scanned ?? 0).toLocaleString('ja-JP')}件）`)
    }
  } catch {
    console.log('作者のデータが無いので、作者ページは作りません。')
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
        // 右のジャンル一覧と縦の長さが釣り合うくらいに出す。
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
    ...(hasNewPage ? [`${SITE_URL}/new/`] : []),
    ...groupUrls,
    ...doujinUrls,
    ...goodsUrls,
    ...authorUrls,
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

  // 出演者以外のページも記録する。**これが無いと IndexNow に通知されない。**
  // published-slugs.txt は出演者のスラッグしか持たないため、シリーズ・
  // レーベル・同人・新着が増えても、増えたぶんを送る経路が無かった。
  await writeFile(
    path.join(publicDir, 'data/published-pages.txt'),
    `${[...new Set(entries.filter((url) => !url.includes('/actress/')))].sort().join('\n')}\n`,
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
