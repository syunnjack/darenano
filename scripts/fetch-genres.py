"""ジャンル別に、出演者ごとの出演本数を数える。FANZA・DUGA・ソクミルの3社。

出典:
  FANZA アフィリエイト Web サービス  https://affiliate.dmm.com/api/
  DUGA アフィリエイト Web サービス   https://affiliate.duga.jp/
  ソクミルアフィリエイト WEBサービス  https://sokmil-ad.com/

出演者検索のAPIはプロフィールしか返さないため、「どのジャンルの作品に
何本出ているか」は分からない。作品をジャンルで引くと出演者が入っている
ので、それを数える。

作品のタイトルは持たない。露骨な語を含むものが多いため。
数えるのは出演本数だけで、ジャンル名は各社の表記をそのまま使う。

**IDは書き写さない。** 数字を書き写すと取り違えても気づけないので、
各社のジャンル一覧をAPIから取り、名前で引き当てる。名前が見つからない
ジャンルはその社を飛ばす（勝手なIDで別のジャンルを数えないため）。

  FANZA   FloorList でフロアID → GenreSearch で名前→ID
  ソクミル Genre API で名前→ID（586件）
  DUGA    カテゴリ一覧のAPIが無いので、作品を広く見て名前→ID を作る

社によって呼び方が違うものがある（制服／制服女子、レズビアン／レズ）。
その場合は候補を並べ、**実在した名前だけ**を使う。

数える量には上限がある。FANZAは offset 上限の50,000件、DUGAとソクミルは
時間の都合で人気順の上位から SCAN_LIMIT 件まで。ページにもその旨を出す。

認証は環境変数から読む。リポジトリには置かない。
  FANZA_API_ID / FANZA_AFFILIATE_ID
  DUGA_APP_ID / DUGA_AGENT_ID
  SOKMIL_API_KEY / SOKMIL_AFFILIATE_ID
  ONLY に slug を並べると、その分だけ取り直して残りは前回の結果を引き継ぐ

使い方:
  FANZA_API_ID=xxx ... python scripts/fetch-genres.py public/data/genres.json
"""
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import Counter
from datetime import date
from pathlib import Path

FANZA_BASE = 'https://api.dmm.com/affiliate/v3'
DUGA_API = 'http://affapi.duga.jp/search'
SOKMIL_BASE = 'https://sokmil-ad.com/api/v1'

FANZA_MAX_OFFSET = 50000      # API の上限
SCAN_LIMIT = 5000             # DUGA・ソクミルはここまで（時間の都合）
DUGA_CATEGORY_SCAN = 4000     # カテゴリ名→ID を作るために見る作品数

# 取り上げるジャンル。名前は FANZA の表記のまま。
# duga / sokmil は、その社での呼び方が違うときの候補。
# 実在した名前だけを使い、どれも無ければその社は飛ばす。
GENRES = [
    {'name': 'バック', 'slug': 'back'},
    {'name': '騎乗位', 'slug': 'kijoi'},
    {'name': '素人', 'slug': 'shirouto'},
    {'name': 'ハメ撮り', 'slug': 'hamedori'},
    {'name': 'コスプレ', 'slug': 'cosplay'},
    {'name': 'レズビアン', 'slug': 'lesbian', 'duga': ['レズ'], 'sokmil': ['レズ']},
    {'name': '巫女', 'slug': 'miko'},
    {'name': '中出し', 'slug': 'nakadashi'},
    {'name': '寝取り・寝取られ・NTR', 'slug': 'netorare',
     'duga': ['寝取られ', '寝取り', 'NTR'], 'sokmil': ['寝取られ', 'NTR']},
    {'name': 'アクメ・オーガズム', 'slug': 'acme', 'sokmil': ['アクメ'], 'duga': ['アクメ']},
    {'name': 'パンチラ', 'slug': 'panchira'},
    {'name': 'ぽっちゃり', 'slug': 'pocchari'},
    {'name': 'カーセックス', 'slug': 'car'},
    {'name': '巨乳', 'slug': 'kyonyu', 'duga': ['おっぱい']},
    {'name': '美少女', 'slug': 'bishojo'},
    {'name': '人妻・主婦', 'slug': 'hitozuma', 'duga': ['人妻'], 'sokmil': ['人妻']},
    {'name': '熟女', 'slug': 'jukujo'},
    {'name': '痴女', 'slug': 'chijo'},
    {'name': '制服', 'slug': 'seifuku', 'duga': ['制服女子']},
    {'name': '水着', 'slug': 'mizugi'},
    {'name': 'メイド', 'slug': 'maid'},
    {'name': '看護婦・ナース', 'slug': 'nurse', 'duga': ['ナース'], 'sokmil': ['ナース']},
    {'name': 'OL', 'slug': 'ol'},
    {'name': '女子大生', 'slug': 'joshidaisei'},
    {'name': 'スレンダー', 'slug': 'slender'},
]


