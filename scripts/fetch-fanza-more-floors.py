"""出演者ページを厚くするため、FANZA の動画以外のフロアも集める。

出典: FANZA アフィリエイト Web サービス  https://affiliate.dmm.com/api/

## なぜ

出演者ページに出していたのは `digital/videoa`（動画）だけだった。
同じ女優が **DVD・見放題ch・写真集・成人映画** にも出ている。
出演者IDが共通なので、1ページに4種類を並べられる。

## フロアごとの違い（2026-09-02 実測）

品番から作品URLを組み立てられるかどうかが違う。**推測しない。**

  digital/videoa    video.dmm.co.jp/av/content/?id=<品番>              組み立て可
  mono/dvd          www.dmm.co.jp/mono/dvd/-/detail/=/cid=<品番>/       組み立て可
  monthly/premium   www.dmm.co.jp/monthly/premium/-/detail/=/cid=<品番>/ 組み立て可
  digital/nikkatsu  video.dmm.co.jp/cinema/content/?id=<品番>          組み立て可
  ebook/photo       book.dmm.co.jp/product/<別の数字>/<品番>/          **組み立て不可**

画像URLもフロアごとに置き場が違うため、**画像は持つ**。
写真集だけは作品URLも持つ。

## 出力を小さく保つ

**すでに darekore.jp にページがある出演者のぶんだけ**残す
（public/data/actresses.json の dmmId に無いIDは捨てる）。
フロアごとに WORKS_PER_FLOOR 本まで。

環境変数:
  FANZA_API_ID / FANZA_AFFILIATE_ID
  ONLY_FLOOR    フロアの key をカンマ区切りで（空なら全部）
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  RESET         1 なら前回の結果を捨てて最初から
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
WORKS_PER_FLOOR = 4
PAUSE = 0.4
START_MONTH = '2000-01'

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'fanza-actress-more.json'
STATE = ROOT / 'data' / 'fanza-more-state.json'
ACTRESSES = ROOT / 'public' / 'data' / 'actresses.json'

# key, service, floor, 画面に出す名前, URLを持つ必要があるか
FLOORS = [
    ('dvd', 'mono', 'dvd', 'DVD', False),
    ('monthly', 'monthly', 'premium', '見放題ch', False),
    ('photo', 'ebook', 'photo', '写真集', True),
    ('cinema', 'digital', 'nikkatsu', '成人映画', False),
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
    year, mon = (int(x) for x in month.split('-'))
    nxt_y, nxt_m = (year + 1, 1) if mon == 12 else (year, mon + 1)

    return f'{year:04d}-{mon:02d}-01T00:00:00', f'{nxt_y:04d}-{nxt_m:02d}-01T00:00:00'


def keep_newest(bucket: list, work: dict) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[WORKS_PER_FLOOR:]


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def known_actresses() -> set:
    """darekore.jp にページがある出演者のIDだけを残すために使う。"""
    data = load(ACTRESSES)
    rows = data.get('actresses') if isinstance(data, dict) else data
    ids = set()

    for row in rows or []:
        ident = str(row.get('id') or row.get('dmmId') or '').strip()
        if ident:
            ids.add(ident)

    return ids


def main() -> int:
    api_id = os.environ.get('FANZA_API_ID', '').strip()
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID', '').strip()

    if not api_id or not affiliate_id:
        print('FANZA_API_ID と FANZA_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_id': api_id, 'affiliate_id': affiliate_id, 'output': 'json', 'site': 'FANZA'}
    OUT.parent.mkdir(parents=True, exist_ok=True)

    valid = known_actresses()
    print(f'darekore にページがある出演者: {len(valid):,}人', file=sys.stderr)

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(STATE)
    actresses = {} if reset else load(OUT).get('actresses', {})

    only = [f.strip() for f in (os.environ.get('ONLY_FLOOR') or '').split(',') if f.strip()]
    floors = [f for f in FLOORS if not only or f[0] in only]

    today = date.today()
    last_month = f'{today.year:04d}-{today.month:02d}'
    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    scanned = int(state.get('scanned') or 0)

    def save(progress: dict) -> None:
        STATE.write_text(json.dumps(dict(progress, scanned=scanned,
                                         confirmedOn=today.isoformat()), ensure_ascii=False),
                         encoding='utf-8')
        OUT.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'scanned': scanned,
            'source': 'FANZA アフィリエイト Web サービス（ItemList）',
            'worksPerFloor': WORKS_PER_FLOOR,
            'floors': {key: label for key, _s, _f, label, _u in FLOORS},
            'actresses': actresses,
        }, ensure_ascii=False), encoding='utf-8')

    progress = dict(state.get('progress') or {})

    for key, service, floor, label, keep_url in floors:
        from_month = progress.get(key) or START_MONTH
        todo = months(from_month, last_month)
        print(f'\n=== {label}（{service}/{floor}）{todo[0]}〜{todo[-1]}', file=sys.stderr)

        for month in todo:
            if (time.time() - started) / 60 >= limit_minutes:
                print(f'{limit_minutes}分を過ぎたので {month} の手前で切り上げます。', file=sys.stderr)
                progress[key] = month
                save({'progress': progress})
                return 0

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

                    cast = [str(p.get('id') or '').strip()
                            for p in (raw.get('iteminfo') or {}).get('actress') or []]
                    cast = [c for c in cast if c and c in valid]
                    if not cast:
                        continue

                    scanned += 1
                    got += 1

                    images = raw.get('imageURL') or {}
                    work = {'c': cid, 't': title, 'd': str(raw.get('date') or '')[:10],
                            'i': images.get('list') or images.get('small') or ''}
                    # 品番から組み立てられないフロアだけ、URLを持つ
                    if keep_url:
                        work['u'] = str(raw.get('URL') or '')

                    for ident in cast:
                        bucket = actresses.setdefault(ident, {})
                        keep_newest(bucket.setdefault(key, []), work)

                offset += 100
                time.sleep(PAUSE)

                if offset > min(total or 0, MAX_OFFSET):
                    break

            print(f'  {month}  {got:,}件  出演者 {len(actresses):,}人', file=sys.stderr)
            progress[key] = months(month, last_month)[1] if month != last_month else last_month
            save({'progress': progress})

    print(f'\n作品 {scanned:,}件 → 出演者 {len(actresses):,}人', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
