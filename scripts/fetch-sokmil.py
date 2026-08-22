"""ソクミルの出演者検索APIから、出演者の情報を取る。

出典: ソクミルアフィリエイト WEBサービス
      https://sokmil-ad.com/

FANZA・DUGA に次ぐ3社目の出典。FANZA とほぼ同じ項目が揃っていて、
**カップ数は FANZA に無い項目**。

エンドポイント名に注意。説明書は「出演者検索API」だが、
パスは `Actress` ではなく **`Actor`**（`Actress` は404）。

  https://sokmil-ad.com/api/v1/Actor?api_key=...&affiliate_id=...

クレジット表示が義務。使う側のページに、指定のHTMLをそのまま出すこと。

**連続で叩くと 403 を返してくる。** 制限値は公表されていないが、
0.4秒間隔で100件ずつ取ると数十回で遮断された。1.5秒空け、
403 のときは長めに待ってから続きを試す。

認証は環境変数から読む。リポジトリには置かない。
  SOKMIL_API_KEY / SOKMIL_AFFILIATE_ID

使い方:
  SOKMIL_API_KEY=xxx SOKMIL_AFFILIATE_ID=yyy \
    python scripts/fetch-sokmil.py public/data/sokmil.json
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API = 'https://sokmil-ad.com/api/v1/Actor'
HITS = 100
INTERVAL = 1.5
SOURCE_LABEL = 'ソクミルアフィリエイト WEBサービス'
SOURCE_URL = 'https://sokmil-ad.com/'

# そのまま持つ項目。値が空のものは落とす。
FIELDS = ('name', 'ruby', 'gender', 'bust', 'cup', 'waist', 'hip',
          'height', 'birthday', 'blood_type', 'prefectures')


def call(credentials: dict, offset: int) -> dict:
    params = dict(credentials, output='json', hits=HITS, offset=offset)
    query = urllib.parse.urlencode(params)

    for attempt in range(5):
        try:
            with urllib.request.urlopen(f'{API}?{query}', timeout=60) as response:
                return json.loads(response.read().decode())
        except urllib.error.HTTPError as error:
            if error.code == 403:
                # 叩きすぎで遮断されている。長めに待つ。
                wait = 60 * (attempt + 1)
                print(f'    403 のため {wait}秒待ちます（{attempt + 1}/4）', file=sys.stderr)
                time.sleep(wait)
                continue
            if attempt == 4:
                raise
            print(f'    再試行 {attempt + 1}/4: {error}', file=sys.stderr)
            time.sleep(5 * (attempt + 1))
        except Exception as error:
            if attempt == 4:
                raise
            print(f'    再試行 {attempt + 1}/4: {error}', file=sys.stderr)
            time.sleep(5 * (attempt + 1))

    return {}


def normalise_reading(value: str) -> str:
    """読みがローマ字で入っていることがある。ひらがなのときだけ使う。"""
    text = str(value or '').strip()

    if not text:
        return ''

    # ひらがな・カタカナ以外が混じるものは、読みとして使わない。
    if not re.fullmatch(r'[ぁ-んァ-ヶー・\s]+', text):
        return ''

    # カタカナはひらがなに寄せる。
    return ''.join(
        chr(ord(c) - 0x60) if 'ァ' <= c <= 'ヶ' else c
        for c in text
    ).replace(' ', '').replace('　', '')


def save(output: Path, records: list, next_offset: int, done: bool) -> None:
    """途中でも書き出す。403で止められても、やり直さずに済むように。"""
    payload = {
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': SOURCE_LABEL,
        'sourceUrl': SOURCE_URL,
        'performers': records,
    }

    if not done:
        payload['nextOffset'] = next_offset

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    temporary.replace(output)


def resume(output: Path) -> tuple[list, set, int]:
    if not output.exists():
        return [], set(), 1

    try:
        payload = json.loads(output.read_text(encoding='utf-8'))
    except Exception:
        return [], set(), 1

    next_offset = int(payload.get('nextOffset') or 0)

    if not next_offset:
        print('前回は最後まで終わっています。最初から取り直します。', file=sys.stderr)
        return [], set(), 1

    records = payload.get('performers', [])
    print(f'前回の続きから始めます: {len(records):,}人取得済み', file=sys.stderr)

    return records, {r['sokmilId'] for r in records}, next_offset


def main() -> None:
    output = Path(sys.argv[1])

    api_key = os.environ.get('SOKMIL_API_KEY')
    affiliate_id = os.environ.get('SOKMIL_AFFILIATE_ID')

    if not api_key or not affiliate_id:
        raise SystemExit('環境変数 SOKMIL_API_KEY と SOKMIL_AFFILIATE_ID が必要です。')

    credentials = {'api_key': api_key, 'affiliate_id': affiliate_id}

    records, seen, offset = resume(output)
    total = None

    while True:
        payload = call(credentials, offset).get('result', {})

        if payload.get('errors'):
            print('APIがエラーを返しました:', payload['errors'], file=sys.stderr)
            break

        rows = payload.get('actor') or []

        if total is None:
            total = int(payload.get('total_count') or 0)
            print(f'出演者 {total:,}人を順に取ります。', flush=True)

        if not rows:
            break

        for row in rows:
            identifier = str(row.get('id') or '').strip()

            if not identifier or identifier in seen:
                continue
            seen.add(identifier)

            record = {'sokmilId': identifier}

            for field in FIELDS:
                value = str(row.get(field) or '').strip()
                if value:
                    record[field] = value

            record['reading'] = normalise_reading(row.get('ruby'))

            for key in ('listURL', 'affiliateURL', 'imageURL'):
                value = row.get(key)
                if isinstance(value, str) and value:
                    record[key] = value

            if record.get('name'):
                records.append(record)

        offset += HITS

        if offset % 1000 < HITS:
            save(output, records, offset, False)
            print(f'  {len(records):,}人（保存しました）', flush=True)

        if total and offset > total:
            break

        time.sleep(INTERVAL)

    records.sort(key=lambda r: (r.get('reading') or '￿', r['name']))
    save(output, records, offset, True)

    def filled(field: str) -> int:
        return sum(1 for r in records if r.get(field))

    print()
    print(f'{len(records):,}人を書き出しました → {output}')
    for field in ('reading', 'cup', 'bust', 'height', 'birthday', 'prefectures', 'blood_type', 'imageURL'):
        print(f'  {field}: {filled(field):,}人')


main()
