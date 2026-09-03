"""FANZA の「作者」を集める。出演者名鑑と並ぶ、もう1つの軸。

出典: FANZA アフィリエイト Web サービス  https://affiliate.dmm.com/api/

## なぜ作者か

コミック・ノベル・PCゲーム・ブックには `iteminfo.author`（作者）が入る
（2026-09-02 に全16フロアを実測）。**出演者名鑑と同じ作りで作者名鑑が作れる。**
DUGA・ソクミル・B10F・MGS はどれも持っていない領域なので、厚みとして大きい。

## フロアごとの違い（実測）

作品URLを品番から組み立てられるかが違う。**推測しない。**

  mono/pcgame           www.dmm.co.jp/mono/pcgame/-/detail/=/cid=<品番>/   組み立て可
  pcgame/digital_pcgame dlsoft.dmm.co.jp/detail/<品番>/                    組み立て可
  mono/book             www.dmm.co.jp/mono/book/-/detail/=/cid=<品番>/     組み立て可
  ebook/comic           book.dmm.co.jp/product/<別の数字>/<品番>/          **組み立て不可**
  ebook/novel           同上                                               **組み立て不可**

組み立てられないフロアは URL を持つ。画像はどのフロアも置き場が違うので持つ。

## 出力

  data/fanza-authors.json  作者ごとの作品（フロア別に WORKS_PER_FLOOR 本まで）

**1作品しか無い作者はページにしない**（build 側で切る）。数が多いので、
ここでは全部持ち、表示側で下限を決める。

環境変数:
  FANZA_API_ID / FANZA_AFFILIATE_ID
  ONLY_FLOOR    フロアの key をカンマ区切りで（空なら全部）
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  RESET         1 なら前回の結果を捨てて最初から
"""
import calendar
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
WORKS_PER_FLOOR = 6
PAUSE = 0.4
START_MONTH = '2005-01'

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'fanza-authors.json'
STATE = ROOT / 'data' / 'fanza-authors-state.json'

