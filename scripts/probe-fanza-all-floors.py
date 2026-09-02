"""FANZA の全フロアが何を返すかを測る。データは書き換えない。

darekore.jp は videoa（動画）・doujin（同人）・goods（おもちゃ）しか見ていない。
「FANZAの全サービスを軸にする」ために、**どのフロアに何が入っているか**を
先に実測する。推測で作ると、人が入らないフロアに名鑑を作ってしまう。

環境変数: FANZA_API_ID / FANZA_AFFILIATE_ID
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = 'https://api.dmm.com/affiliate/v3'

FLOORS = [
    ('digital', 'videoa', '動画'),
    ('digital', 'videoc', '素人'),
    ('digital', 'nikkatsu', '成人映画'),
    ('digital', 'anime', 'アニメ動画'),
    ('mono', 'dvd', 'DVD'),
    ('mono', 'goods', '大人のおもちゃ'),
    ('mono', 'anime', 'アニメ'),
    ('mono', 'pcgame', 'PCゲーム'),
    ('mono', 'book', 'ブック'),
    ('mono', 'figure', 'フィギュア'),
    ('pcgame', 'digital_pcgame', 'アダルトPCゲーム'),
    ('doujin', 'digital_doujin', '同人'),
    ('ebook', 'comic', 'コミック'),
    ('ebook', 'novel', '美少女ノベル'),
    ('ebook', 'photo', 'アダルト写真集'),
    ('monthly', 'premium', '見放題ch デラックス'),
]


def main() -> int:
    cred = {'api_id': os.environ['FANZA_API_ID'],
            'affiliate_id': os.environ['FANZA_AFFILIATE_ID'],
            'output': 'json', 'site': 'FANZA'}

    print('%-22s %9s  %s' % ('フロア', '件数', 'iteminfo に入るもの'))
    print('-' * 88)

    for service, floor, label in FLOORS:
        try:
            url = f'{BASE}/ItemList?' + urllib.parse.urlencode(
                dict(cred, service=service, floor=floor, hits=5, offset=1, sort='date'))
            with urllib.request.urlopen(url, timeout=60) as response:
                result = json.loads(response.read().decode('utf-8', 'replace')).get('result', {})
        except Exception as error:
            print('%-22s %9s  取れず %s' % (f'{service}/{floor}', '-', str(error)[:40]))
            time.sleep(1)
            continue

        items = result.get('items') or []
        total = result.get('total_count') or 0

        # 5件ぶん見て、入っているキーを集める（1件目が欠けている場合があるため）
        keys = set()
        people = set()
        for item in items:
            info = item.get('iteminfo') or {}
            keys.update(info.keys())
            for key in ('actress', 'actor', 'author', 'director', 'artist'):
                if info.get(key):
                    people.add(key)

        mark = '人あり:' + '/'.join(sorted(people)) if people else '人なし'
        print('%-22s %9s  %-44s %s' % (
            f'{service}/{floor}（{label}）', f'{total:,}', ', '.join(sorted(keys)), mark))
        time.sleep(1.2)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