def fetch(url: str, tries: int = 5, wait: float = 3.0) -> dict:
    for attempt in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as response:
                return json.loads(response.read().decode('utf-8', 'replace'))
        except Exception as error:
            if attempt == tries - 1:
                print(f'    あきらめます: {error}', file=sys.stderr)
                return {}
            time.sleep(wait * (attempt + 1))
    return {}


def normalise(name: str) -> str:
    """全角半角や中黒の違いを吸収して、名前を突き合わせる。"""
    text = str(name or '').strip()
    text = re.sub(r'[\s　]+', '', text)
    return text.replace('・', '').replace('･', '').lower()


# ---------------------------------------------------------------- FANZA

def fanza_floor_id(cred: dict) -> str:
    payload = fetch(f'{FANZA_BASE}/FloorList?' + urllib.parse.urlencode(
        dict(cred, output='json'))).get('result', {})

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


def fanza_genres(cred: dict, floor_id: str) -> dict:
    table = {}
    offset = 1

    while True:
        payload = fetch(f'{FANZA_BASE}/GenreSearch?' + urllib.parse.urlencode(
            dict(cred, output='json', floor_id=floor_id, hits=500, offset=offset)
        )).get('result', {})

        rows = payload.get('genre') or []
        if not rows:
            break

        for row in rows:
            name = (row.get('name') or '').strip()
            if name:
                table.setdefault(normalise(name), str(row.get('genre_id')))

        offset += 500
        if offset > int(payload.get('total_count') or 0):
            break
        time.sleep(0.5)

    return table


def fanza_count(cred: dict, genre_id: str) -> tuple[Counter, dict, dict, int, int]:
    counts, readings, ids, seen = Counter(), {}, {}, set()
    offset, total = 1, None

    while True:
        payload = fetch(f'{FANZA_BASE}/ItemList?' + urllib.parse.urlencode(dict(
            cred, output='json', site='FANZA', service='digital', floor='videoa',
            article='genre', article_id=genre_id, hits=100, offset=offset, sort='rank'
        ))).get('result', {})

        items = payload.get('items') or []
        if total is None:
            total = int(payload.get('total_count') or 0)
        if not items:
            break

        for item in items:
            key = item.get('content_id')
            if key in seen:
                continue
            seen.add(key)
            for person in (item.get('iteminfo') or {}).get('actress') or []:
                name = (person.get('name') or '').strip()
                if not name:
                    continue
                counts[name] += 1
                if person.get('ruby'):
                    readings.setdefault(name, person['ruby'])
                if person.get('id'):
                    ids.setdefault(name, str(person['id']))

        offset += 100
        if offset > min(total or 0, FANZA_MAX_OFFSET):
            break
        time.sleep(0.5)

    return counts, readings, ids, total or 0, len(seen)


# ---------------------------------------------------------------- DUGA

def duga_categories(cred: dict) -> dict:
    """カテゴリ一覧のAPIが無いので、作品を広く見て名前→ID を作る。"""
    table = {}
    offset = 1

    while offset <= DUGA_CATEGORY_SCAN:
        payload = fetch(f'{DUGA_API}?' + urllib.parse.urlencode(dict(
            cred, version='1.2', bannerid='01', format='json',
            hits=100, offset=offset, sort='favorite')))

        items = payload.get('items') or []
        if not items:
            break

        for wrapper in items:
            for category in (wrapper.get('item', {}).get('category') or []):
                data = category.get('data')
                rows = data if isinstance(data, list) else [data]
                for row in rows:
                    if isinstance(row, dict) and row.get('name'):
                        table.setdefault(normalise(row['name']), str(row.get('id')))

        offset += 100
        time.sleep(1.2)

    return table


