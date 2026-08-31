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
  PROBE         1 なら最初の1件をそのまま表示して終わる（応答の形を見るため）

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
WORKS_PER_ACTOR = 8
SAVE_EVERY = 5000        # 何件ごとに書き出すか

OUT_DIR = Path(__file__).resolve().parent.parent / 'data'


def call(cred: dict, offset: int) -> dict:
    params = dict(cred, output='json', hits=HITS, offset=offset)
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

    offset = int(state.get('nextOffset') or 1)
    scanned = int(state.get('scanned') or 0)
    total = None

    limit_minutes = float(os.environ.get('MAX_MINUTES', '300'))
    started = time.time()
    today = date.today()

    def save():
        state_path.write_text(json.dumps({
            'nextOffset': offset, 'scanned': scanned, 'confirmedOn': today.isoformat(),
        }, ensure_ascii=False), encoding='utf-8')
        works_path.write_text(json.dumps({
            'confirmedOn': today.isoformat(),
            'scanned': scanned,
            'source': 'ソクミルアフィリエイト WEBサービス（Item）',
            'worksPerActor': WORKS_PER_ACTOR,
            'actors': actors,
        }, ensure_ascii=False), encoding='utf-8')

    print(f'offset {offset} から取ります。', file=sys.stderr)
    since_save = 0

    while True:
        if (time.time() - started) / 60 >= limit_minutes:
            print(f'{limit_minutes}分を過ぎたので打ち切ります（次は offset {offset}）。', file=sys.stderr)
            break

        payload = call(cred, offset).get('result', {})

        if total is None:
            total = int(payload.get('total_count') or 0)
            print(f'  作品の総数 {total:,}', file=sys.stderr)

        items = payload.get('items') or []
        if not items:
            print('  これ以上ありません。', file=sys.stderr)
            break

        for item in items:
            cid = str(item.get('id') or '').strip()
            title = str(item.get('title') or '').strip()
            url = str(item.get('affiliateURL') or item.get('affiliateUrl') or '').strip()
            released = str(item.get('date') or item.get('release_date') or '')[:10]

            if not cid or not title or not url:
                continue

            scanned += 1
            work = {'c': cid, 't': title, 'd': released, 'u': url}

            for person in (item.get('iteminfo') or {}).get('actor') or []:
                ident = str(person.get('id') or '').strip()
                if ident:
                    keep_newest(actors.setdefault(ident, {'n': 0, 'w': []})['w'], work)
                    actors[ident]['n'] += 1

        offset += HITS
        since_save += HITS

        if since_save >= SAVE_EVERY:
            save()
            since_save = 0
            print(f'  offset {offset:,} / {total:,}  出演者 {len(actors):,}人', file=sys.stderr)

        if total and offset > total:
            break

        time.sleep(INTERVAL)

    save()
    print(f'\n作品 {scanned:,}件を見て、出演者 {len(actors):,}人にまとめました。', file=sys.stderr)

    return 0


if __name__ == '__main__':
    raise SystemExit(main())
