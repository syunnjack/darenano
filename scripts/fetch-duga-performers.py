"""DUGA の商品検索 API から、出演者の一覧を集める。

出典: DUGA アフィリエイト Web サービス
      https://affiliate.duga.jp/

DUGA には出演者だけを引く API が無いため、商品を順に見て、
商品情報に含まれる出演者（ID・氏名・カナ）を集める。
出演者ごとの作品数も、見えた範囲の実数として数える。

appid と代理店IDは環境変数から読む。リポジトリには置かない。
  DUGA_APP_ID / DUGA_AGENT_ID

API の制限は 60秒あたり60リクエスト。1.2秒の間隔を空ける。
全商品を見るのに数時間かかるので、5,000件ごとに書き出して、
途中で止まっても次回は続きから始められるようにしてある。

環境変数 DUGA_MAX_MINUTES を指定すると、その時間で切り上げて保存する。

使い方: DUGA_APP_ID=xxx DUGA_AGENT_ID=yyy python scripts/fetch-duga-performers.py public/data/duga-performers.json
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

API = 'http://affapi.duga.jp/search'
HITS = 100
INTERVAL = 1.2
SAVE_EVERY = 1000
SOURCE_LABEL = 'DUGA アフィリエイト Web サービス'
SOURCE_URL = 'https://affiliate.duga.jp/'


def call(credentials: dict, offset: int) -> dict:
    params = dict(credentials, version='1.2', bannerid='01', format='json',
                  hits=HITS, offset=offset, sort='favorite')
    query = urllib.parse.urlencode(params)

    for attempt in range(5):
        try:
            with urllib.request.urlopen(f'{API}?{query}', timeout=60) as response:
                return json.loads(response.read().decode())
        except Exception as error:
            if attempt == 4:
                raise
            print(f'    再試行 {attempt + 1}/4: {error}', flush=True)
            time.sleep(5 * (attempt + 1))

    return {}


def half_to_full_kana(text: str) -> str:
    """DUGA のカナは半角なので、全角に直す。"""
    table = {
        'ｱ': 'ア', 'ｲ': 'イ', 'ｳ': 'ウ', 'ｴ': 'エ', 'ｵ': 'オ', 'ｶ': 'カ', 'ｷ': 'キ', 'ｸ': 'ク',
        'ｹ': 'ケ', 'ｺ': 'コ', 'ｻ': 'サ', 'ｼ': 'シ', 'ｽ': 'ス', 'ｾ': 'セ', 'ｿ': 'ソ', 'ﾀ': 'タ',
        'ﾁ': 'チ', 'ﾂ': 'ツ', 'ﾃ': 'テ', 'ﾄ': 'ト', 'ﾅ': 'ナ', 'ﾆ': 'ニ', 'ﾇ': 'ヌ', 'ﾈ': 'ネ',
        'ﾉ': 'ノ', 'ﾊ': 'ハ', 'ﾋ': 'ヒ', 'ﾌ': 'フ', 'ﾍ': 'ヘ', 'ﾎ': 'ホ', 'ﾏ': 'マ', 'ﾐ': 'ミ',
        'ﾑ': 'ム', 'ﾒ': 'メ', 'ﾓ': 'モ', 'ﾔ': 'ヤ', 'ﾕ': 'ユ', 'ﾖ': 'ヨ', 'ﾗ': 'ラ', 'ﾘ': 'リ',
        'ﾙ': 'ル', 'ﾚ': 'レ', 'ﾛ': 'ロ', 'ﾜ': 'ワ', 'ｦ': 'ヲ', 'ﾝ': 'ン',
        'ｧ': 'ァ', 'ｨ': 'ィ', 'ｩ': 'ゥ', 'ｪ': 'ェ', 'ｫ': 'ォ', 'ｬ': 'ャ', 'ｭ': 'ュ', 'ｮ': 'ョ',
        'ｯ': 'ッ', 'ｰ': 'ー',
    }
    voiced = {'ｶ': 'ガ', 'ｷ': 'ギ', 'ｸ': 'グ', 'ｹ': 'ゲ', 'ｺ': 'ゴ', 'ｻ': 'ザ', 'ｼ': 'ジ',
              'ｽ': 'ズ', 'ｾ': 'ゼ', 'ｿ': 'ゾ', 'ﾀ': 'ダ', 'ﾁ': 'ヂ', 'ﾂ': 'ヅ', 'ﾃ': 'デ',
              'ﾄ': 'ド', 'ﾊ': 'バ', 'ﾋ': 'ビ', 'ﾌ': 'ブ', 'ﾍ': 'ベ', 'ﾎ': 'ボ', 'ｳ': 'ヴ'}
    semi = {'ﾊ': 'パ', 'ﾋ': 'ピ', 'ﾌ': 'プ', 'ﾍ': 'ペ', 'ﾎ': 'ポ'}

    out = []
    index = 0
    while index < len(text):
        char = text[index]
        mark = text[index + 1] if index + 1 < len(text) else ''

        if mark == 'ﾞ' and char in voiced:
            out.append(voiced[char])
            index += 2
        elif mark == 'ﾟ' and char in semi:
            out.append(semi[char])
            index += 2
        else:
            out.append(table.get(char, char))
            index += 1

    return ''.join(out).replace(' ', '').replace('\u3000', '')


def save(output: Path, performers: dict, seen_items: int, next_offset: int, done: bool) -> None:
    """途中でも書き出す。止まってもやり直さずに済むように。"""
    records = sorted(performers.values(), key=lambda r: (-r['works'], r['name']))

    payload = {
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': SOURCE_LABEL,
        'sourceUrl': SOURCE_URL,
        'scannedItems': seen_items,
        'performers': records,
    }

    # 途中なら、次にどこから読むかを残す。終わったら消す。
    if not done:
        payload['nextOffset'] = next_offset

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix('.tmp')
    temporary.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
    temporary.replace(output)


def resume(output: Path) -> tuple[dict, int, int]:
    """前回の続きから始められるよう、書き出してあるものを読む。"""
    if not output.exists():
        return {}, 1, 0

    try:
        payload = json.loads(output.read_text(encoding='utf-8'))
    except Exception:
        return {}, 1, 0

    next_offset = int(payload.get('nextOffset') or 0)

    if not next_offset:
        print('前回は最後まで終わっています。最初から取り直します。', flush=True)
        return {}, 1, 0

    performers = {r['dugaId']: r for r in payload.get('performers', [])}
    seen = int(payload.get('scannedItems') or 0)
    print(f'前回の続きから始めます: {seen:,}件確認済み / 出演者 {len(performers):,}人', flush=True)

    return performers, next_offset, seen


def main() -> None:
    output = Path(sys.argv[1])

    app_id = os.environ.get('DUGA_APP_ID')
    agent_id = os.environ.get('DUGA_AGENT_ID')

    if not app_id or not agent_id:
        raise SystemExit('環境変数 DUGA_APP_ID と DUGA_AGENT_ID が必要です。')

    credentials = {'appid': app_id, 'agentid': agent_id}

    performers, offset, seen_items = resume(output)
    total = None
    done = False

    limit_minutes = float(os.environ.get('DUGA_MAX_MINUTES') or 0)
    deadline = time.monotonic() + limit_minutes * 60 if limit_minutes else None

    while True:
        payload = call(credentials, offset)

        if payload.get('error'):
            print('API がエラーを返しました:', payload['error'], flush=True)
            break

        items = payload.get('items') or []

        if total is None:
            total = int(payload.get('count') or 0)
            print(f'総商品数 {total:,}件。{offset:,}件目から見ます。', flush=True)

        if not items:
            done = True
            break

        for wrapper in items:
            item = wrapper.get('item') or {}
            seen_items += 1

            for entry in item.get('performer') or []:
                data = entry.get('data') or {}
                identifier = str(data.get('id') or '').strip()
                name = (data.get('name') or '').strip()

                if not identifier or not name:
                    continue

                record = performers.setdefault(identifier, {
                    'dugaId': identifier,
                    'name': name,
                    'kana': half_to_full_kana(data.get('kana') or ''),
                    'works': 0,
                })
                record['works'] += 1

        offset += HITS

        if total and offset > total:
            done = True

        # 1,000件ごとに途中経過を残す。止まってもここからやり直せる。
        if done or offset % SAVE_EVERY < HITS:
            save(output, performers, seen_items, offset, done)
            print(f'  {seen_items:,}件を確認 / 出演者 {len(performers):,}人（保存しました）', flush=True)

        if done:
            break

        if deadline and time.monotonic() > deadline:
            print(f'{limit_minutes:.0f}分たったので、ここまでを保存して終わります。', flush=True)
            break

        time.sleep(INTERVAL)

    save(output, performers, seen_items, offset, done)

    records = sorted(performers.values(), key=lambda r: (-r['works'], r['name']))

    print()
    state = '最後まで' if done else '途中まで'
    print(f'{state}: {seen_items:,}件の商品から、出演者 {len(records):,}人を集めました → {output}')
    for record in records[:5]:
        print(f"  {record['name']}（{record['kana']}）{record['works']}作品")

    if not done:
        print('もう一度同じコマンドを実行すると、続きから取得します。')


main()
