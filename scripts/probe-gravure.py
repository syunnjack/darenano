"""一般（DMM.com）側で、グラビアの人と作品が取れるかを見る。何も書き換えない。

darekore.jp は FANZA（アダルト）しか見ていない。グラビア・モデルの
名鑑を別サイトで作れるかを判断するために、
写真集・DVD・LOD の3フロアで「人が入るか」「日付で絞れるか」を実測する。

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


def show(cred: dict, label: str, params: dict, count: int = 3) -> None:
    try:
        result = get('ItemList', dict(cred, **params, hits=count, offset=1)).get('result', {})
    except Exception as error:
        print(f'{label}: 取れません（{error}）')
        return

    items = result.get('items') or []
    print(f'{label}: 総数 {result.get("total_count")}')

    for item in items:
        info = item.get('iteminfo') or {}
        people = []
        for key in ('actress', 'actor', 'author'):
            for entry in info.get(key) or []:
                people.append(f'{key}:{entry.get("name")}')
        print(f'  {str(item.get("date"))[:10]}  {str(item.get("title"))[:44]}')
        joined = ' / '.join(people) if people else '（人が入っていない）'
        print(f'     {joined}')
        print(f'     genre: {" / ".join(str(g.get("name")) for g in (info.get("genre") or [])[:4])}')


def main() -> int:
    cred = {'api_id': os.environ['FANZA_API_ID'],
            'affiliate_id': os.environ['FANZA_AFFILIATE_ID'], 'output': 'json'}

    print('=== 写真集（DMM.com 一般 ebook/photo）===')
    show(cred, '  全体', {'site': 'DMM.com', 'service': 'ebook', 'floor': 'photo', 'sort': 'date'})

    print('\n=== DVD（DMM.com 一般 mono/dvd）をキーワードで絞る ===')
    for word in ('グラビア', 'イメージ'):
        show(cred, f'  keyword={word}', {'site': 'DMM.com', 'service': 'mono', 'floor': 'dvd',
                                         'keyword': word, 'sort': 'date'}, 2)

    print('\n=== 日付で絞れるか（写真集を1か月に限定）===')
    show(cred, '  2026-08', {'site': 'DMM.com', 'service': 'ebook', 'floor': 'photo',
                             'gte_date': '2026-08-01T00:00:00', 'lte_date': '2026-09-01T00:00:00',
                             'sort': 'date'}, 2)

    print('\n=== 出演者検索が一般側で使えるか ===')
    for site in ('DMM.com', 'FANZA'):
        try:
            r = get('ActressSearch', dict(cred, site=site, hits=1)).get('result', {})
            print(f'  {site}: 総数 {r.get("total_count")}')
        except Exception as error:
            print(f'  {site}: 使えません（{error}）')

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
