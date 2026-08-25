"""B10F の作品データCSVから、出演者ごとの作品数と代表作品を取り出す。

出典: B10F（ビーテンエフ）アフィリエイトプログラム
      https://affiliate.b10f.jp/

B10F にはウェブサービス（API）が無く、アフィリエイトの管理画面から
CSV を落とす形になっている。**「全作品のCSV」（約130MB）が用意されているので、
基本はそれ1本でよい。** カテゴリー別のCSVもあり、その場合は置いてあるカテゴリーの
ぶんだけの集計になる。ファイル名は
`B10F_<日付>_カテゴリーID<数字>_<カテゴリー名>.csv` または `B10F_<日付>.csv`。

**「シングルクオートセパレータ有り」のほうを落とすこと。** 区切りだけのタイプは
このスクリプトでは読めない。

文字コードは UTF-8（BOM付き）、各項目は **シングルクォート** で囲まれている。
`csv.reader(..., quotechar="'")` で読むこと。ダブルクォートで読むと
広告タグの中の `"` で列がずれる。

**「出演」が空の作品が多い**（手元の2カテゴリーでは 3,655件中 630件だけ）。
名前が無いものは数えない。同じ作品が複数のカテゴリーCSVに出てくるので、
商品IDで重複を落としてから数える。

商品ページのURLは、アフィリエイトIDの入ったものを
「どれでもバナー 作品名リンク」列の href から取る（`?atv=` 付き）。
素の「商品URL」には紹介IDが入っていない。

使い方: python scripts/fetch-b10f-csv.py public/data/b10f-products.json [CSVの置き場]
        置き場の既定は scripts/.cache/b10f
"""
import csv
import glob
import html
import io
import json
import os
import re
import sys
from datetime import date
from pathlib import Path

SOURCE_LABEL = 'B10F アフィリエイト 作品データCSV'
SOURCE_URL = 'https://affiliate.b10f.jp/'

# 出演者名として扱わないもの
SKIP_NAMES = {'不明', '素人', '一般女性', '（不明）', '-', '―', '他'}

# ブランド名に露骨な語が入っているものは表示しない（fetch-duga-csv.py と同じ方針）。
EXPLICIT = (
    '排泄', '浣腸', '放尿', '小便', 'ウンコ', '糞', 'ゲロ', '嘔吐', 'スカトロ',
    'フェラ', '手コキ', '素股', 'ハメ', '中出し', 'アナル', '潮吹', '射精', '精子',
    '乱交', '輪姦', 'レイプ', '強姦', '近親', '痴漢', '露出', '奴隷', '調教',
    '無修正', 'ロリ', '児童', 'JK', '女子校', 'アヘ', 'アへ', '羞恥',
)

HREF = re.compile(r'href="([^"]+)"')

# 「どれでもバナー タグ作品一覧」列から、タグ名とその行き先を取り出す。
TAG = re.compile(r'<a href="([^"]+)"[^>]*>([^<]+)</a>')

# darekore.jp のジャンル名 → B10F でのタグ名の候補。
#
# **意味がそのまま重なるものだけを載せる。** B10F にしか無い区分や、
# 範囲が違うもの（パンチラ ⊂ チラリズム、水着 ⊃ 競泳水着）は入れない。
# 候補のうち、CSVに実在したタグだけを使う。
#
# 対応表に無いジャンルのページは、これまでどおり3社のままになる。
GENRE_TAGS = {
    '騎乗位': ['騎乗位'],
    '素人': ['素人'],
    'ハメ撮り': ['ハメ撮り'],
    'コスプレ': ['コスプレ'],
    'レズビアン': ['レズ'],
    '中出し': ['中出し'],
    '寝取り・寝取られ・NTR': ['寝取り・寝取られ'],
    'ぽっちゃり': ['ぽっちゃり'],
    '野外・露出': ['露出'],
    '顔射': ['顔射'],
    'VR専用': ['VR(3DVR)'],
    '巨乳': ['巨乳'],
    '美少女': ['美少女'],
    '人妻・主婦': ['人妻'],
    '熟女': ['熟女'],
    '痴女': ['痴女'],
    '制服': ['制服'],
    'メイド': ['メイド'],
    '看護婦・ナース': ['ナース'],
    'OL': ['OL'],
    'スレンダー': ['スレンダー'],
}


FILENAME = re.compile(r'B10F_(\d{8})_カテゴリーID(\d+)_')


