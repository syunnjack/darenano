/**
 * 配信しないデータを dist から消す。
 *
 * ## なぜ
 *
 * `public/data/` には、ページを組み立てるための元データが置いてある。
 * Vite は public/ をまるごと dist/ に写すので、**84MB の JSON が
 * そのまま公開されていた**（2026-09-03 実測）。
 *
 *   genres.json 28.2MB / duga-products.json 22.0MB
 *   actresses.json 19.1MB / sokmil.json 12.4MB
 *
 * これは誰も読まない。画面が読むのは下の KEEP の4つだけ
 * （src/App.jsx の fetch を確認済み）。巡回の手間と転送量の無駄なので消す。
 * **消すのは dist だけ。** public/ の元データは次のビルドで要る。
 */
import { readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dataDir = path.join(root, 'dist', 'data')

// 画面が fetch するもの。ここに無いファイルは配信しない。
const KEEP = new Set([
  'search-index.tsv',
  'featured.json',
  'ugc-config.json',
  'genre-index.json',
])

let removed = 0
let bytes = 0

for (const name of await readdir(dataDir)) {
  if (KEEP.has(name)) continue

  const target = path.join(dataDir, name)
  bytes += (await stat(target)).size
  await rm(target, { recursive: true, force: true })
  removed += 1
}

console.log(`配信しないデータを ${removed} 件（${(bytes / 1048576).toFixed(1)}MB）dist から外しました。`)
