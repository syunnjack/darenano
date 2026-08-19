import { useMemo, useState } from 'react'
import { people } from './data/actresses.js'
import './index.css'

// 名前の一部・読みの一部から絞り込むだけの画面。
// 身長やカップ数などの属性は、出典が無いため持っていない。
const SEARCH_URL = (name) =>
  `https://www.dmm.co.jp/search/=/searchstr=${encodeURIComponent(name)}/`

export default function App() {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const q = query.trim()

    if (!q) {
      return people
    }

    return people.filter((person) => person.name.includes(q) || person.read.includes(q))
  }, [query])

  return (
    <main className="wrap">
      <header>
        <h1>誰なの？</h1>
        <p className="lead">名前や読みの一部から探せます。掲載しているのは名前と読みだけです。</p>
      </header>

      <div className="search">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="名前・読みの一部（例: ふかだ）"
          aria-label="名前で検索"
        />
        {query && (
          <button type="button" onClick={() => setQuery('')}>クリア</button>
        )}
      </div>

      <p className="count">{filtered.length}件</p>

      <ul className="list">
        {filtered.map((person) => (
          <li key={person.name}>
            <span className="name">{person.name}</span>
            <span className="read">{person.read}</span>
            <a href={SEARCH_URL(person.name)} rel="nofollow noopener" target="_blank">
              配信サイトで名前を検索
            </a>
          </li>
        ))}
      </ul>

      {filtered.length === 0 && (
        <p className="empty">該当する名前が見つかりませんでした。</p>
      )}

      <section className="about">
        <h2>掲載しているもの</h2>
        <p>
          名前と読みだけです。身長・スリーサイズ・所属事務所・デビュー年・外見の特徴は、
          裏付けを確認できないため掲載していません。
        </p>
        <p>
          作品情報へのリンクは、名前で検索する形にしています。ID を直接指定すると、
          取り違えたときに別人のページへ誘導してしまうためです。
          検索結果が目的の方と一致するかは、ご自身でご確認ください。
        </p>

        <h2>掲載の削除について</h2>
        <p>
          ご本人・関係者の方で掲載を希望されない場合は、下記へご連絡ください。確認のうえ削除します。
          誤りのご指摘も同じ窓口で受け付けます。
        </p>
        <p>
          <a href="mailto:info@darekore.jp">info@darekore.jp</a>
        </p>

        <h2>年齢確認</h2>
        <p>
          このサイトは成人向けコンテンツを扱う配信サイトへのリンクを含みます。18歳未満の方はご利用いただけません。
        </p>
      </section>
    </main>
  )
}