def newest_per_category(paths: list[str]) -> list[str]:
    """同じカテゴリーのCSVが日付違いで置いてあるときは、新しいほうだけ使う。

    落とし直したCSVを消し忘れても、古い内容を混ぜないため。
    ファイル名が想定と違うものは、そのまま全部読む。
    """
    newest: dict[str, tuple[str, str]] = {}
    others: list[str] = []

    for path in paths:
        matched = FILENAME.search(Path(path).name)

        if not matched:
            others.append(path)
            continue

        stamp, category = matched.group(1), matched.group(2)
        if category not in newest or stamp > newest[category][0]:
            newest[category] = (stamp, path)

    return sorted(others + [path for _stamp, path in newest.values()])


def displayable(label: str) -> bool:
    return bool(label) and not any(word in label for word in EXPLICIT)


def clean(value: str) -> str:
    return html.unescape((value or '').strip())


def rows_of(path: Path):
    """1本のCSVを読む。1行目が見出し。列数が合わない行は捨てる。

    B10F のCSVには2種類ある。**どちらが落とされても読めるようにしてある。**

    - シングルクォート囲みのタイプ（`'52547','2026-08-26',...`）
    - 囲み無しのタイプ（WordPress一括投稿向け。`52547,2026-08-26,...`）

    囲み無しのほうは、本文に読点でないコンマが入っている作品で列がずれる
    （全作品CSV 22,329件のうち10件）。**ずれた行は列の中身が別項目に
    なってしまい、出演者名の位置に題名の断片が入る**ので、数えずに捨てる。
    """
    text = path.read_text(encoding='utf-8-sig', errors='replace')
    quotechar = "'" if text.lstrip().startswith("'") else '"'
    table = list(csv.reader(io.StringIO(text, newline=''), quotechar=quotechar))

    if not table:
        return

    header = table[0]
    for row in table[1:]:
        if len(row) != len(header):
            continue
        yield dict(zip(header, row))


def write_genres(products: dict, folder: Path) -> None:
    """ジャンル別ページ用に、タグごとの出演者を数えて b10f-genres.json に書く。

    darekore.jp のジャンル名は genres.json（fetch-genres.py の出力）から読む。
    **こちらで slug を書き写さない。** ジャンル名で引き当て、
    genres.json に無い名前や、CSVに実在しないタグは飛ばす。
    """
    source = folder / 'genres.json'

    if not source.exists():
        print('  genres.json が無いので、ジャンル別の集計は作りません。', file=sys.stderr)
        return

    known = json.loads(source.read_text(encoding='utf-8')).get('genres', [])
    slug_of = {g['name']: g['slug'] for g in known}

    # タグ名 → {works, link, 出演者ごとの本数}
    tags: dict[str, dict] = {}

    for item in products.values():
        names = [n.strip() for n in re.split(r'[,、/／]', item['names']) if n.strip() and n.strip() not in SKIP_NAMES]

        for label, href in item['tags'].items():
            bucket = tags.setdefault(label, {'works': 0, 'link': href, 'performers': {}})
            bucket['works'] += 1

            for name in names:
                bucket['performers'][name] = bucket['performers'].get(name, 0) + 1

    genres = []

    for name, candidates in GENRE_TAGS.items():
        slug = slug_of.get(name)

        if not slug:
            continue

        # 候補のうち、CSVに実在したタグだけ使う。
        found = [tag for tag in candidates if tag in tags]

        if not found:
            continue

        works = 0
        link = ''
        performers: dict[str, int] = {}

        for tag in found:
            bucket = tags[tag]
            works += bucket['works']
            link = link or bucket['link']

            for who, count in bucket['performers'].items():
                performers[who] = performers.get(who, 0) + count

        if not performers:
            continue

        genres.append({
            'name': name,
            'slug': slug,
            'b10fTags': found,
            'works': works,
            'link': link,
            'performers': [
                {'name': who, 'works': count}
                for who, count in sorted(performers.items(), key=lambda kv: (-kv[1], kv[0]))
            ],
        })

    target = folder / 'b10f-genres.json'
    target.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': SOURCE_LABEL,
        'sourceUrl': SOURCE_URL,
        'genres': genres,
    }, ensure_ascii=False), encoding='utf-8')

    total = sum(len(g['performers']) for g in genres)
    print(f'  ジャンル {len(genres)}件 / のべ出演者 {total:,}人 → {target}')
    for genre in genres[:5]:
        print(f"    {genre['name']}（{'・'.join(genre['b10fTags'])}）{genre['works']:,}作品 / {len(genre['performers'])}人")