def duga_count(cred: dict, category_id: str) -> tuple[Counter, int, int]:
    counts, seen = Counter(), set()
    offset, total = 1, None

    while True:
        payload = fetch(f'{DUGA_API}?' + urllib.parse.urlencode(dict(
            cred, version='1.2', bannerid='01', format='json',
            hits=100, offset=offset, category=category_id, sort='favorite')))

        items = payload.get('items') or []
        if total is None:
            total = int(payload.get('count') or 0)
        if not items:
            break

        for wrapper in items:
            item = wrapper.get('item', {})
            key = item.get('productid')
            if key in seen:
                continue
            seen.add(key)
            for performer in (item.get('performer') or []):
                data = performer.get('data')
                rows = data if isinstance(data, list) else [data]
                for row in rows:
                    if not isinstance(row, dict):
                        continue
                    name = (row.get('name') or '').strip()
                    if name:
                        counts[name] += 1

        offset += 100
        if offset > min(total or 0, SCAN_LIMIT):
            break
        time.sleep(1.2)

    return counts, total or 0, len(seen)


# ---------------------------------------------------------------- ソクミル

def sokmil_genres(cred: dict) -> dict:
    table = {}
    offset = 1

    while True:
        payload = fetch(f'{SOKMIL_BASE}/Genre?' + urllib.parse.urlencode(
            dict(cred, output='json', hits=100, offset=offset)), wait=20).get('result', {})

        rows = payload.get('genres') or []
        if not rows:
            break

        for row in rows:
            name = (row.get('name') or '').strip()
            if name:
                table.setdefault(normalise(name), str(row.get('id')))

        total = int(payload.get('total_count') or 0)
        offset += 100
        if offset > total:
            break
        time.sleep(1.5)

    return table


def sokmil_count(cred: dict, genre_id: str) -> tuple[Counter, dict, int, int]:
    counts, readings, seen = Counter(), {}, set()
    offset, total = 1, None

    while True:
        payload = fetch(f'{SOKMIL_BASE}/Item?' + urllib.parse.urlencode(dict(
            cred, output='json', hits=100, offset=offset,
            article='genre', article_id=genre_id)), wait=20).get('result', {})

        items = payload.get('items') or []
        if total is None:
            total = int(payload.get('total_count') or 0)
        if not items:
            break

        for item in items:
            key = item.get('id')
            if key in seen:
                continue
            seen.add(key)
            for person in (item.get('iteminfo') or {}).get('actor') or []:
                name = (person.get('name') or '').strip()
                if not name:
                    continue
                counts[name] += 1
                if person.get('ruby'):
                    readings.setdefault(name, person['ruby'])

        offset += 100
        if offset > min(total or 0, SCAN_LIMIT):
            break
        time.sleep(1.5)

    return counts, readings, total or 0, len(seen)


# ---------------------------------------------------------------- 本体

def look_up(table: dict, genre: dict, key: str) -> str:
    """その社での呼び方を、実在する名前の中から選ぶ。無ければ空。"""
    for candidate in [genre['name']] + list(genre.get(key) or []):
        found = table.get(normalise(candidate))
        if found:
            return found
    return ''


def write(output: Path, result: list) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sources': [
            {'key': 'fanza', 'label': 'FANZA アフィリエイト Web サービス（動画）',
             'url': 'https://affiliate.dmm.com/api/'},
            {'key': 'duga', 'label': 'DUGA アフィリエイト Web サービス',
             'url': 'https://affiliate.duga.jp/'},
            {'key': 'sokmil', 'label': 'ソクミルアフィリエイト WEBサービス',
             'url': 'https://sokmil-ad.com/'},
        ],
        'scanLimit': SCAN_LIMIT,
        'genres': result,
    }, ensure_ascii=False), encoding='utf-8')


