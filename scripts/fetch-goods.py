"""FANZA の大人のおもちゃを集める。

出典: FANZA アフィリエイト Web サービス（mono / goods）
      https://affiliate.dmm.com/api/

## なぜ足すか

グッズは**報酬率が高く、買い切り**なので成果につながりやすい。
ただし `iteminfo` に入るのは `maker` だけで、ジャンルもカテゴリも入らない
（2026-09-01 に実測）。人も入らないので、出演者ページには出せない。

そこで2通りに使う。

  1. **既存のジャンルページに、その語で引いた商品を出す。**
     「ローター」「電マ」「おもちゃ」などのジャンルを見ている人には
     いちばん近い商品になる。keyword 検索で引ける
  2. メーカー別のページ

## 取り方

全部で 21,027 件。offset の上限（50,000）より少ないので、
**日付で区切らずそのまま offset を進めればよい**。

環境変数:
  FANZA_API_ID / FANZA_AFFILIATE_ID
  GENRES_FILE   ジャンル名を読む先（既定 public/data/genres.json）

使い方: python scripts/fetch-goods.py
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

BASE = 'https://api.dmm.com/affiliate/v3'
MAX_OFFSET = 50000
WORKS_PER_MAKER = 12
WORKS_PER_GENRE = 8
# ジャンルページに出す下限。これ未満なら誤爆の可能性が高いので出さない
MIN_PER_GENRE = 3
NEWEST = 60
PAUSE = 0.4

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / 'data' / 'fanza-goods.json'


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


def compact(item: dict) -> dict | None:
    """1商品を、持っておくぶんだけに削る。

    グッズの画像URLは品番から組み立てられないので、APIが返したものを持つ。
    """
    cid = str(item.get('content_id') or '').strip()
    title = str(item.get('title') or '').strip()
    url = str(item.get('affiliateURL') or '').strip()

    if not cid or not title or not url:
        return None

    images = item.get('imageURL') or {}
    price = ''
    prices = item.get('prices') or {}
    if prices.get('price'):
        price = str(prices['price'])

    return {'c': cid, 't': title, 'u': url,
            'i': images.get('list') or images.get('small') or '',
            'd': str(item.get('date') or '')[:10], 'p': price}


def keep_newest(bucket: list, item: dict, limit: int) -> None:
    if any(existing['c'] == item['c'] for existing in bucket):
        return

    bucket.append(item)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[limit:]


def sweep(cred: dict) -> tuple[dict, list, int]:
    """全商品をなめて、メーカーごとに畳む。"""
    makers, newest = {}, []
    offset, total, scanned = 1, None, 0

    while True:
        payload = fetch(f'{BASE}/ItemList?' + urllib.parse.urlencode(dict(
            cred, output='json', site='FANZA', service='mono', floor='goods',
            hits=100, offset=offset, sort='date'))).get('result', {})

        if total is None:
            total = int(payload.get('total_count') or 0)
            print(f'  商品の総数 {total:,}', file=sys.stderr)

        items = payload.get('items') or []
        if not items:
            break

        for raw in items:
            good = compact(raw)
            if not good:
                continue

            scanned += 1
            keep_newest(newest, good, NEWEST)

            for entry in (raw.get('iteminfo') or {}).get('maker') or []:
                ident = str(entry.get('id') or '').strip()
                name = str(entry.get('name') or '').strip()
                if not ident or not name:
                    continue
                bucket = makers.setdefault(ident, {'name': name, 'n': 0, 'w': []})
                bucket['n'] += 1
                keep_newest(bucket['w'], good, WORKS_PER_MAKER)

        offset += 100
        if offset > min(total or 0, MAX_OFFSET):
            break
        time.sleep(PAUSE)

    return makers, newest, scanned


def searchable(name: str) -> bool:
    """キーワード検索に使ってよい名前か。

    **keyword は本文にも当たる。**「OL」で引くと COOL や OIL の一部に
    当たって「速乾スティック」が1位に出た（2026-09-01 実測）。
    英数字だけの名前と、2文字未満の名前は使わない。
    """
    if len(name) < 3 and name.isascii():
        return False
    return not name.isascii()


def by_genre(cred: dict, names: list) -> dict:
    """ジャンル名で商品を引く。**分類ではなく語で引いているだけ**なので、
    題名にその語が入っているものだけを残す。ページにもその旨を書くこと。"""
    found = {}

    for name in names:
        if not searchable(name):
            print(f'  {name}: 語が短い／英数字なので引かない', file=sys.stderr)
            continue

        payload = fetch(f'{BASE}/ItemList?' + urllib.parse.urlencode(dict(
            cred, output='json', site='FANZA', service='mono', floor='goods',
            keyword=name, hits=60, offset=1, sort='rank'))).get('result', {})

        items = [compact(raw) for raw in (payload.get('items') or [])]
        # **題名にその語が入っているものだけ**にする。本文への誤爆を落とす。
        items = [item for item in items if item and name in item['t']]

        if len(items) >= MIN_PER_GENRE:
            found[name] = {'n': len(items), 'w': items[:WORKS_PER_GENRE],
                           'hits': int(payload.get('total_count') or 0)}
            print(f'  {name}: 題名に入っていたもの {len(items)}件'
                  f'（検索の当たりは {payload.get("total_count")}件）', file=sys.stderr)
        else:
            print(f'  {name}: 題名に入っていたものが {len(items)}件しかないので出さない',
                  file=sys.stderr)

        time.sleep(PAUSE)

    return found


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id}

    print('大人のおもちゃを全部なめます。', file=sys.stderr)
    makers, newest, scanned = sweep(cred)

    genres_file = Path(os.environ.get('GENRES_FILE')
                       or ROOT / 'public' / 'data' / 'genres.json')
    names = []
    if genres_file.exists():
        data = json.loads(genres_file.read_text(encoding='utf-8'))
        names = [g['name'] for g in data.get('genres', [])]

    print(f'\nジャンル {len(names)}件の語で商品を引きます。', file=sys.stderr)
    genres = by_genre(cred, names) if names else {}

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'source': 'FANZA アフィリエイト Web サービス（mono / goods）',
        'scanned': scanned,
        'makers': makers,
        'byGenre': genres,
        'newest': newest,
    }, ensure_ascii=False), encoding='utf-8')

    print(f'\n商品 {scanned:,}件 / メーカー {len(makers):,} / '
          f'ジャンルで引けた {len(genres)}件', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