def main() -> None:
    output = Path(sys.argv[1])
    folder = Path(sys.argv[2]) if len(sys.argv) > 2 else Path(
        os.environ.get('B10F_CSV_DIR') or Path(__file__).resolve().parent / '.cache' / 'b10f')

    files = newest_per_category(sorted(glob.glob(str(folder / 'B10F_*.csv'))))

    if not files:
        print(f'CSVが1本もありません: {folder}', file=sys.stderr)
        sys.exit(1)

    products: dict[str, dict] = {}
    categories: set[str] = set()
    scanned = 0

    for path in files:
        for row in rows_of(Path(path)):
            scanned += 1
            product_id = clean(row.get('商品ID'))
            if not product_id:
                continue

            # 全作品CSVでは「全ての作品」が入る。見出しは「カテゴリー名」「カテゴリ名」の両方がある。
            category = clean(row.get('カテゴリー名') or row.get('カテゴリ名'))
            if category:
                categories.add(category)

            # 同じ作品が複数のカテゴリーCSVに出てくるので、1件にまとめる。
            item = products.setdefault(product_id, {
                'id': product_id,
                'title': clean(row.get('タイトル')),
                'openedOn': clean(row.get('配信日')),
                # 全作品CSVは「メーカー名」、カテゴリー別CSVは「ブランド」と見出しが違う。
                'brand': clean(row.get('ブランド') or row.get('メーカー名')),
                'names': clean(row.get('出演')),
                'url': '',
                'tags': {},
            })

            # タグ（ジャンル）と、その行き先。紹介IDが入ったURLがそのまま入っている。
            for matched in TAG.finditer(row.get('どれでもバナー タグ作品一覧') or ''):
                href, label = matched.group(1), matched.group(2)
                item['tags'].setdefault(clean(label), html.unescape(href))

            if not item['url']:
                matched = HREF.search(row.get('どれでもバナー 作品名リンク') or '')
                item['url'] = html.unescape(matched.group(1)) if matched else clean(row.get('商品URL'))

    performers: dict[str, dict] = {}

    for item in products.values():
        for name in re.split(r'[,、/／]', item['names']):
            name = name.strip()

            if not name or name in SKIP_NAMES:
                continue

            record = performers.setdefault(name, {
                'name': name,
                'works': 0,
                'productId': '',
                'productTitle': '',
                'productUrl': '',
                'productOpenedOn': '',
                'firstOpenedOn': '',
                'lastOpenedOn': '',
                'brandCounts': {},
            })
            record['works'] += 1

            # 代表作品は、いちばん新しく配信されたもの。
            if item['openedOn'] >= record['productOpenedOn']:
                record['productId'] = item['id']
                record['productTitle'] = item['title']
                record['productUrl'] = item['url']
                record['productOpenedOn'] = item['openedOn']

            if displayable(item['brand']):
                record['brandCounts'][item['brand']] = record['brandCounts'].get(item['brand'], 0) + 1

            if item['openedOn']:
                if not record['firstOpenedOn'] or item['openedOn'] < record['firstOpenedOn']:
                    record['firstOpenedOn'] = item['openedOn']
                if item['openedOn'] > record['lastOpenedOn']:
                    record['lastOpenedOn'] = item['openedOn']

    # 全作品CSVを読んだときは、カテゴリー別CSVが混ざっていても「全ての作品」だけにする。
    # 「痴女・全ての作品」のような並びだと、範囲が狭いように読めてしまう。
    if '全ての作品' in categories:
        categories = {'全ての作品'}

    for record in performers.values():
        counts = record.pop('brandCounts')
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        record['brands'] = [name for name, _count in ordered[:3]]

    records = sorted(performers.values(), key=lambda r: (-r['works'], r['name']))

    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'sourceLabel': SOURCE_LABEL,
        'sourceUrl': SOURCE_URL,
        'scannedItems': len(products),
        # どのカテゴリーのCSVを読んだか。ここに無いカテゴリーの作品は数に入っていない。
        'categories': sorted(categories),
        'performers': records,
    }, ensure_ascii=False), encoding='utf-8')

    write_genres(products, output.parent)

    print(f'CSV {len(files)}本 / のべ{scanned:,}行 → 作品 {len(products):,}件、出演者 {len(records):,}人 → {output}')
    print(f'  カテゴリー: {"、".join(sorted(categories))}')
    named = sum(1 for item in products.values() if item['names'].strip())
    print(f'  出演者名が入っている作品: {named:,}件（{100 * named / max(1, len(products)):.0f}%）')
    for record in records[:5]:
        print(f"  {record['name']} {record['works']}作品（{record['firstOpenedOn']}〜{record['lastOpenedOn']}）")


main()
