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
            })
            record['works'] += 1

            # 代表作品は、いちばん新しく公開されたもの。
            if product_id and opened >= record['productOpenedOn']:
                record['productId'] = product_id
                record['productOpenedOn'] = opened

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
    for record in records[:5]:
        print(f"  {record['name']} {record['works']}作品（代表作 {record['productId']}）")


main()
