"""DLsite の同人作品を集める。FANZA同人と並ぶ、もう1つの出典。

出典: DLsite（https://www.dlsite.com/）

## なぜ

サークル別ページ 17,599枚は**すべて FANZA同人だけ**で作っている。
同じサークルが DLsite にも出しているので、1ページを2社建てにできる。
FANZA に無いサークルは、DLsite 単独でページになる。

## 認証は要らない（2026-09-03 実測）

  一覧  /maniax/fsr/ajax/=/sex_category[0]/male/order[0]/dl_d/per_page/100/page/N/
        1ページに RJ番号が100件前後。page/3 まで確認済み
  作品  /maniax/product/info/ajax?product_id=RJ...,RJ...
        カンマ区切りでまとめ取り。30件投げて27件返った（無い番号は落ちる）
  サークル名  /maniax/circle/profile/=/maker_id/RG....html の title

**作品APIは maker_name を返さない**（null になる）ので、サークル名は
profile の題から取る。一度引いたら state に残し、同じサークルを何度も叩かない。

## 載せないもの

affiliate_deny が 0 以外の作品は**アフィリエイト禁止**なので捨てる。
規約違反になるうえ、リンクを置いても成果にならない。

## 出力

  data/dlsite-works.json  サークルごとの作品（WORKS_PER_CIRCLE 本まで）

環境変数:
  MAX_PAGES     一覧を何ページ見るか（既定 300 で約30,000作品）
  MAX_MINUTES   これを過ぎたら打ち切る（既定 300 分）
  RESET         1 なら前回の結果を捨てて最初から
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

BASE = 'https://www.dlsite.com/maniax'
LIST = (BASE + '/fsr/ajax/=/sex_category%5B0%5D/male/order%5B0%5D/dl_d'
        '/per_page/100/page/{page}/')
INFO = BASE + '/product/info/ajax?product_id={ids}'
PROFILE = BASE + '/circle/profile/=/maker_id/{maker}.html'

BATCH = 25
WORKS_PER_CIRCLE = 6
PAUSE = 0.6
AGENT = 'Mozilla/5.0 (compatible; darekore.jp/1.0)'

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'dlsite-works.json'
STATE = ROOT / 'data' / 'dlsite-state.json'


def get(url, tries=4, wait=3.0):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={'User-Agent': AGENT})
            with urllib.request.urlopen(request, timeout=45) as response:
                return response.read().decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return ''
            if attempt == tries - 1:
                print('    あきらめます(%s): %s' % (error.code, url[:70]), file=sys.stderr)
                return ''
        except Exception as error:
            if attempt == tries - 1:
                print('    あきらめます: %s' % error, file=sys.stderr)
                return ''
        time.sleep(wait * (attempt + 1))
    return ''


def load(path):
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return {}


def circle_name(maker):
    """サークル名。作品APIが maker_name を返さないので profile の題から取る。"""
    html = get(PROFILE.format(maker=maker))
    found = re.search(r'<title>([^<]*)</title>', html)
    if not found:
        return ''

    # 「ヤン豚（ヤンブタ） サークルプロフィール | 作品一覧...」から前半だけ取る
    name = found.group(1).split(' サークルプロフィール')[0].strip()
    return re.sub(r'（[^）]*）$', '', name).strip()


def keep_newest(bucket, work):
    if any(existing['c'] == work['c'] for existing in bucket):
        return

    bucket.append(work)
    bucket.sort(key=lambda w: (w['d'], w['c']), reverse=True)
    del bucket[WORKS_PER_CIRCLE:]


def main():
    OUT.parent.mkdir(parents=True, exist_ok=True)

    reset = os.environ.get('RESET', '').strip() == '1'
    state = {} if reset else load(STATE)
    stored = {} if reset else load(OUT)
    circles = stored.get('circles', {})
    names = dict(state.get('names') or {})
    seen = set(state.get('seen') or [])

    max_pages = int(os.environ.get('MAX_PAGES', '300'))
    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    scanned = int(state.get('scanned') or 0)
    denied = int(state.get('denied') or 0)
    today = date.today()

    def save(page):
        STATE.write_text(json.dumps({
            'page': page, 'scanned': scanned, 'denied': denied,
            'names': names, 'seen': sorted(seen),
            'confirmedOn': today.isoformat(),
        }, ensure_ascii=False), encoding='utf-8')
        OUT.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'scanned': scanned,
            'source': 'DLsite',
            'worksPerCircle': WORKS_PER_CIRCLE,
            'circles': circles,
        }, ensure_ascii=False), encoding='utf-8')

    start_page = int(state.get('page') or 1)
    print('%d ページ目から。すでに見た作品 %s件' % (start_page, format(len(seen), ',')),
          file=sys.stderr)

    for page in range(start_page, max_pages + 1):
        if (time.time() - started) / 60 >= limit_minutes:
            print('%s分を過ぎたので %d ページ目の手前で切り上げます。' % (limit_minutes, page),
                  file=sys.stderr)
            save(page)
            return 0

        html = get(LIST.format(page=page))

        if not html:
            print('  %d ページ目が取れませんでした。' % page, file=sys.stderr)
            save(page + 1)
            continue

        ids = [i for i in dict.fromkeys(re.findall(r'RJ\d{6,10}', html)) if i not in seen]
        got = 0

        for start in range(0, len(ids), BATCH):
            chunk = ids[start:start + BATCH]
            raw = get(INFO.format(ids=','.join(chunk)))
            time.sleep(PAUSE)

            try:
                items = json.loads(raw) if raw else {}
            except Exception:
                items = {}

            for cid, item in items.items():
                seen.add(cid)

                # アフィリエイト禁止の作品は載せない
                if str(item.get('affiliate_deny') or '0') != '0':
                    denied += 1
                    continue

                maker = str(item.get('maker_id') or '').strip()
                title = str(item.get('work_name') or '').strip()
                if not maker or not title:
                    continue

                if maker not in names:
                    names[maker] = circle_name(maker)
                    time.sleep(PAUSE)
                if not names[maker]:
                    continue

                image = str(item.get('work_image') or '')
                if image.startswith('//'):
                    image = 'https:' + image

                work = {
                    'c': cid,
                    't': title,
                    'd': str(item.get('regist_date') or '')[:10],
                    'i': image,
                    'p': item.get('price'),
                }

                bucket = circles.setdefault(maker, {'name': names[maker], 'n': 0, 'w': []})
                bucket['name'] = names[maker]
                bucket['n'] += 1
                keep_newest(bucket['w'], work)
                scanned += 1
                got += 1

        seen.update(ids)
        print('  %3dページ  %3d件  サークル %s  （禁止 %s件）'
              % (page, got, format(len(circles), ','), format(denied, ',')), file=sys.stderr)
        save(page + 1)

    print('\n作品 %s件 → サークル %s  アフィリエイト禁止で外した作品 %s件'
          % (format(scanned, ','), format(len(circles), ','), format(denied, ',')),
          file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
