"""FANZA動画のジャンル別に、出演者ごとの出演本数を数える。

出典: FANZA アフィリエイト Web サービス（ItemList API・動画）
      https://affiliate.dmm.com/api/

ActressSearch はプロフィールしか返さないため、「どのジャンルの作品に
何本出ているか」は分からない。ItemList をジャンルで引くと、作品ごとの
出演者（actress）が入っているので、それを数える。

作品のタイトルは持たない。露骨な語を含むものが多いため。
数えるのは出演本数だけで、ジャンル名は FANZA の表記をそのまま使う。

API の offset 上限は50,000。ジャンル1つあたり最大500ページ。

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

API = 'https://api.dmm.com/affiliate/v3/ItemList'
HITS = 100
INTERVAL = 0.5
MAX_OFFSET = 50000

# 取り上げるジャンルと、URLに使う名前。
# FANZA のジャンル名をそのまま使い、独自の言い換えはしない。
GENRES = [
    {'id': 6958, 'name': 'バック', 'slug': 'back'},
    {'id': 6533, 'name': '巨乳', 'slug': 'kyonyu'},
    {'id': 4025, 'name': '痴女', 'slug': 'chijo'},
    {'id': 1027, 'name': '制服', 'slug': 'seifuku'},
    {'id': 5001, 'name': '中出し', 'slug': 'nakadashi'},
    {'id': 4111, 'name': '寝取り・寝取られ・NTR', 'slug': 'ntr'},
    {'id': 6548, 'name': 'コスプレ', 'slug': 'cosplay'},
]


def call(credentials: dict, genre_id: int, offset: int) -> dict:
    params = dict(credentials, output='json', site='FANZA', service='digital',
                  floor='videoa', article='genre', article_id=genre_id,
                  hits=HITS, offset=offset, sort='rank')
    query = urllib.parse.urlencode(params)

    for attempt in range(5):
        try:
            with urllib.request.urlopen(f'{API}?{query}', timeout=60) as response:
                return json.loads(response.read().decode())
        except Exception as error:
            if attempt == 4:
                raise
            print(f'    再試行 {attempt + 1}/4: {error}', file=sys.stderr)
            time.sleep(3 * (attempt + 1))

    return {}


def main() -> None:
    output = Path(sys.argv[1])

    api_id = os.environ.get('FANZA_API_ID')
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID')

    if not api_id or not affiliate_id:
        raise SystemExit('環境変数 FANZA_API_ID と FANZA_AFFILIATE_ID が必要です。')

    credentials = {'api_id': api_id, 'affiliate_id': affiliate_id}

    result = []

    for genre in GENRES:
        counts = Counter()
        readings = {}
        ids = {}
        seen = set()
        offset = 1
        total = None

        while True:
            payload = call(credentials, genre['id'], offset).get('result', {})
            items = payload.get('items') or []

            if total is None:
                total = int(payload.get('total_count') or 0)
                print(f"  {genre['name']}: {total:,}件", flush=True)

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

        people = [
            {'name': name, 'works': count,
             'reading': readings.get(name, ''), 'dmmId': ids.get(name, '')}
            for name, count in counts.most_common()
        ]

        result.append({
            'id': genre['id'],
            'name': genre['name'],
            'slug': genre['slug'],
            'works': total or 0,
            'scanned': len(seen),
            'performers': people,
        })

        print(f"    → 出演者 {len(people):,}人（{len(seen):,}作品を確認）", flush=True)

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': 'FANZA アフィリエイト Web サービス（動画）',
        'sourceUrl': 'https://affiliate.dmm.com/api/',
        'genres': result,
    }, ensure_ascii=False), encoding='utf-8')

    print()
    print(f'{len(result)}ジャンルを書き出しました → {output}')


main()
