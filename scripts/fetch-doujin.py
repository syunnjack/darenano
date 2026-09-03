"""FANZA の同人を集める。

出典: FANZA アフィリエイト Web サービス（doujin / digital_doujin）
      https://affiliate.dmm.com/api/

## 出演者名鑑とは形が違う

`iteminfo` に入るのは **`genre` と `maker`（サークル）だけ**で、
人は入らない（2026-09-01 に実測）。出演者ページには出せないので、
**サークル別とジャンル別**のページにする。

## 取り方

offset の上限（50,000）を超えるので、**発売月で区切ってなめる**。
FANZA の動画と同じやり方。

## 載せない区分

未成年を思わせるもの・同意のないもの・近親相姦・排泄は、
[[darekore-genre-pages]] と B10F で決めた方針に揃えて外す。
**ページの題になる名前なので、ここは厳しくする。**

環境変数:
  FANZA_API_ID / FANZA_AFFILIATE_ID
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  FROM_MONTH    取り始める月（YYYY-MM。既定は前回の続き）
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
WORKS_PER_GROUP = 12
START_MONTH = '2010-01'
PAUSE = 0.4

# ページの題にしない語。名前にこれが入る区分・サークルは作らない。
BLOCKED = (
    'ロリ', '児童', '幼女', '小学', '中学生', 'JS', 'JC', 'JK', '女子校', '女子小',
    'レイプ', '強姦', '陵辱', 'monsterrape', '近親', '母子', '姉弟', '兄妹', '父娘',
    '排泄', 'スカトロ', '放尿', '浣腸', '脱糞', '食糞', '飲尿', 'ゲロ', '嘔吐',
    '獣姦', 'グロ', 'リョナ', '拷問', '鬼畜', '盗撮',
)

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / 'data'


def allowed(name: str) -> bool:
    return bool(name) and not any(word in name for word in BLOCKED)


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


def keep_newest(bucket: list, work: dict, limit: int) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[limit:]

def counted_twice(bucket: dict, cid: str, open_month: str) -> bool:
    """**まだ終わっていない月は、次の回でもう一度なめる。**

    「次に取る月」は最後の月だけ進まない（その月の作品はまだ増えるため）。
    そのため走らせるたびに同じ作品を数え直していて、件数が回を追うごとに
    増えていた。数えた作品IDをその月のあいだだけ `r` に控えて2度目を飛ばす。
    月が変われば捨てる（過去の月は二度となめない）。
    """
    if not open_month:
        return False

    seen = bucket.setdefault('r', [])
    if cid in seen:
        return True

    seen.append(cid)
    return False


def forget_open_month(*collections) -> None:
    for group in collections:
        for bucket in group.values():
            bucket.pop('r', None)



def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def scan_month(cred: dict, month: str) -> tuple:
    gte, lte = month_bounds(month)
    items, offset, total = [], 1, None

    while True:
        payload = fetch(f'{BASE}/ItemList?' + urllib.parse.urlencode(dict(
            cred, output='json', site='FANZA', service='doujin', floor='digital_doujin',
            hits=100, offset=offset, sort='date', gte_date=gte, lte_date=lte,
        ))).get('result', {})

        if total is None:
            total = int(payload.get('total_count') or 0)

        got = payload.get('items') or []
        if not got:
            break

        items.extend(got)
        offset += 100
        time.sleep(PAUSE)

        if offset > min(total or 0, MAX_OFFSET):
            break

    return items, (total or 0)


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    circles_path = OUT_DIR / 'doujin-circles.json'
    genres_path = OUT_DIR / 'doujin-genres.json'
    state_path = OUT_DIR / 'doujin-state.json'

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(state_path)
    circles = {} if reset else load(circles_path).get('circles', {})
    genres = {} if reset else load(genres_path).get('genres', {})

    today = date.today()
    last_month = f'{today.year:04d}-{today.month:02d}'
    from_month = os.environ.get('FROM_MONTH', '').strip() or state.get('nextMonth') or START_MONTH

    todo = months(from_month, last_month)
    if not todo:
        print('取る月がありません。', file=sys.stderr)
        return 0

    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    scanned = int(state.get('scanned') or 0)
    skipped = int(state.get('skipped') or 0)

    print(f'{todo[0]} から {todo[-1]} まで {len(todo)}か月ぶんを取ります。', file=sys.stderr)

    open_month = '' if reset else str(state.get('openMonth') or '')

    def save(next_month: str) -> None:
        head = {'confirmedOn': today.isoformat(), 'scanned': scanned, 'skipped': skipped,
                'source': 'FANZA アフィリエイト Web サービス（doujin / digital_doujin）'}
        state_path.write_text(json.dumps(dict(head, nextMonth=next_month, openMonth=open_month),
                                         ensure_ascii=False),
                              encoding='utf-8')
        circles_path.write_text(json.dumps(dict(head, circles=circles), ensure_ascii=False),
                                encoding='utf-8')
        genres_path.write_text(json.dumps(dict(head, genres=genres), ensure_ascii=False),
                               encoding='utf-8')

    for month in todo:
        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので {month} の手前で切り上げます。', file=sys.stderr)
            save(month)
            break

        # 終わった月はもう二度となめないので、控えは要らない。
        if month == last_month:
            if open_month != month:
                forget_open_month(circles, genres)
                open_month = month
        elif open_month:
            forget_open_month(circles, genres)
            open_month = ''

        # 同じ月のなかで同じ作品が2回返ることがある（offset の境目など）。
        month_seen = set()

        items, total = scan_month(cred, month)
        got = 0

        for raw in items:
            cid = str(raw.get('content_id') or '').strip()
            title = str(raw.get('title') or '').strip()
            url = str(raw.get('affiliateURL') or '').strip()

            if not cid or not title or not url:
                continue

            # **題名に載せない語が入っている作品は、丸ごと持たない。**
            if not allowed(title):
                skipped += 1
                continue

            images = raw.get('imageURL') or {}
            info = raw.get('iteminfo') or {}
            scanned += 1
            got += 1

            work = {'c': cid, 't': title, 'u': url,
                    'i': images.get('list') or images.get('small') or '',
                    'd': str(raw.get('date') or '')[:10]}

            for entry in info.get('maker') or []:
                ident = str(entry.get('id') or '').strip()
                name = str(entry.get('name') or '').strip()
                if not ident or not allowed(name):
                    continue
                bucket = circles.setdefault(ident, {'name': name, 'n': 0, 'w': []})
                keep_newest(bucket['w'], work, WORKS_PER_GROUP)
                if ('c', ident, cid) in month_seen:
                    continue
                month_seen.add(('c', ident, cid))
                if counted_twice(bucket, cid, open_month):
                    continue
                bucket['n'] += 1

            for entry in info.get('genre') or []:
                name = str(entry.get('name') or '').strip()
                ident = str(entry.get('id') or '').strip()
                if not ident or not allowed(name):
                    continue
                bucket = genres.setdefault(ident, {'name': name, 'n': 0, 'w': []})
                keep_newest(bucket['w'], work, WORKS_PER_GROUP)
                if ('g', ident, cid) in month_seen:
                    continue
                month_seen.add(('g', ident, cid))
                if counted_twice(bucket, cid, open_month):
                    continue
                bucket['n'] += 1

        print(f'  {month}  {got:,}件（除いた {skipped:,}）/ APIの総数 {total:,}  '
              f'サークル {len(circles):,} ジャンル {len(genres):,}', file=sys.stderr)
        save(months(month, last_month)[1] if month != last_month else last_month)

    print(f'\n作品 {scanned:,}件（載せないものを {skipped:,}件 除いた）→ '
          f'サークル {len(circles):,} / ジャンル {len(genres):,}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
