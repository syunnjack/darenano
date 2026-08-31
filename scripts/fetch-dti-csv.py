"""DTI CASH の作品CSVから、出演者ごとの出演作品を取り出す。

出典: DTI CASH アフィリエイトプログラム（管理画面の広告素材からエクスポート）

**中身は無修正の作品**（カリビアンコム／カリビアンコムプレミアム／HEYZO）。
darekore.jp では、**その人に実際に作品がある出演者ページにだけ**出す。
サイト全体にバナーを貼るような出し方はしない。

2026年8月の実績はクリック 60 に対して入会 0 件だった。着地点が
作品ページでなかったことが原因なので、CSVに入っている作品単位の
アフィリエイトリンク（`aff_link`）をそのまま使う。

CSVの列:
  movie_id, site_id, site_name, title, actress, description,
  release_date, sample_url, aff_link, original_id, sample_movie_url_2, provider_name

**出演者は空白区切りで複数入る。** 1作品に2人以上のことがある。

CSVは管理画面から落としたものを `data/dti-movies.csv` に置く（B10Fと同じやり方）。
入れ替えれば新しい作品が入る。

使い方: python scripts/fetch-dti-csv.py
"""
import csv
import io
import json
import re
import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CSV_PATH = ROOT / 'data' / 'dti-movies.csv'
OUT_PATH = ROOT / 'data' / 'dti-performer-works.json'

WORKS_KEPT = 6
SKIP_NAMES = {'不明', '素人', '一般女性', '-', '―', ''}


def parse_date(text: str) -> str:
    """「2026/08/06」を「2026-08-06」にする。読めなければ空文字。"""
    matched = re.match(r'(\d{4})[/-](\d{1,2})[/-](\d{1,2})', (text or '').strip())

    if not matched:
        return ''

    year, month, day = (int(part) for part in matched.groups())
    return f'{year:04d}-{month:02d}-{day:02d}'


def keep_newest(bucket: list, work: dict) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[WORKS_KEPT:]


def main() -> int:
    if not CSV_PATH.exists():
        print(f'{CSV_PATH} がありません。', file=sys.stderr)
        return 1

    rows = list(csv.DictReader(io.StringIO(CSV_PATH.read_text(encoding='utf-8-sig'))))
    performers: dict[str, dict] = {}
    sites: dict[str, int] = {}

    for row in rows:
        link = (row.get('aff_link') or '').strip()
        title = (row.get('title') or '').strip()
        movie_id = (row.get('movie_id') or '').strip()
        site = (row.get('site_name') or '').strip()
        released = parse_date(row.get('release_date') or '')

        # 作品単位のリンクが無い行は使わない（着地点が作品でなければ意味が無い）
        if not link or not title or not movie_id:
            continue

        sites[site] = sites.get(site, 0) + 1

        for name in re.split(r'[\s　,、]+', (row.get('actress') or '').strip()):
            name = name.strip()

            if name in SKIP_NAMES:
                continue

            record = performers.setdefault(name, {'name': name, 'n': 0, 'w': []})
            record['n'] += 1
            keep_newest(record['w'], {'c': movie_id, 't': title, 'd': released,
                                      'u': link, 's': site})

    OUT_PATH.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'source': 'DTI CASH アフィリエイトプログラム 作品CSV',
        'scanned': len(rows),
        'sites': sites,
        'worksPerPerformer': WORKS_KEPT,
        'performers': list(performers.values()),
    }, ensure_ascii=False), encoding='utf-8')

    print(f'{len(rows):,}作品 → 出演者 {len(performers):,}人', file=sys.stderr)
    for site, count in sorted(sites.items(), key=lambda kv: -kv[1]):
        print(f'  {site} {count:,}件', file=sys.stderr)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