def main() -> None:
    output = Path(sys.argv[1])

    fanza = {'api_id': os.environ.get('FANZA_API_ID'),
             'affiliate_id': os.environ.get('FANZA_AFFILIATE_ID')}
    duga = {'appid': os.environ.get('DUGA_APP_ID'),
            'agentid': os.environ.get('DUGA_AGENT_ID')}
    sokmil = {'api_key': os.environ.get('SOKMIL_API_KEY'),
              'affiliate_id': os.environ.get('SOKMIL_AFFILIATE_ID')}

    if not all(fanza.values()):
        raise SystemExit('環境変数 FANZA_API_ID と FANZA_AFFILIATE_ID が必要です。')

    floor_id = fanza_floor_id(fanza)
    fanza_table = fanza_genres(fanza, floor_id)
    print(f'FANZA のジャンル: {len(fanza_table):,}件（フロアID {floor_id}）', flush=True)

    duga_table = {}
    if all(duga.values()):
        duga_table = duga_categories(duga)
        print(f'DUGA のカテゴリ: {len(duga_table):,}件', flush=True)
    else:
        print('DUGA の認証情報が無いので、DUGA は数えません。', file=sys.stderr)

    sokmil_table = {}
    if all(sokmil.values()):
        sokmil_table = sokmil_genres(sokmil)
        print(f'ソクミルのジャンル: {len(sokmil_table):,}件', flush=True)
    else:
        print('ソクミルの認証情報が無いので、ソクミルは数えません。', file=sys.stderr)

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

        print(f"{genre['name']}:", flush=True)

        merged = Counter()
        per_source = {}
        readings, dmm_ids = {}, {}
        works, scanned = {}, {}

        fanza_id = look_up(fanza_table, genre, 'fanza')
        if fanza_id:
            counts, reads, ids, total, seen = fanza_count(fanza, fanza_id)
            per_source['fanza'] = counts
            readings.update(reads)
            dmm_ids.update(ids)
            works['fanza'], scanned['fanza'] = total, seen
            merged.update(counts)
            print(f'    FANZA  : 作品{total:,}件（{seen:,}件を確認）→ 出演者 {len(counts):,}人', flush=True)
        else:
            print('    FANZA  : ジャンル一覧に無いので飛ばします', flush=True)

        duga_id = look_up(duga_table, genre, 'duga') if duga_table else ''
        if duga_id:
            counts, total, seen = duga_count(duga, duga_id)
            per_source['duga'] = counts
            works['duga'], scanned['duga'] = total, seen
            merged.update(counts)
            print(f'    DUGA   : 作品{total:,}件（{seen:,}件を確認）→ 出演者 {len(counts):,}人', flush=True)
        elif duga_table:
            print('    DUGA   : カテゴリに無いので飛ばします', flush=True)

        sokmil_id = look_up(sokmil_table, genre, 'sokmil') if sokmil_table else ''
        if sokmil_id:
            counts, reads, total, seen = sokmil_count(sokmil, sokmil_id)
            per_source['sokmil'] = counts
            for name, ruby in reads.items():
                readings.setdefault(name, ruby)
            works['sokmil'], scanned['sokmil'] = total, seen
            merged.update(counts)
            print(f'    ソクミル: 作品{total:,}件（{seen:,}件を確認）→ 出演者 {len(counts):,}人', flush=True)
        elif sokmil_table:
            print('    ソクミル: ジャンルに無いので飛ばします', flush=True)

        if not merged:
            print('    どの社にも無かったので、このジャンルは作りません', flush=True)
            continue

        people = []
        for name, count in merged.most_common():
            row = {'name': name, 'works': count,
                   'reading': readings.get(name, ''), 'dmmId': dmm_ids.get(name, '')}
            for key in ('fanza', 'duga', 'sokmil'):
                n = per_source.get(key, {}).get(name, 0)
                if n:
                    row[key] = n
            people.append(row)

        result.append({
            'name': genre['name'],
            'slug': genre['slug'],
            'works': sum(works.values()),
            'worksBySource': works,
            'scannedBySource': scanned,
            'performers': people,
        })

        print(f"    合計   : 作品{sum(works.values()):,}件 → 出演者 {len(people):,}人", flush=True)

        write(output, result)   # ジャンルごとに書き出す。途中で止まっても残る。

    write(output, result)
    print()
    print(f'{len(result)}ジャンルを書き出しました → {output}')


main()
