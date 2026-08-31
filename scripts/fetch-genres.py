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

aka は、世間で通っている別の言い方（スチュワーデス＝CA）。**集計には使わず、
ページに併記するだけ。** ジャンル名そのものは各社の表記から動かさない。

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
WORKS_PER_GENRE = 8           # ジャンルページに並べる FANZA の作品数
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
    {'name': 'キャンギャル', 'slug': 'cangal'},
    {'name': 'コンパニオン', 'slug': 'companion'},
    {'name': 'スチュワーデス', 'slug': 'stewardess', 'aka': ['CA', 'キャビンアテンダント']},
    {'name': '野外・露出', 'slug': 'roshutsu',
     'duga': ['露出'], 'sokmil': ['露出', '野外露出'], 'aka': ['露出']},
    {'name': 'スワッピング・夫婦交換', 'slug': 'swapping',
     'duga': ['スワッピング'], 'sokmil': ['スワッピング'], 'aka': ['スワッピング', '夫婦交換']},
    {'name': '顔射', 'slug': 'gansha'},
    {'name': '巨尻', 'slug': 'kyojiri', 'aka': ['美尻', 'デカ尻']},
    {'name': '4K', 'slug': '4k'},
    {'name': 'VR専用', 'slug': 'vr', 'aka': ['VR', 'アダルトVR']},
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
    # ここから 2026-09-01 に追加。FANZA のジャンル一覧（332件）に実在するものだけ。
    # 未成年を思わせるもの・同意のないもの・近親相姦・排泄は入れない
    # （既存の EXPLICIT / B10F の方針と揃える）。
    {'name': 'ギャル', 'slug': 'gyaru'},
    {'name': '美乳', 'slug': 'binyu'},
    {'name': '貧乳・微乳', 'slug': 'hinnyu', 'duga': ['貧乳'], 'sokmil': ['貧乳']},
    {'name': '母乳', 'slug': 'bonyu'},
    {'name': 'パイパン', 'slug': 'paipan'},
    {'name': 'めがね', 'slug': 'megane', 'aka': ['メガネ', '眼鏡']},
    {'name': '女教師', 'slug': 'jokyoshi'},
    {'name': '女医', 'slug': 'joi'},
    {'name': '女子アナ', 'slug': 'joshi-ana'},
    {'name': '秘書', 'slug': 'hisho'},
    {'name': '家庭教師', 'slug': 'kateikyoshi'},
    {'name': 'セーラー服', 'slug': 'sailor'},
    {'name': '体操着・ブルマ', 'slug': 'bloomer', 'duga': ['ブルマ'], 'sokmil': ['ブルマ'], 'aka': ['ブルマ']},
    {'name': 'チアガール', 'slug': 'cheergirl'},
    {'name': 'バニーガール', 'slug': 'bunnygirl'},
    {'name': 'チャイナドレス', 'slug': 'chinadress'},
    {'name': 'レオタード', 'slug': 'leotard'},
    {'name': 'ランジェリー', 'slug': 'lingerie'},
    {'name': 'パンスト・タイツ', 'slug': 'pansuto', 'duga': ['パンスト'], 'sokmil': ['パンスト'], 'aka': ['パンスト', 'タイツ']},
    {'name': '和服・浴衣', 'slug': 'wafuku', 'duga': ['浴衣'], 'sokmil': ['浴衣'], 'aka': ['浴衣', '着物']},
    {'name': '裸エプロン', 'slug': 'hadaka-apron'},
    {'name': 'ナンパ', 'slug': 'nanpa'},
    {'name': '温泉', 'slug': 'onsen'},
    {'name': 'お風呂', 'slug': 'ofuro'},
    {'name': 'ホテル', 'slug': 'hotel'},
    {'name': 'エステ', 'slug': 'este'},
    {'name': '不倫', 'slug': 'furin'},
    {'name': '未亡人', 'slug': 'miboujin'},
    {'name': '妊婦', 'slug': 'ninpu'},
    {'name': 'ハーレム', 'slug': 'harem'},
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


def fanza_count(cred: dict, genre_id: str) -> tuple[Counter, dict, dict, int, int, str, list]:
    counts, readings, ids, seen = Counter(), {}, {}, set()
    offset, total = 1, None
    top = ''   # 人気順1位の作品。ジャンル一覧のURLをAPIが返さないため、代わりに使う。
    # ジャンルページに並べる作品。**人気順に見ているので、先頭から取れば人気上位**。
    # これまでジャンルページには作品単位のリンクが「人気1位」の1本しか無かった。
    picks = []

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
            if not top:
                top = item.get('affiliateURL') or ''

            if len(picks) < WORKS_PER_GENRE:
                cid = str(item.get('content_id') or '').strip()
                title = str(item.get('title') or '').strip()
                if cid and title:
                    picks.append({'c': cid, 't': title, 'd': str(item.get('date') or '')[:10]})
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

    return counts, readings, ids, total or 0, len(seen), top, picks


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


def duga_count(cred: dict, category_id: str) -> tuple[Counter, int, int, str]:
    counts, seen = Counter(), set()
    offset, total = 1, None
    top = ''

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
            if not top:
                top = item.get('affiliateurl') or ''
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

    return counts, total or 0, len(seen), top


# ---------------------------------------------------------------- ソクミル

