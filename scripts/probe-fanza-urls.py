"""フロアごとに、作品ページのURLがどういう形かを測る。書き換えはしない。

品番から組み立てられるフロアと、組み立てられないフロアがある。
**組み立てられないものは URL を持つしかない**（出力が大きくなる）。
推測で組み立てると、リンク切れに気づけない。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

BASE = 'https://api.dmm.com/affiliate/v3'
FLOORS = [
    ('mono', 'pcgame', 'PCゲーム'),
    ('pcgame', 'digital_pcgame', 'アダルトPCゲーム'),
    ('ebook', 'comic', 'コミック'),
    ('ebook', 'novel', '美少女ノベル'),
    ('mono', 'book', 'ブック'),
    ('digital', 'videoc', '素人'),
    ('digital', 'anime', 'アニメ動画'),
    ('mono', 'figure', 'フィギュア'),
]


def main() -> int:
    cred = {'api_id': os.environ['FANZA_API_ID'],
            'affiliate_id': os.environ['FANZA_AFFILIATE_ID'],
            'output': 'json', 'site': 'FANZA'}

    for service, floor, label in FLOORS:
        url = f'{BASE}/ItemList?' + urllib.parse.urlencode(
            dict(cred, service=service, floor=floor, hits=1, offset=1, sort='date'))
        with urllib.request.urlopen(url, timeout=60) as response:
            items = (json.loads(response.read().decode('utf-8', 'replace'))
                     .get('result', {}).get('items') or [])

        if not items:
            print(f'{label}: 取れず')
            continue

        item = items[0]
        print(f'=== {service}/{floor}（{label}）')
        print(f'  content_id : {item.get("content_id")}')
        print(f'  product_id : {item.get("product_id")}')
        print(f'  URL        : {item.get("URL")}')
        print(f'  affiliate  : {str(item.get("affiliateURL"))[:110]}')
        images = item.get('imageURL') or {}
        print(f'  画像       : {str(images.get("list") or images.get("small"))[:100]}')
        info = item.get('iteminfo') or {}
        for key in ('author', 'actress', 'maker', 'genre', 'series'):
            vals = info.get(key) or []
            if vals:
                print(f'  {key:<10} : ' + ' / '.join(str(v.get("name"))[:18] for v in vals[:3]))
        time.sleep(1.2)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
