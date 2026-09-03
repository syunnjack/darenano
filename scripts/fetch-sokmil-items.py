"""ソクミルの作品を集めて、出演者ごとの出演作品にする。

出典: ソクミルアフィリエイト WEBサービス  https://sokmil-ad.com/

これまで darekore.jp がソクミルへ出していたリンクは、**出演者のページ**
（sokmil.com/av/<名前>）1本だけだった。作品そのもののURLが無いため、
PPV も会員登録も、こちらのリンクとは結びつきにくい。
2026年8月の実績はクリック 323 に対して成果 0 件だった。

## 取り方

出演者ごとに叩くと 36,556 回。**作品側から一度なめれば済む**
（作品に出演者が入っている）。Item API は FANZA と同じ形。

  https://sokmil-ad.com/api/v1/Item?hits=100&offset=N

**offset には上限がある。** total_count は 229,953 と返ってくるのに、
offset 9,601 で items が空になる（2026-09-01 実測）。素直に offset を
進めるだけでは 9,600 件しか取れない。**FANZA と同じく発売月で区切る。**

  &gte_date=YYYY-MM-01&lte_date=（翌月の1日）

**連続で叩くと 403 を返す。** fetch-sokmil.py と同じく間隔を空け、
403 のときは長めに待つ。

## 出力

  data/sokmil-actor-works.json  出演者ごとの新しい作品 WORKS_PER_ACTOR 本

途中で止まっても次回が続きから取れるように、`state` に「次の offset」を
書いて一定件数ごとに保存する。MAX_MINUTES を過ぎたらそこで打ち切る。

環境変数:
  SOKMIL_API_KEY / SOKMIL_AFFILIATE_ID
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  RESET         1 なら前回の結果を捨てて最初から
  FROM_MONTH    取り直しの開始月（YYYY-MM。既定は前回の続き）
  PROBE         1 なら最初の1件をそのまま表示して終わる（応答の形を見るため）
  PROBE_MONTH   その月で絞ったときの総数と日付を表示して終わる（絞り込みが効くかの確認）

使い方:
  SOKMIL_API_KEY=xxx SOKMIL_AFFILIATE_ID=yyy python scripts/fetch-sokmil-items.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API = 'https://sokmil-ad.com/api/v1/Item'
HITS = 100
INTERVAL = 1.5
WORKS_PER_ACTOR = 6
# ソクミルの配信は2000年代から。これより前はほぼ無い。
START_MONTH = '2000-01'

OUT_DIR = Path(__file__).resolve().parent.parent / 'data'


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
    """**ここは翌月1日のままでよい。FANZA と同じに直してはいけない。**

    FANZA の `lte_date` は「以下」なので、翌月1日を渡すと1日発売の作品まで入り、
    前月と当月で二重に数えていた（2026-09-04 に4本を月末 23:59:59 に直した）。

    ソクミルは違う。上限未満の人 25,551 人のうち 1,680 人が1日発売の作品を
    持っているのに、**多く数えられている人は0人だった**（2026-09-04 実測）。
    こちらの `lte_date` は「未満」なので、月末で切ると月末発売の作品を落とす。
    """
    year, mon = (int(x) for x in month.split('-'))
    nxt_y, nxt_m = (year + 1, 1) if mon == 12 else (year, mon + 1)

    return f'{year:04d}-{mon:02d}-01', f'{nxt_y:04d}-{nxt_m:02d}-01'


def call(cred: dict, offset: int, month: str = '') -> dict:
    params = dict(cred, output='json', hits=HITS, offset=offset)

    if month:
        gte, lte = month_bounds(month)
        params['gte_date'] = gte
        params['lte_date'] = lte

    query = urllib.parse.urlencode(params)

    for attempt in range(5):
        try:
            with urllib.request.urlopen(f'{API}?{query}', timeout=60) as response:
                return json.loads(response.read().decode('utf-8', 'replace'))
        except urllib.error.HTTPError as error:
            if error.code == 403:
                wait = 60 * (attempt + 1)
                print(f'    403。{wait}秒待ちます。', file=sys.stderr)
                time.sleep(wait)
                continue
            print(f'    HTTP {error.code}', file=sys.stderr)
            time.sleep(5 * (attempt + 1))
        except Exception as error:
            print(f'    {error}', file=sys.stderr)
            time.sleep(5 * (attempt + 1))

    return {}


def counted_twice(bucket: dict, cid: str, open_month: str) -> bool:
    """**まだ終わっていない月は、次の回でもう一度なめる。**

    「次に取る月」は最後の月だけ進まない（その月の作品はまだ増えるため）。
    そのまま数えると走らせるたびに件数が増える。数えた作品IDを、その月の
    あいだだけ `r` に控えて2度目を飛ばす。月が変われば捨てる。
    """
    if not open_month:
        return False

    seen = bucket.setdefault('r', [])
    if cid in seen:
        return True

    seen.append(cid)
    return False


def forget_open_month(group: dict) -> None:
    for bucket in group.values():
        bucket.pop('r', None)


def load(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def keep_newest(bucket: list, work: dict) -> None:
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[WORKS_PER_ACTOR:]


def main() -> int:
    api_key = os.environ.get('SOKMIL_API_KEY', '').strip()
    affiliate_id = os.environ.get('SOKMIL_AFFILIATE_ID', '').strip()

    if not api_key or not affiliate_id:
        print('SOKMIL_API_KEY と SOKMIL_AFFILIATE_ID が要ります。', file=sys.stderr)
        return 1

    cred = {'api_key': api_key, 'affiliate_id': affiliate_id}
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 月で絞ったときに総数が変わるか（＝絞り込みが効くか）を見るためだけの入口。
    probe_month = os.environ.get('PROBE_MONTH', '').strip()
    if probe_month:
        payload = call(cred, 1, probe_month).get('result', {})
        items = payload.get('items') or []
        print(f'{probe_month} で絞ったときの total_count =', payload.get('total_count'), file=sys.stderr)
        print('  返ってきた日付:', [str(item.get('date'))[:10] for item in items[:5]], file=sys.stderr)
        return 0

    if os.environ.get('PROBE', '').strip() == '1':
        payload = call(cred, 1).get('result', {})
        print('total_count =', payload.get('total_count'), file=sys.stderr)
        items = payload.get('items') or []
        print(json.dumps(items[0] if items else {}, ensure_ascii=False, indent=2)[:3000])
        return 0

    works_path = OUT_DIR / 'sokmil-actor-works.json'
    state_path = OUT_DIR / 'sokmil-items-state.json'

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(state_path)
    actors = {} if reset else load(works_path).get('actors', {})

    scanned = int(state.get('scanned') or 0)

    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    today = date.today()
    last_month = f'{today.year:04d}-{today.month:02d}'
    from_month = os.environ.get('FROM_MONTH', '').strip() or state.get('nextMonth') or START_MONTH

    todo = months(from_month, last_month)
    if not todo:
        print('取る月がありません。', file=sys.stderr)
        return 0

    open_month = '' if reset else str(state.get('openMonth') or '')

    def save(next_month: str):
        state_path.write_text(json.dumps({
            'nextMonth': next_month, 'openMonth': open_month,
            'scanned': scanned, 'confirmedOn': today.isoformat(),
        }, ensure_ascii=False), encoding='utf-8')
        works_path.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'scanned': scanned,
            'source': 'ソクミルアフィリエイト WEBサービス（Item）',
            'worksPerActor': WORKS_PER_ACTOR,
            'actors': actors,
        }, ensure_ascii=False), encoding='utf-8')

    print(f'{todo[0]} から {todo[-1]} まで {len(todo)}か月ぶんを取ります。', file=sys.stderr)

    for month in todo:
        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので {month} の手前で切り上げます。', file=sys.stderr)
            save(month)
            break

        # 終わった月はもう二度となめないので、控えは要らない。
        if month == last_month:
            if open_month != month:
                forget_open_month(actors)
                open_month = month
        elif open_month:
            forget_open_month(actors)
            open_month = ''

        # 同じ月のなかで同じ作品が2回返ることがある（offset の境目など）。
        month_seen = set()
        offset, total, got = 1, None, 0

        while True:
            payload = call(cred, offset, month).get('result', {})

            if total is None:
                total = int(payload.get('total_count') or 0)

            items = payload.get('items') or []
            if not items:
                break

            for item in items:
                cid = str(item.get('id') or '').strip()
                title = str(item.get('title') or '').strip()
                # 作品ページのURLは category と id から組み立てられる。
                #   https://sokmil.com/<category>/_item/item<id>.htm
                # 紹介IDを付ける形は build-site.mjs 側に置く（そのぶん出力が軽い）。
                category = str(item.get('category') or '').strip()
                released = str(item.get('date') or item.get('release_date') or '')[:10]

                if not cid or not title or not category:
                    continue

                scanned += 1
                got += 1
                work = {'c': cid, 'g': category, 't': title, 'd': released}

                for person in (item.get('iteminfo') or {}).get('actor') or []:
                    ident = str(person.get('id') or '').strip()
                    if not ident:
                        continue

                    bucket = actors.setdefault(ident, {'n': 0, 'w': []})
                    keep_newest(bucket['w'], work)

                    if (ident, cid) in month_seen:
                        continue

                    month_seen.add((ident, cid))

                    if counted_twice(bucket, cid, open_month):
                        continue

                    bucket['n'] += 1

            offset += HITS
            if total and offset > total:
                break

            time.sleep(INTERVAL)

        print(f'  {month}  {got:,}件 / APIの総数 {total or 0:,}  出演者 {len(actors):,}人', file=sys.stderr)
        save(months(month, last_month)[1] if month != last_month else last_month)

    print(f'\n作品 {scanned:,}件を見て、出演者 {len(actors):,}人にまとめました。', file=sys.stderr)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