def sokmil_genres(cred: dict) -> tuple[dict, dict]:
    table = {}
    urls = {}          # ジャンルID → アフィリエイトURL（APIが返す一覧ページ）
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
            if row.get('affiliateURL'):
                urls.setdefault(str(row.get('id')), row['affiliateURL'])

        total = int(payload.get('total_count') or 0)
        offset += 100
        if offset > total:
            break
        time.sleep(1.5)

    return table, urls


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


# ------------------------------------------------- 行き先だけを取る（1ページ）

def fanza_top_url(cred: dict, genre_id: str) -> str:
    """人気順1位の作品のアフィリエイトURL。1ページ読むだけで済む。"""
    payload = fetch(f'{FANZA_BASE}/ItemList?' + urllib.parse.urlencode(dict(
        cred, output='json', site='FANZA', service='digital', floor='videoa',
        article='genre', article_id=genre_id, hits=1, offset=1, sort='rank'
    ))).get('result', {})
    items = payload.get('items') or []
    return (items[0].get('affiliateURL') or '') if items else ''


def duga_top_url(cred: dict, category_id: str) -> str:
    payload = fetch(f'{DUGA_API}?' + urllib.parse.urlencode(dict(
        cred, version='1.2', bannerid='01', format='json',
        hits=1, offset=1, category=category_id, sort='favorite')))
    items = payload.get('items') or []
    if not items:
        return ''
    return items[0].get('item', {}).get('affiliateurl') or ''


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

    sokmil_table, sokmil_urls = {}, {}
    if all(sokmil.values()):
        sokmil_table, sokmil_urls = sokmil_genres(sokmil)
        print(f'ソクミルのジャンル: {len(sokmil_table):,}件', flush=True)
    else:
        print('ソクミルの認証情報が無いので、ソクミルは数えません。', file=sys.stderr)

    only = {s.strip() for s in (os.environ.get('ONLY') or '').split(',') if s.strip()}

    # LINKS_ONLY=1 のときは、集計をやり直さず**各社への行き先だけ**を足す。
    # 出演者を数え直すのに1ジャンル10分かかるが、リンクに要るのは
    # 人気順1位の作品のURLだけなので、1ページ読めば済む。
    links_only = os.environ.get('LINKS_ONLY') == '1'
    previous = {}

    if (only or links_only) and output.exists():
        try:
            for row in json.loads(output.read_text(encoding='utf-8')).get('genres', []):
                previous[row['slug']] = row
            print(f'前回の結果を引き継ぎます: {len(previous)}ジャンル', flush=True)
        except Exception as error:
            print(f'前回の結果を読めませんでした（全部取り直します）: {error}', file=sys.stderr)
            only = set()

    result = []

    if links_only:
        if not previous:
            raise SystemExit('LINKS_ONLY には前回の結果が必要です。')

        for genre in GENRES:
            row = previous.get(genre['slug'])
            if not row:
                continue

            if row.get('links'):
                result.append(row)
                continue

            links = {}

            fanza_id = look_up(fanza_table, genre, 'fanza')
            if fanza_id:
                url = fanza_top_url(fanza, fanza_id)
                if url:
                    links['fanza'] = url

            duga_id = look_up(duga_table, genre, 'duga') if duga_table else ''
            if duga_id:
                url = duga_top_url(duga, duga_id)
                if url:
                    links['duga'] = url

            sokmil_id = look_up(sokmil_table, genre, 'sokmil') if sokmil_table else ''
            if sokmil_id and sokmil_urls.get(sokmil_id):
                links['sokmil'] = sokmil_urls[sokmil_id]

            if links:
                row['links'] = links

            result.append(row)
            print(f"{genre['name']}: 行き先 {len(links)}件", flush=True)
            write(output, result)
            time.sleep(1.2)

        write(output, result)
        print()
        print(f'{len(result)}ジャンルに行き先を足しました → {output}')
        return

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
        fanza_top = duga_top = ''
        fanza_picks = []

        fanza_id = look_up(fanza_table, genre, 'fanza')
        if fanza_id:
            counts, reads, ids, total, seen, fanza_top, fanza_picks = fanza_count(fanza, fanza_id)
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
            counts, total, seen, duga_top = duga_count(duga, duga_id)
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

        entry = {
            'name': genre['name'],
            'slug': genre['slug'],
            # 各社への行き先。**APIが返したURLだけ**を使う。
            # FANZAとDUGAはジャンル一覧のURLを返さないので、人気順1位の作品へ送る。
            # ソクミルはジャンル一覧のURLを返すので、そのまま使う。
            'links': {k: v for k, v in (
                ('fanza', fanza_top),
                ('duga', duga_top),
                ('sokmil', sokmil_urls.get(sokmil_id, '') if sokmil_id else ''),
            ) if v},
            'works': sum(works.values()),
            'worksBySource': works,
            'scannedBySource': scanned,
            # FANZA の人気順の上位作品。ジャンルページに表紙つきで並べる。
            'fanzaWorks': fanza_picks,
            'performers': people,
        }
        if genre.get('aka'):
            entry['aka'] = list(genre['aka'])
        result.append(entry)

        print(f"    合計   : 作品{sum(works.values()):,}件 → 出演者 {len(people):,}人", flush=True)

        write(output, result)   # ジャンルごとに書き出す。途中で止まっても残る。

    write(output, result)
    print()
    print(f'{len(result)}ジャンルを書き出しました → {output}')


main()
