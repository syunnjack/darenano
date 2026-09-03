"""FANZA の作品そのものを集める。出演者ページに載せる出演作品と、
シリーズ・レーベル別のページのもとになる。

出典: FANZA アフィリエイト Web サービス  https://affiliate.dmm.com/api/

これまで darekore.jp が FANZA へ出していたリンクは、出演者の一覧ページ
（video.dmm.co.jp/av/list/?actress=<id>）だけだった。作品そのもののURLを
1本も持っていないため、**アフィリエイトの「ダイレクト報酬」が構造的に
発生しない**（買われた作品と、こちらが出したリンクが結びつかない）。
このスクリプトは作品単位のURLを取ってくる。

## 取り方

出演者ごとに ItemList を叩くと 28,000 回を超える。代わりに
**発売月で区切って作品側から一度だけなめる**。作品には出演者が入っている
ので、1回のなめで全員ぶんが揃う。

  service=digital / floor=videoa / sort=date / gte_date・lte_date で月を指定

offset の上限は 50,000 なので、1か月が上限を超えることはまずないが、
超えた場合はその月を半分に割ってやり直す。

## 出力

全作品を持つと数百MBになるため、**なめながら畳む**。

  data/fanza-actress-works.json  出演者ごとの新しい作品 WORKS_PER_ACTRESS 本
  data/fanza-series.json         シリーズごとの本数と代表作
  data/fanza-labels.json         レーベルごとの本数と代表作
  data/fanza-newest.json         全体の新着 NEWEST 本

作品の画像URLとアフィリエイトURLは持たない。**content_id から組み立てられる**
ため、持つと出力が3倍になる。組み立て方は build-site.mjs 側に置く。

途中で止まっても次回が続きから取れるように、`state` に「次に取る月」を
書いて毎月ごとに保存する。MAX_MINUTES を過ぎたらそこで打ち切る。

認証は環境変数から読む。リポジトリには置かない。
  FANZA_API_ID / FANZA_AFFILIATE_ID
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  FROM_MONTH    取り直しの開始月（YYYY-MM。既定は前回の続き）
  RESET         1 なら前回の結果を捨てて最初から

使い方:
  FANZA_API_ID=xxx FANZA_AFFILIATE_ID=yyy python scripts/fetch-fanza-items.py
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

FANZA_BASE = 'https://api.dmm.com/affiliate/v3'
FANZA_MAX_OFFSET = 50000

# 出演者ページに並べる本数。増やすほど出力が大きくなる。
WORKS_PER_ACTRESS = 8
# シリーズ・レーベルのページに並べる本数
WORKS_PER_GROUP = 12
# 新着ページに並べる本数
NEWEST = 240
# シリーズ・レーベルのページに名前を並べる出演者の数
CAST_PER_GROUP = 40

# FANZA の動画は 1990年代から。これより前は作品がほぼ無い。
START_MONTH = '1998-01'

PAUSE = 0.4     # API を叩く間隔（秒）
OUT_DIR = Path(__file__).resolve().parent.parent / 'data'


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


def months(start: str, end: str) -> list[str]:
    """'1998-01' から '2026-09' までを月の並びにする。"""
    sy, sm = (int(x) for x in start.split('-'))
    ey, em = (int(x) for x in end.split('-'))
    out = []

    while (sy, sm) <= (ey, em):
        out.append(f'{sy:04d}-{sm:02d}')
        sm += 1
        if sm > 12:
            sy, sm = sy + 1, 1

    return out


def month_bounds(month: str) -> tuple[str, str]:
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


def scan_month(cred: dict, month: str) -> tuple[list[dict], int]:
    """その月に発売された作品をすべて取る。(作品, APIが言う総数)"""
    gte, lte = month_bounds(month)
    items, offset, total = [], 1, None

    while True:
        payload = fetch(f'{FANZA_BASE}/ItemList?' + urllib.parse.urlencode(dict(
            cred, output='json', site='FANZA', service='digital', floor='videoa',
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

        if offset > min(total or 0, FANZA_MAX_OFFSET):
            break

    return items, (total or 0)


def names(info: dict, key: str) -> list[tuple[str, str]]:
    """iteminfo の中の [{id, name}] を (id, name) の並びにする。"""
    out = []

    for entry in (info or {}).get(key) or []:
        ident, name = str(entry.get('id') or '').strip(), str(entry.get('name') or '').strip()
        if ident and name:
            out.append((ident, name))

    return out


def compact(item: dict) -> dict | None:
    """1作品を、持っておくぶんだけに削る。

    画像URLとアフィリエイトURLは content_id から組み立てられるので持たない。
    """
    cid = str(item.get('content_id') or '').strip()
    title = str(item.get('title') or '').strip()
    released = str(item.get('date') or '')[:10]

    if not cid or not title:
        return None

    return {'c': cid, 't': title, 'd': released}


def load_state(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def keep_newest(bucket: list[dict], work: dict, limit: int) -> None:
    """新しい順に limit 本だけ持つ。同じ作品は入れない。"""
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[limit:]


def add_cast(bucket: dict, cast: list[tuple[str, str]]) -> None:
    """シリーズ・レーベルに出ている人を数える。

    出演者IDだけを持ち、名前は出演者データ側から引く。**IDで引けない人は
    ページに出さない**（darekore.jp に無い人の名前だけを並べても行き先が無い）。
    """
    counts = bucket.setdefault('p', {})

    for ident, _ in cast:
        counts[ident] = counts.get(ident, 0) + 1


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    state_path = OUT_DIR / 'fanza-items-state.json'
    works_path = OUT_DIR / 'fanza-actress-works.json'
    series_path = OUT_DIR / 'fanza-series.json'
    labels_path = OUT_DIR / 'fanza-labels.json'
    newest_path = OUT_DIR / 'fanza-newest.json'

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load_state(state_path)

    actresses = {} if reset else load_state(works_path).get('actresses', {})
    series = {} if reset else load_state(series_path).get('series', {})
    labels = {} if reset else load_state(labels_path).get('labels', {})
    newest = [] if reset else load_state(newest_path).get('items', [])

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

    print(f'{todo[0]} から {todo[-1]} まで {len(todo)}か月ぶんを取ります。', file=sys.stderr)

    open_month = '' if reset else str(state.get('openMonth') or '')

    for month in todo:
        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので {month} の手前で切り上げます。', file=sys.stderr)
            break

        # 終わった月はもう二度となめないので、控えは要らない。
        if month == last_month:
            if open_month != month:
                forget_open_month(actresses, series, labels)
                open_month = month
        elif open_month:
            forget_open_month(actresses, series, labels)
            open_month = ''

        # 同じ月のなかで同じ作品が2回返ることがある（offset の境目など）。
        month_seen = set()

        items, total = scan_month(cred, month)
        scanned += len(items)

        for raw in items:
            work = compact(raw)
            if not work:
                continue

            info = raw.get('iteminfo') or {}
            cast = names(info, 'actress')

            cid = work['c']

            for ident, _ in cast:
                bucket = actresses.setdefault(ident, {'n': 0, 'w': []})
                keep_newest(bucket['w'], work, WORKS_PER_ACTRESS)
                if ('a', ident, cid) in month_seen:
                    continue
                month_seen.add(('a', ident, cid))
                if counted_twice(bucket, cid, open_month):
                    continue
                bucket['n'] += 1

            for ident, name in names(info, 'series'):
                bucket = series.setdefault(ident, {'name': name, 'n': 0, 'w': []})
                keep_newest(bucket['w'], work, WORKS_PER_GROUP)
                if ('s', ident, cid) in month_seen:
                    continue
                month_seen.add(('s', ident, cid))
                if counted_twice(bucket, cid, open_month):
                    continue
                bucket['n'] += 1
                add_cast(bucket, cast)

            for ident, name in names(info, 'label'):
                bucket = labels.setdefault(ident, {'name': name, 'n': 0, 'w': []})
                keep_newest(bucket['w'], work, WORKS_PER_GROUP)
                if ('l', ident, cid) in month_seen:
                    continue
                month_seen.add(('l', ident, cid))
                if counted_twice(bucket, cid, open_month):
                    continue
                bucket['n'] += 1
                add_cast(bucket, cast)

            keep_newest(newest, work, NEWEST)

        print(f'  {month}  {len(items):,}件 / APIの総数 {total:,}', file=sys.stderr)

        # 月ごとに書き出す。途中で止まっても、取れたぶんは残る。
        state = {
            'nextMonth': months(month, last_month)[1] if month != last_month else last_month,
            'openMonth': open_month,
            'scanned': scanned,
            'confirmedOn': today.isoformat(),
            'lastMonth': month,
        }
        state_path.write_text(json.dumps(state, ensure_ascii=False), encoding='utf-8')

    # 出演者は多いところで数千人になる。ページに並べるぶんだけ残す。
    for bucket in list(series.values()) + list(labels.values()):
        counts = bucket.get('p') or {}
        if len(counts) > CAST_PER_GROUP:
            top = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))[:CAST_PER_GROUP]
            bucket['p'] = dict(top)

    payload_head = {'confirmedOn': today.isoformat(), 'scanned': scanned,
                    'source': 'FANZA アフィリエイト Web サービス（ItemList）',
                    'worksPerActress': WORKS_PER_ACTRESS}

    works_path.write_text(json.dumps(dict(payload_head, actresses=actresses),
                                     ensure_ascii=False), encoding='utf-8')
    series_path.write_text(json.dumps(dict(payload_head, series=series),
                                      ensure_ascii=False), encoding='utf-8')
    labels_path.write_text(json.dumps(dict(payload_head, labels=labels),
                                      ensure_ascii=False), encoding='utf-8')
    newest_path.write_text(json.dumps(dict(payload_head, items=newest),
                                      ensure_ascii=False), encoding='utf-8')

    print(f'\n作品 {scanned:,}件を見て、出演者 {len(actresses):,}人 / '
          f'シリーズ {len(series):,} / レーベル {len(labels):,} にまとめました。', file=sys.stderr)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
