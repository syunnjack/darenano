import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const MAX_RESULTS = 60

/** カタカナをひらがなに寄せ、空白を落とす。検索の突き合わせ用。 */
function normalise(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/[ァ-ヶ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0x60))
    .replace(/[\s　・･]/g, '')
    .toLowerCase()
}

/** URL に使う形へ。scripts/build-site.mjs の slugify と同じ処理。 */
function slugify(name) {
  const base = String(name || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
  return base || 'unknown'
}

/** 検索用の索引（TSV）を、必要になったときだけ読み込む。 */
function useSearchIndex() {
  const [index, setIndex] = useState(null)
  const [loading, setLoading] = useState(false)
  const started = useRef(false)

  const load = useCallback(() => {
    if (started.current) return
    started.current = true
    setLoading(true)

    fetch('/data/search-index.tsv')
      .then((response) => response.text())
      .then((text) => {
        const rows = text.split('\n').filter(Boolean).map((line) => {
          const [name, reading = '', slug = '', aliases = ''] = line.split('\t')
          return {
            name,
            reading,
            slug: slug || slugify(name),
            aliases,
            key: normalise(name) + normalise(reading) + normalise(aliases),
          }
        })
        setIndex(rows)
      })
      .catch(() => setIndex([]))
      .finally(() => setLoading(false))
  }, [])

  return { index, loading, load }
}

// 出演者ページと同じアフィリエイトリンクの作り。
// af_id は静的ページ側（scripts/build-site.mjs）と同じものを使う。
const FANZA_AFFILIATE_ID = 'syunnda1-997'

function fanzaLink(target) {
  return `https://al.fanza.co.jp/?lurl=${encodeURIComponent(target)}&af_id=${FANZA_AFFILIATE_ID}&ch=api`
}

function App() {
  const [query, setQuery] = useState(() => new URLSearchParams(location.search).get('q') ?? '')
  const [featured, setFeatured] = useState(null)
  const [genres, setGenres] = useState([])
  // 作者ページを作っていないときにリンクを出すと404になる
  const [hasAuthors, setHasAuthors] = useState(false)
  const [ranking, setRanking] = useState([])
  const { index, loading, load } = useSearchIndex()

  useEffect(() => {
    fetch('/data/featured.json')
      .then((response) => response.json())
      .then(setFeatured)
      .catch(() => setFeatured(null))
  }, [])

  // 当サイトの投票によるランキング。上位だけをトップページに出す。
  useEffect(() => {
    let cancelled = false

    fetch('/data/ugc-config.json')
      .then((response) => response.json())
      .then(({ api, key }) => {
        if (!api || !key) return []
        const url = `${api}/rest/v1/performer_stats`
          + '?select=slug,votes,reviews&order=votes.desc&limit=10'
        return fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` } })
          .then((response) => (response.ok ? response.json() : []))
      })
      .then((rows) => {
        if (!cancelled) setRanking((rows ?? []).filter((row) => Number(row.votes) > 0))
      })
      .catch(() => {})

    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    fetch('/data/genre-index.json')
      .then((response) => response.json())
      .then((file) => { setGenres(file.genres ?? []); setHasAuthors(Boolean(file.hasAuthors)) })
      .catch(() => setGenres([]))
  }, [])

  useEffect(() => {
    const next = query.trim()
      ? `${location.pathname}?q=${encodeURIComponent(query.trim())}`
      : location.pathname
    history.replaceState(null, '', next)

    if (query.trim()) load()
  }, [query, load])

  const results = useMemo(() => {
    const keyword = normalise(query)
    if (!keyword || !index) return []
    return index.filter((row) => row.key.includes(keyword)).slice(0, MAX_RESULTS)
  }, [query, index])

  const searching = query.trim().length > 0

  return (
    <main className="site">
      <header className="masthead">
        <p className="site-name">この子だれ？</p>
        <nav>
          <a href="/actress/">五十音索引</a>
          <a href="/genre/">ジャンル別</a>
          <a href="/doujin/">同人</a>
          <a href="/goods/">大人のおもちゃ</a>
          <a href="/ranking/">投票ランキング</a>
        </nav>
      </header>

      <section className="hero">
        <h1>名前から、出演者のプロフィールを引く</h1>
        <p className="lead">
          FANZA・DUGA・ソクミル・B10F が公開している出演者情報を集めた名鑑です。
          {featured
            ? `${featured.total.toLocaleString('ja-JP')}人を収録し、うち${featured.detailed.toLocaleString('ja-JP')}人は生年月日や身長などのプロフィールを確認できています。`
            : ''}
          名前の一部や読みを入れると、候補を絞り込めます。
        </p>

        <form className="search" role="search" onSubmit={(event) => event.preventDefault()}>
          <label className="visually-hidden" htmlFor="q">出演者名で検索</label>
          <input
            id="q"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onFocus={load}
            placeholder="名前や読みの一部を入力（例: あいざわ）"
            autoComplete="off"
          />
        </form>
      </section>

      {!searching && ranking.length > 0 && (
        <section className="ranking-strip" aria-label="投票ランキング">
          <div className="ranking-head">
            <h2>投票ランキング</h2>
            <a href="/ranking/">すべて見る</a>
          </div>
          <p className="ranking-lead">
            当サイトで押された票の数です。外部の人気度ではありません。
            出演者のページから投票できます。
          </p>
          <ol className="ranking-top">
            {ranking.slice(0, 5).map((row, position) => (
              <li key={row.slug}>
                <span className="ranking-no" aria-hidden="true">{position + 1}</span>
                <a href={`/actress/${encodeURIComponent(row.slug)}/`}>
                  {decodeURIComponent(row.slug)}
                </a>
                <span className="ranking-count">
                  {Number(row.votes).toLocaleString('ja-JP')}票
                  {Number(row.reviews) > 0 && `・口コミ${Number(row.reviews).toLocaleString('ja-JP')}件`}
                </span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <div className="layout">
        <div className="column-main">
      {searching && (
        <section className="results" aria-live="polite">
          <h2>
            検索結果
            {index && <span className="count">{results.length >= MAX_RESULTS ? `${MAX_RESULTS}件以上` : `${results.length}件`}</span>}
          </h2>

          {loading && <p className="note">読み込み中です…</p>}

          {!loading && index && results.length === 0 && (
            <p className="note">
              該当する名前が見つかりませんでした。読み（ひらがな）でも試してみてください。
            </p>
          )}

          <ul className="name-list">
            {results.map((row) => (
              <li key={row.slug}>
                <a href={`/actress/${row.slug}/`}>
                  {row.name}
                  {row.reading && <span className="reading">{row.reading}</span>}
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {!searching && featured?.mostWorks?.length > 0 && (
        <section className="results">
          <h2>出演作品数の多い方</h2>
          <p className="section-note">
            DUGA の作品データに記録されている収録作品数の順です。
            当サイトが人気や評価を判断したものではありません。
          </p>
          <ol className="card-list numbered">
            {featured.mostWorks.map((person, position) => (
              <li key={person.slug}>
                <a href={`/actress/${person.slug}/`}>
                  <span className="card-rank" aria-hidden="true">{position + 1}</span>
                  <span className="card-name">{person.name}</span>
                  {person.reading && <span className="card-reading">{person.reading}</span>}
                  <span className="card-facts">{person.works.toLocaleString('ja-JP')}作品</span>
                </a>
              </li>
            ))}
          </ol>
          <p className="more">
            <a href="/actress/">五十音索引ですべて見る</a>
          </p>
        </section>
      )}



        </div>

        {/* ジャンルの一覧。広い画面では右側に置き、狭い画面では本文の下へ回る。 */}
        {genres.length > 0 && (
          <aside className="column-side" aria-label="ジャンルから探す">
            <h2>ジャンルから探す</h2>
            <p className="genres-lead">
              FANZA・DUGA・ソクミル・B10F が作品に付けているジャンルごとに、
              出演本数の多い方を並べています。
            </p>
            <ul className="genre-chips">
              {genres.map((genre) => (
                <li key={genre.slug}>
                  <a href={`/genre/${genre.slug}/`}>
                    <span className="genre-name">{genre.name}</span>
                    <span className="genre-count">{genre.people.toLocaleString('ja-JP')}人</span>
                  </a>
                </li>
              ))}
            </ul>
            <p className="more">
              <a href="/genre/">ジャンル別の一覧を見る</a>
            </p>

            {/* 出演者名鑑とは別の軸。人が出てこないので、ジャンルとサークル、
                メーカーで辿る。フッタのリンクだけでは辿り着けなかった。 */}
            <h2 className="side-head">別の探し方</h2>
            <ul className="other-ways">
              {hasAuthors && (
                <li>
                  <a href="/author/">
                    <span className="way-name">作者から探す</span>
                    <span className="way-note">コミック・ノベル・ゲーム</span>
                  </a>
                </li>
              )}
              <li>
                <a href="/doujin/">
                  <span className="way-name">同人</span>
                  <span className="way-note">ジャンル別・サークル別</span>
                </a>
              </li>
              <li>
                <a href="/goods/">
                  <span className="way-name">大人のおもちゃ</span>
                  <span className="way-note">ジャンル別・メーカー別</span>
                </a>
              </li>
              <li>
                <a href="/series/">
                  <span className="way-name">シリーズ別</span>
                  <span className="way-note">同じシリーズの作品</span>
                </a>
              </li>
              <li>
                <a href="/label/">
                  <span className="way-name">レーベル別</span>
                  <span className="way-note">レーベルごとの作品</span>
                </a>
              </li>
              <li>
                <a href="/new/">
                  <span className="way-name">新着作品</span>
                  <span className="way-note">発売日の新しい順</span>
                </a>
              </li>
            </ul>
          </aside>
        )}
      </div>

      <section className="about">
        <h2>このサイトについて</h2>
        <p>
          掲載しているのは、FANZA と DUGA が API で公開している項目だけです。
          出典が確認できないことは書きません。身体的特徴や経歴を推測で補うこともしません。
        </p>
        <p>
          そのため、名前と読みしか分からない方のページには、プロフィール欄がありません。
          情報が無いことを、そのまま「無い」と表示しています。
        </p>
        <ul className="sources">
          <li>
            <a href="https://affiliate.dmm.com/api/" target="_blank" rel="noopener">FANZA ActressSearch API</a>
          </li>
          <li>
            <a href="https://affiliate.duga.jp/" target="_blank" rel="noopener">DUGA アフィリエイト Web サービス</a>
          </li>
        </ul>
        {featured?.confirmedOn && (
          <p className="note">{featured.confirmedOn} 時点のデータです。</p>
        )}
      </section>

      <section className="about">
        <h2>訂正・削除のご依頼</h2>
        <p>
          ご本人および関係者の方から掲載を希望しない旨のご連絡をいただいた場合、確認のうえ削除します。
          記載内容の誤りについても同じ窓口で承ります。
        </p>
        <p>
          <a href="mailto:info@darekore.jp">info@darekore.jp</a>
        </p>
      </section>

      {/* FANZA の、作品APIに出てこないサービス。ライブチャットとくじは
          ItemList に入っていないので作品単位のリンクが作れない。入口へ送る。
          URLは実際に叩いて題名で確かめたもの（2026-09-03）。 */}
      <section className="fanza-services">
        <h2>
          FANZA の他のサービス<span className="pr">広告</span>
        </h2>
        <ul>
          <li>
            <a href={fanzaLink('https://www.dmm.co.jp/live/chat/-/search/')}
               target="_blank" rel="nofollow sponsored noopener">FANZAライブチャット</a>
            <span className="service-note">いま配信中の女性を探せます</span>
          </li>
          <li>
            <a href={fanzaLink('https://www.dmm.co.jp/kuji/')}
               target="_blank" rel="nofollow sponsored noopener">FANZAオンラインくじ</a>
            <span className="service-note">グッズが当たるオンラインくじです</span>
          </li>
        </ul>
      </section>

      <footer className="site-footer">
        <p className="adult">このサイトは18歳未満の方に向けたものではありません。</p>
        <nav aria-label="フッターナビ">
          <a href="/actress/">五十音索引</a>
          <a href="/genre/">ジャンル別</a>
          <a href="/doujin/">同人</a>
          <a href="/goods/">大人のおもちゃ</a>
          <a href="/ranking/">投票ランキング</a>
          <a href="/privacy/">プライバシーポリシー</a>
          <a href="mailto:info@darekore.jp">お問い合わせ</a>
        </nav>
        <p className="credit">
          {/* DUGA ウェブサービスの規約で表示が義務づけられているクレジット。
              指定のHTMLをそのまま出す必要があるため、属性を足さない。 */}
          <a href="https://click.duga.jp/aff/api/21786-01" target="_blank">Powered by DUGAウェブサービス</a>
          {' '}
          {/* ソクミルも指定のHTMLをそのまま出すことが義務づけられている。 */}
          <a href="https://sokmil-ad.com/" target="_blank" rel="nofollow">
            <img src="https://sokmil-ad.com/api/credit/135x18.gif" alt="WEB SERVICE BY SOKMIL" width="135" height="18" border="0" />
          </a>
        </p>
        <p className="copy">© {new Date().getFullYear()} この子だれ？</p>
      </footer>
    </main>
  )
}

export default App
