import { useState, useMemo } from 'react'
import { actresses, allAgencies } from './data/actresses.js'
import './index.css'

const POPULAR_TAGS = ['巨乳', 'スレンダー', 'かわいい', '清楚', '人気', 'ロリ系', '美脚', '超巨乳', '新世代']

const SORTS = [
  { value: 'default',     label: '標準' },
  { value: 'debut_new',   label: 'デビュー新しい順' },
  { value: 'debut_old',   label: 'デビュー古い順' },
  { value: 'height_desc', label: '身長高い順' },
]

export default function App() {
  const [query,     setQuery]     = useState('')
  const [agency,    setAgency]    = useState('')
  const [debutFrom, setDebutFrom] = useState('')
  const [activeTag, setActiveTag] = useState('')
  const [sort,      setSort]      = useState('default')

  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    let list = actresses.filter(a => {
      if (q && !a.name.includes(query) && !a.read.includes(q)) return false
      if (agency && a.agency !== agency) return false
      if (debutFrom && a.debut < parseInt(debutFrom)) return false
      if (activeTag && !a.tags.includes(activeTag)) return false
      return true
    })
    if (sort === 'debut_new')   list = [...list].sort((a, b) => b.debut - a.debut)
    if (sort === 'debut_old')   list = [...list].sort((a, b) => a.debut - b.debut)
    if (sort === 'height_desc') list = [...list].sort((a, b) => b.height - a.height)
    return list
  }, [query, agency, debutFrom, activeTag, sort])

  const toggleTag = tag => setActiveTag(t => t === tag ? '' : tag)
  const resetAll  = () => { setQuery(''); setAgency(''); setDebutFrom(''); setActiveTag(''); setSort('default') }
  const hasFilter = query || agency || debutFrom || activeTag

  return (
    <>
      <header className="site-header">
        <h1>👤 誰なの？</h1>
        <p>AV女優・グラビアアイドルの名前・特徴から一発検索 — {actresses.length}名収録</p>
      </header>

      <div className="search-bar">
        <input type="search" placeholder="名前・読み仮名で検索…" value={query} onChange={e => setQuery(e.target.value)} />
        <select value={agency} onChange={e => setAgency(e.target.value)}>
          <option value="">事務所すべて</option>
          {allAgencies.map(ag => <option key={ag}>{ag}</option>)}
        </select>
        <select value={debutFrom} onChange={e => setDebutFrom(e.target.value)}>
          <option value="">デビュー年▼</option>
          {[2023,2022,2021,2020,2019,2018,2017,2016,2015,2010,2008,2000].map(y =>
            <option key={y} value={y}>{y}年以降</option>
          )}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)}>
          {SORTS.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>

        <div className="tag-filters">
          {POPULAR_TAGS.map(t => (
            <button key={t} className={`tag-btn${activeTag === t ? ' active' : ''}`} onClick={() => toggleTag(t)}>{t}</button>
          ))}
          {hasFilter && <button className="tag-btn reset-btn" onClick={resetAll}>✕ リセット</button>}
        </div>
        <span className="count-label">{filtered.length} 件</span>
      </div>

      {filtered.length === 0
        ? <p className="empty">該当する女優が見つかりませんでした</p>
        : <div className="grid">{filtered.map(a => <ActressCard key={a.id} actress={a} />)}</div>
      }

      <footer>
        <p>当サイトはFANZAアフィリエイトプログラムに参加しています。</p>
        <p style={{marginTop:'4px'}}>18歳未満の方のアクセスはお断りしています。</p>
      </footer>
    </>
  )
}

function ActressCard({ actress: a }) {
  const emoji = a.bust === 'J' || a.bust === 'H' ? '🌸' : a.debut >= 2021 ? '✨' : '💕'
  return (
    <article className="actress-card">
      <div className="card-thumb">{emoji}</div>
      <div className="card-body">
        <div className="card-name">{a.name}</div>
        <div className="card-read">{a.read}</div>
        <div className="card-meta">デビュー：{a.debut}年 ／ 身長：{a.height}cm ／ バスト：{a.bust}カップ</div>
        <div className="card-meta">事務所：{a.agency}</div>
        <div className="card-tags">{a.tags.map(t => <span key={t} className="card-tag">{t}</span>)}</div>
        <a className="card-fanza" href={a.fanza} target="_blank" rel="noopener noreferrer nofollow">FANZAで動画を見る →</a>
      </div>
    </article>
  )
}
