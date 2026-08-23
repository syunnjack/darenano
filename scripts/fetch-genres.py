"""FANZA動画のジャンル別に、出演者ごとの出演本数を数える。

出典: FANZA アフィリエイト Web サービス（FloorList / GenreSearch / ItemList）
      https://affiliate.dmm.com/api/

ActressSearch はプロフィールしか返さないため、「どのジャンルの作品に
何本出ているか」は分からない。ItemList をジャンルで引くと、作品ごとの
出演者（actress）が入っているので、それを数える。

作品のタイトルは持たない。露骨な語を含むものが多いため。
数えるのは出演本数だけで、ジャンル名は FANZA の表記をそのまま使う。

**ジャンルIDは書かない。** 数字を書き写すと取り違えても気づけないので、
GenreSearch でジャンル名から引き当てる。名前が見つからないジャンルは
黙って飛ばす（勝手なIDで別のジャンルを数えないため）。
フロアIDも FloorList から取る。

API の offset 上限は50,000。ジャンル1つあたり最大500ページ・約5分。
13ジャンルで2時間近くかかるので、ONLY に slug を並べると、その分だけを
取り直して残りは前回の結果を引き継ぐ（ONLY=hitozuma,nurse のように書く）。

認証は環境変数から読む。リポジトリには置かない。
  FANZA_API_ID / FANZA_AFFILIATE_ID

使い方:
  FANZA_API_ID=xxx FANZA_AFFILIATE_ID=yyy \
    python scripts/fetch-genres.py public/data/genres.json
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

BASE = 'https://api.dmm.com/affiliate/v3'
HITS = 100
INTERVAL = 0.5
MAX_OFFSET = 50000

# 取り上げるジャンルと、URLに使う名前。
# 名前は FANZA の表記のまま。こちらで言い換えると、GenreSearch で
# 引き当てられなくなる。slug は URL 用のローマ字。
GENRES = [
    {'name': 'バック', 'slug': 'back'},
    {'name': '騎乗位', 'slug': 'kijoi'},
    {'name': '素人', 'slug': 'shirouto'},
    {'name': 'ハメ撮り', 'slug': 'hamedori'},
    {'name': '巨乳', 'slug': 'kyonyu'},
    {'name': '美少女', 'slug': 'bishojo'},
    {'name': '人妻・主婦', 'slug': 'hitozuma'},
    {'name': '熟女', 'slug': 'jukujo'},
    {'name': '痴女', 'slug': 'chijo'},
    {'name': '制服', 'slug': 'seifuku'},
    {'name': '水着', 'slug': 'mizugi'},
    {'name': 'メイド', 'slug': 'maid'},
    {'name': '看護婦・ナース', 'slug': 'nurse'},
    {'name': 'OL', 'slug': 'ol'},
    {'name': '女子大生', 'slug': 'joshidaisei'},
    {'name': 'スレンダー', 'slug': 'slender'},
]


def call(endpoint: str, params: dict) -> dict:
    query = urllib.parse.urlencode(params)

    for attempt in range(5):
        try:
            with urllib.request.urlopen(f'{BASE}/{endpoint}?{query}', timeout=60) as response:
                return json.loads(response.read().decode())
        except Exception as error:
            if attempt == 4:
                raise
            print(f'    再試行 {attempt + 1}/4: {error}', file=sys.stderr)
            time.sleep(3 * (attempt + 1))

    return {}


def videoa_floor_id(credentials: dict) -> str:
    """動画（videoa）のフロアIDを FloorList から取る。数字は書き写さない。"""
    payload = call('FloorList', dict(credentials, output='json')).get('result', {})

    for site in payload.get('site') or []:
        if site.get('code') != 'FANZA':
            continue
        for service in site.get('service') or []:
            if service.get('code') != 'digital':
                continue
            for floor in service.get('floor') or []:
                if floor.get('code') == 'videoa':
                    return str(floor.get('id'))

    raise SystemExit('FloorList に FANZA/digital/videoa が見つかりませんでした。')


def genre_ids(credentials: dict, floor_id: str) -> dict:
    """ジャンル名 → ジャンルID の対応表を GenreSearch から作る。"""
    table = {}
    offset = 1

    while True:
        payload = call('GenreSearch', dict(
            credentials, output='json', floor_id=floor_id,
            hits=500, offset=offset,
        )).get('result', {})

        rows = payload.get('genre') or []
        if not rows:
            break

        for row in rows:
            name = (row.get('name') or '').strip()
            if name and name not in table:
                table[name] = str(row.get('genre_id'))

        offset += 500
        if offset > int(payload.get('total_count') or 0):
            break

        time.sleep(INTERVAL)

    return table


def count_performers(credentials: dict, genre_id: str) -> tuple[Counter, dict, dict, int, int]:
    counts = Counter()
    readings = {}
    ids = {}
    seen = set()
    offset = 1
    total = None

    while True:
        payload = call('ItemList', dict(
            credentials, output='json', site='FANZA', service='digital',
            floor='videoa', article='genre', article_id=genre_id,
            hits=HITS, offset=offset, sort='rank',
        )).get('result', {})

        items = payload.get('items') or []

        if total is None:
            total = int(payload.get('total_count') or 0)

        if not items:
            break

        for item in items:
            content_id = item.get('content_id')
            if content_id in seen:
                continue
            seen.add(content_id)

            for actress in (item.get('iteminfo') or {}).get('actress') or []:
                name = (actress.get('name') or '').strip()
                if not name:
                    continue
                counts[name] += 1
                if actress.get('ruby'):
                    readings.setdefault(name, actress['ruby'])
                if actress.get('id'):
                    ids.setdefault(name, str(actress['id']))

        offset += HITS

        if offset > min(total or 0, MAX_OFFSET):
            break

        time.sleep(INTERVAL)

    return counts, readings, ids, total or 0, len(seen)


def write(output: Path, result: list) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': 'FANZA アフィリエイト Web サービス（動画）',
        'sourceUrl': 'https://affiliate.dmm.com/api/',
        'genres': result,
    }, ensure_ascii=False), encoding='utf-8')


def main() -> None:
    output = Path(sys.argv[1])

    api_id = os.environ.get('FANZA_API_ID')
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID')

    if not api_id or not affiliate_id:
        raise SystemExit('環境変数 FANZA_API_ID と FANZA_AFFILIATE_ID が必要です。')

    credentials = {'api_id': api_id, 'affiliate_id': affiliate_id}

    floor_id = videoa_floor_id(credentials)
    table = genre_ids(credentials, floor_id)
    print(f'ジャンルの一覧を取りました: {len(table):,}件（フロアID {floor_id}）', flush=True)

    # ONLY が指定されていれば、その slug だけを取り直す。
    # 残りは前回の結果をそのまま引き継ぐ。
    only = {s.strip() for s in (os.environ.get('ONLY') or '').split(',') if s.strip()}
    previous = {}

    if only and output.exists():
        try:
            for row in json.loads(output.read_text(encoding='utf-8')).get('genres', []):
                previous[row['slug']] = row
            print(f'前回の結果を引き継ぎます: {len(previous)}ジャンル', flush=True)
        except Exception as error:
            print(f'前回の結果を読めませんでした（全部取り直します）: {error}', file=sys.stderr)
            only = set()

    result = []

    for genre in GENRES:
        if only and genre['slug'] not in only:
            if genre['slug'] in previous:
                result.append(previous[genre['slug']])
            continue

        genre_id = table.get(genre['name'])

        if not genre_id:
            print(f"  {genre['name']}: FANZA のジャンル一覧に無いので飛ばします", flush=True)
            continue

        counts, readings, ids, total, scanned = count_performers(credentials, genre_id)

        people = [
            {'name': name, 'works': count,
             'reading': readings.get(name, ''), 'dmmId': ids.get(name, '')}
            for name, count in counts.most_common()
        ]

        result.append({
            'id': int(genre_id),
            'name': genre['name'],
            'slug': genre['slug'],
            'works': total,
            'scanned': scanned,
            'performers': people,
        })

        print(f"  {genre['name']}: 作品{total:,}件 → 出演者 {len(people):,}人"
              f"（{scanned:,}作品を確認）", flush=True)

        # ジャンルごとに書き出す。途中で止まっても、取れたぶんは残る。
        write(output, result)

    write(output, result)

    print()
    print(f'{len(result)}ジャンルを書き出しました → {output}')


main()
