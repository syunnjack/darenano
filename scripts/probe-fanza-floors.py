"""FANZA にどのフロアがあり、それぞれ何を返すかを見る。何も書き換えない。

darekore.jp はいま `digital / videoa`（動画）しか見ていない。
グラビア・同人へ広げられるかを判断するために、
フロアの一覧と、フロアごとの作品数・人の入り方を実測する。

環境変数: FANZA_API_ID / FANZA_AFFILIATE_ID
"""
import json
import os
import sys
import urllib.parse
import urllib.request

BASE = 'https://api.dmm.com/affiliate/v3'


def get(path: str, params: dict) -> dict:
    url = f'{BASE}/{path}?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode('utf-8', 'replace'))


def main() -> int:
    cred = {'api_id': os.environ['FANZA_API_ID'],
            'affiliate_id': os.environ['FANZA_AFFILIATE_ID'], 'output': 'json'}

    floors = get('FloorList', cred).get('result', {})
    print('=== フロア一覧 ===')
    targets = []

    for site in floors.get('site') or []:
        for service in site.get('service') or []:
            for floor in service.get('floor') or []:
                row = (site.get('name'), service.get('code'), floor.get('code'), floor.get('name'))
                print('  %-10s %-12s %-16s %s' % row)
                if floor.get('code') in ('videoa', 'idol', 'digital_doujin', 'videoc', 'anime', 'nikkatsu'):
                    targets.append((site.get('code') or site.get('name'), service.get('code'), floor.get('code')))

    print('\n=== フロアごとの中身 ===')
    for site_code, service, floor in targets:
        params = dict(cred, site=site_code, service=service, floor=floor, hits=1, offset=1, sort='date')
        try:
            result = get('ItemList', params).get('result', {})
        except Exception as error:
            print(f'  {service}/{floor}: 取れません（{error}）')
            continue

        items = result.get('items') or []
        total = result.get('total_count')
        info = (items[0].get('iteminfo') or {}) if items else {}
        keys = ', '.join(sorted(info))
        print(f'  {service}/{floor}: 作品 {total} 件')
        print(f'    iteminfo の中身: {keys}')
        if items:
            for key in ('actress', 'actor', 'author', 'maker', 'label', 'series', 'genre'):
                vals = info.get(key) or []
                if vals:
                    print(f'      {key}: ' + ' / '.join(str(v.get("name")) for v in vals[:3]))

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
