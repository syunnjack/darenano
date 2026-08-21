"""DUGA の作品データCSVから、出演者ごとの作品数と代表作品を取り出す。

出典: DUGA アフィリエイト「作品データCSV」
      https://duga.jp/productcsv/

APIを1件ずつ巡回するより、こちらのほうが速くて内容も多い。
（API経由: 195,824作品・出演者8,865人 / CSV: 238,872作品・出演者45,195人）

DUGA には出演者ごとのページのURLが公式に無い。ウェブサービスの
レスポンスにもCSVにも、あるのは商品ページのURLだけ。そのため
出演者の代表作品（いちばん新しいもの）を1つ選び、そこへ案内する。

CSVは毎日12:30と18:30に更新される。文字コードは Shift_JIS。

出力は氏名をキーにした一覧。出演者IDと読み仮名はウェブサービス側にしか
無いため、そちらの結果（public/data/duga-performers.json）と併せて使う。

使い方: python scripts/fetch-duga-csv.py public/data/duga-products.json
"""
import csv
import io
import json
import re
import sys
import urllib.request
from datetime import date
from pathlib import Path

CSV_URL = 'https://duga.jp/productcsv/'
SOURCE_LABEL = 'DUGA 作品データCSV'
SOURCE_URL = 'https://duga.jp/productcsv/'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0 Safari/537.36')

# 出演者名として扱わないもの（CSVに紛れ込む表記）
SKIP_NAMES = {'不明', '素人', '一般女性', '（不明）', '-', '―'}

# レーベル名に露骨な語が入っているものは表示しない。
# 1,068種のうち30種ほどが該当する（「女排泄一門会」「フェラチオハンター」など）。
# 「熟女」「人妻」のようなジャンル語は、露骨な描写ではないので除かない。
EXPLICIT = (
    '排泄', '浣腸', '放尿', '小便', 'ウンコ', '糞', 'ゲロ', '嘔吐', 'スカトロ',
    'フェラ', '手コキ', '素股', 'ハメ', '中出し', 'アナル', '潮吹', '射精', '精子',
    '乱交', '輪姦', 'レイプ', '強姦', '近親', '痴漢', '露出', '奴隷', '調教',
    '無修正', 'ロリ', '児童', 'JK', '女子校', 'アヘ', 'アへ', '羞恥',
)


def displayable(label: str) -> bool:
    return bool(label) and not any(word in label for word in EXPLICIT)


def download() -> bytes:
    cache = Path(__file__).resolve().parent / '.cache' / 'duga-products.csv'

    if cache.exists():
        return cache.read_bytes()

    print('作品データCSVを取得します（約130MB）。', file=sys.stderr)
    request = urllib.request.Request(CSV_URL, headers={'User-Agent': UA})

    with urllib.request.urlopen(request, timeout=300) as response:
        data = response.read()

    cache.parent.mkdir(parents=True, exist_ok=True)
    cache.write_bytes(data)

    return data


def parse_date(text: str) -> str:
    """「2007年07月05日」を「2007-07-05」にする。読めなければ空文字。"""
    matched = re.match(r'(\d{4})年(\d{1,2})月(\d{1,2})日', (text or '').strip())

    if not matched:
        return ''

    return '{}-{:02d}-{:02d}'.format(matched.group(1), int(matched.group(2)), int(matched.group(3)))


def main() -> None:
    output = Path(sys.argv[1])

    text = download().decode('cp932', 'replace')
    reader = csv.DictReader(io.StringIO(text))

    performers: dict[str, dict] = {}
    products = 0

    for row in reader:
        products += 1
        product_id = (row.get('商品ID') or '').strip()
        opened = parse_date(row.get('公開開始日') or '')

        for name in (row.get('出演者') or '').split(','):
            name = name.strip()

            if not name or name in SKIP_NAMES:
                continue

            record = performers.setdefault(name, {
                'name': name,
                'works': 0,
                'productId': '',
                'productOpenedOn': '',
                'firstOpenedOn': '',
                'lastOpenedOn': '',
                'labelCounts': {},
            })
            record['works'] += 1

            # 代表作品は、いちばん新しく公開されたもの。
            if product_id and opened >= record['productOpenedOn']:
                record['productId'] = product_id
                record['productOpenedOn'] = opened

            label = (row.get('レーベル名') or '').strip()
            if displayable(label):
                record['labelCounts'][label] = record['labelCounts'].get(label, 0) + 1

            # 収録作品の公開日の範囲。日付が入っている作品だけで数える。
            if opened:
                if not record['firstOpenedOn'] or opened < record['firstOpenedOn']:
                    record['firstOpenedOn'] = opened
                if opened > record['lastOpenedOn']:
                    record['lastOpenedOn'] = opened

    # 作品数の多い順に、上位3つのレーベルだけ残す。
    for record in performers.values():
        counts = record.pop('labelCounts')
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        record['labels'] = [name for name, _count in ordered[:3]]

    records = sorted(performers.values(), key=lambda r: (-r['works'], r['name']))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': SOURCE_LABEL,
        'sourceUrl': SOURCE_URL,
        'scannedItems': products,
        'performers': records,
    }, ensure_ascii=False), encoding='utf-8')

    print(f'{products:,}作品から、出演者 {len(records):,}人を集めました → {output}')
    dated = sum(1 for r in records if r['firstOpenedOn'])
    labelled = sum(1 for r in records if r['labels'])
    print(f'  公開日が分かる出演者: {dated:,}人')
    print(f'  表示できるレーベルがある出演者: {labelled:,}人')
    for record in records[:5]:
        span = f"{record['firstOpenedOn']}〜{record['lastOpenedOn']}" if record['firstOpenedOn'] else '不明'
        print(f"  {record['name']} {record['works']}作品（{span}）")


main()