# key, service, floor, 画面に出す名前, URLを持つ必要があるか
FLOORS = [
    ('comic', 'ebook', 'comic', 'コミック', True),
    ('novel', 'ebook', 'novel', '美少女ノベル', True),
    ('pcgame', 'pcgame', 'digital_pcgame', 'アダルトPCゲーム', False),
    ('monopcgame', 'mono', 'pcgame', 'PCゲーム', False),
    ('book', 'mono', 'book', 'ブック', False),
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


def months(start: str, end: str) -> list:
    sy, sm = (int(x) for x in start.split('-'))
    ey, em = (int(x) for x in end.split('-'))
    out = []

    while (sy, sm) <= (ey, em):
        out.append(f'{sy:04d}-{sm:02d}')
        sm += 1
        if sm > 12:
            sy, sm = sy + 1, 1

    return out


def month_bounds(month: str) -> tuple:
    """**lte_date は「以下」なので、翌月1日を渡すとその日の作品まで入る。**

    翌月1日 00:00:00 を上限にしていたため、1日発売の作品が前月と当月の
    両方で返り、作品数が1件ずつ多くなっていた（2026-09-04 に gravure-meikan.jp で
    見つけて、こちらにも同じコードがあった）。月末の 23:59:59 で切る。

    **ソクミル（fetch-sokmil-items.py）の lte_date は「未満」で、こちらの
    バグは起きていない。**あちらを同じように直すと月末の作品を落とす。
    """
    year, mon = (int(x) for x in month.split('-'))
    last_day = calendar.monthrange(year, mon)[1]

    return f'{year:04d}-{mon:02d}-01T00:00:00', f'{year:04d}-{mon:02d}-{last_day:02d}T23:59:59'


def keep_newest(bucket: list, work: dict) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[WORKS_PER_FLOOR:]


def counted_twice(bucket: dict, key: str, cid: str, open_month: str) -> bool:
    """**まだ終わっていない月は、次の回でもう一度なめる。**

    「次に取る月」は最後の月だけ進まない（その月の作品はまだ増えるため）。
    そのため走らせるたびに同じ作品を数え直していて、件数が回を追うごとに
    増えていた。数えた作品IDを、そのフロアの開いている月のあいだだけ
    `r[フロア]` に控えて2度目を飛ばす。**フロアごとに進み方が違うので、
    控えもフロアごとに持つ。**
    """
    if not open_month:
        return False

    seen = bucket.setdefault('r', {}).setdefault(key, [])
    if cid in seen:
        return True

    seen.append(cid)
    return False


def forget_open_month(group: dict, key: str) -> None:
    for bucket in group.values():
        seen = bucket.get('r')
        if not seen:
            continue
        seen.pop(key, None)
        if not seen:
            bucket.pop('r', None)


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id, 'output': 'json', 'site': 'FANZA'}
    OUT.parent.mkdir(parents=True, exist_ok=True)

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(STATE)
    authors = {} if reset else load(OUT).get('authors', {})

    only = [f.strip() for f in (os.environ.get('ONLY_FLOOR') or '').split(',') if f.strip()]
    floors = [f for f in FLOORS if not only or f[0] in only]

    today = date.today()
    last_month = f'{today.year:04d}-{today.month:02d}'
    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    scanned = int(state.get('scanned') or 0)
    progress = dict(state.get('progress') or {})
    open_months = {} if reset else dict(state.get('openMonths') or {})

    def save() -> None:
        STATE.write_text(json.dumps({'progress': progress, 'openMonths': open_months,
                                     'scanned': scanned,
                                     'confirmedOn': today.isoformat()}, ensure_ascii=False),
                         encoding='utf-8')
        OUT.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'scanned': scanned,
            'source': 'FANZA アフィリエイト Web サービス（ItemList）',
            'worksPerFloor': WORKS_PER_FLOOR,
            'floors': {key: label for key, _s, _f, label, _u in FLOORS},
            'authors': authors,
        }, ensure_ascii=False), encoding='utf-8')

    for key, service, floor, label, keep_url in floors:
        from_month = progress.get(key) or START_MONTH
        todo = months(from_month, last_month)
        print(f'\n=== {label}（{service}/{floor}）{todo[0]}〜{todo[-1]}', file=sys.stderr)

        for month in todo:
            if (time.time() - started) / 60 >= limit_minutes:
                print(f'{limit_minutes}分を過ぎたので {month} の手前で切り上げます。', file=sys.stderr)
                progress[key] = month
                save()
                return 0

            # 終わった月はもう二度となめないので、控えは要らない。
            if month == last_month:
                if open_months.get(key) != month:
                    forget_open_month(authors, key)
                    open_months[key] = month
            elif open_months.get(key):
                forget_open_month(authors, key)
                open_months.pop(key, None)

            # 同じ月のなかで同じ作品が2回返ることがある（offset の境目など）。
            month_seen = set()

            gte, lte = month_bounds(month)
            offset, total, got = 1, None, 0

            while True:
                payload = fetch(f'{BASE}/ItemList?' + urllib.parse.urlencode(dict(
                    cred, service=service, floor=floor, hits=100, offset=offset,
                    sort='date', gte_date=gte, lte_date=lte))).get('result', {})

                if total is None:
                    total = int(payload.get('total_count') or 0)

                items = payload.get('items') or []
                if not items:
                    break

                for raw in items:
                    cid = str(raw.get('content_id') or '').strip()
                    title = str(raw.get('title') or '').strip()
                    if not cid or not title:
                        continue

                    info = raw.get('iteminfo') or {}
                    writers = [(str(a.get('id') or '').strip(), str(a.get('name') or '').strip())
                               for a in info.get('author') or []]
                    writers = [(i, n) for i, n in writers if i and n]
                    if not writers:
                        continue

                    scanned += 1
                    got += 1

                    images = raw.get('imageURL') or {}
                    work = {'c': cid, 't': title, 'd': str(raw.get('date') or '')[:10],
                            'i': images.get('list') or images.get('small') or ''}
                    if keep_url:
                        work['u'] = str(raw.get('URL') or '')

                    for ident, name in writers:
                        bucket = authors.setdefault(ident, {'name': name, 'n': 0, 'w': {}})
                        bucket['name'] = name
                        keep_newest(bucket['w'].setdefault(key, []), work)
                        if (ident, cid) in month_seen:
                            continue
                        month_seen.add((ident, cid))
                        if counted_twice(bucket, key, cid, open_months.get(key, '')):
                            continue
                        bucket['n'] += 1

                offset += 100
                time.sleep(PAUSE)

                if offset > min(total or 0, MAX_OFFSET):
                    break

            print(f'  {month}  {got:,}件  作者 {len(authors):,}人', file=sys.stderr)
            progress[key] = months(month, last_month)[1] if month != last_month else last_month
            save()

    print(f'\n作品 {scanned:,}件 → 作者 {len(authors):,}人', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
