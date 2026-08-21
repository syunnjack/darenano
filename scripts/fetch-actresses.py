"""FANZA の ActressSearch API から、出演者データを全件取得する。

出典: FANZA アフィリエイト Web サービス（ActressSearch API）
      https://affiliate.dmm.com/api/

権利者が公開している項目だけを持つ。推測や補完はしない。

API ID とアフィリエイトIDは環境変数から読む。リポジトリには置かない。
  FANZA_API_ID / FANZA_AFFILIATE_ID

API は offset の上限が 50,000 なので、読み仮名の頭文字（initial）で
分割して取得する。頭文字が無い人は、分割なしの通しでも拾う。

使い方: FANZA_API_ID=xxx FANZA_AFFILIATE_ID=yyy python scripts/fetch-actresses.py public/data/actresses.json
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API = 'https://api.dmm.com/affiliate/v3/ActressSearch'
HITS = 100
SOURCE_LABEL = 'FANZA ActressSearch API'
SOURCE_URL = 'https://affiliate.dmm.com/api/'

INITIALS = list('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろわ')

# API が返す項目のうち、そのまま持つもの。
FIELDS = ('name', 'ruby', 'bust', 'waist', 'hip', 'height', 'birthday',
          'blood_type', 'hobby', 'prefectures')


def call(params: dict) -> dict:
    query = urllib.parse.urlencode(params)

    for attempt in range(5):
        try:
            with urllib.request.urlopen(f'{API}?{query}', timeout=60) as response:
                return json.loads(response.read().decode())
        except Exception as error:
            if attempt == 4:
                raise
            print(f'    再試行 {attempt + 1}/4: {error}', flush=True)
            time.sleep(3 * (attempt + 1))

    return {}


def page(credentials: dict, offset: int, initial: str | None) -> tuple[list, int]:
    params = dict(credentials, hits=HITS, offset=offset, output='json')

    if initial:
        params['initial'] = initial

    result = call(params).get('result', {})
    found = result.get('actress') or []

    return found, int(result.get('total_count') or 0)


def collect(credentials: dict, initial: str | None) -> dict[str, dict]:
    found: dict[str, dict] = {}
    offset = 1
    total = None

    while True:
        rows, total_count = page(credentials, offset, initial)

        if total is None:
            total = total_count

        if not rows:
            break

        for row in rows:
            if row.get('id'):
                found[str(row['id'])] = row

        offset += HITS

        # API の offset 上限。ここに当たったら、その頭文字は取り切れていない。
        if offset > 50000 or offset > (total or 0):
            break

        time.sleep(0.4)

    label = initial or '(頭文字なし)'
    short = 'すべて' if not initial else label
    print(f'  {short}: {len(found)}件 / 総数{total}', flush=True)

    return found


def normalise(row: dict) -> dict:
    record = {'dmmId': str(row['id'])}

    for field in FIELDS:
        value = row.get(field)
        if value not in (None, '', '----'):
            record[field] = value

    links = row.get('listURL') or {}
    if links.get('digital'):
        record['listUrl'] = links['digital']

    image = row.get('imageURL') or {}
    for size in ('large', 'small'):
        if image.get(size):
            record['image'] = image[size]
            break

    record['source'] = SOURCE_LABEL
    record['sourceUrl'] = SOURCE_URL

    return record


def main() -> None:
    output = Path(sys.argv[1])

    api_id = os.environ.get('FANZA_API_ID')
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID')

    if not api_id or not affiliate_id:
        raise SystemExit('環境変数 FANZA_API_ID と FANZA_AFFILIATE_ID が必要です。')

    credentials = {'api_id': api_id, 'affiliate_id': affiliate_id}

    rows: dict[str, dict] = {}

    print('頭文字ごとに取得します。')
    for initial in INITIALS:
        rows.update(collect(credentials, initial))

    print('頭文字の指定なしでも取得します（読み仮名が無い人のため）。')
    rows.update(collect(credentials, None))

    records = [normalise(row) for row in rows.values()]
    records.sort(key=lambda r: (r.get('ruby') or '\uffff', r['name']))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': SOURCE_LABEL,
        'sourceUrl': SOURCE_URL,
        'actresses': records,
    }, ensure_ascii=False), encoding='utf-8')

    def filled(field: str) -> int:
        return sum(1 for r in records if r.get(field))

    print()
    print(f'{len(records)}人を書き出しました → {output}')
    for field in ('ruby', 'birthday', 'prefectures', 'height', 'blood_type', 'hobby', 'image'):
        print(f'  {field}: {filled(field)}人')


main()
