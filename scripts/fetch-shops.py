"""愛知のアダルトショップを、各チェーンの公式サイトから取る。

## なぜ各社の公式からか

**まとめサイトの店舗データは使わない。**
イベント情報サイト「イベルト」（av-event.jp）に全国の店舗が揃っているが、
利用規約に「複製、改変、頒布等をすることは、権利者の正当な許諾がない限り、禁止します」
と明記されている（2026-09-07 確認）。結婚式場マップでゼクシィの掲載データを使わないのと
同じ判断で、**権利者＝各店の公式サイトから直接取る。**

住所・電話番号・営業時間は、店が自分のサイトで公開している事実。
そこから取れば出典が1対1で示せる。

## 取れるチェーン（2026-09-07 時点）

    零式書店（王の洞窟）  ounodoukutsu.jp    愛知岐阜三重。曜日別の営業時間まである
    DVDマックス           videomax-group.com 個室DVD
    MAX書店               videomax-group.com 販売店
    アジト                azito.nagoya       2店
    三國書店              mikunisyoten.com   **アダルトDVD買取をやっている**

    匠書店                takumi-dvd.shop    **宅配買取もやっている**。屋号が複数ある

**アジト（azito.nagoya）は取らない。** アクセスページが地図画像だけで、
住所が文字になっていない。出典が示せない店は落とす。名前だけのページは作らない。

**旧公式の cstakumi.blog.fc2.com は404。** 現在は takumi-dvd.shop。

## 出力

    data/shops.json   ページ生成は scripts/build-shops.mjs

環境変数:
  PAUSE  1件あたりの待ち秒（既定 1.5）
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / 'data' / 'shops.json'
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')
PAUSE = float(os.environ.get('PAUSE') or 1.5)

ZEROSHIKI = ['kamimaezu2', 'nagoya', 'owariasahi', 'kariya', 'komaki', 'ooguchi',
             'morimoto', 'ichinomiya22', 'toyohashi', 'oogaki', 'ogakiminami',
             'akanabe', 'kakamigahara', 'suzuka']


def fetch(url, tries=3, wait=4.0):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={
                'User-Agent': UA, 'Accept-Language': 'ja'})
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
            # **文字コードを決め打ちしない。** 個人商店のサイトは Shift_JIS が残っている。
            for encoding in ('utf-8', 'cp932', 'euc-jp'):
                try:
                    text = raw.decode(encoding)
                    if text.count('�') < 10:
                        return text
                except Exception:
                    continue
            return raw.decode('utf-8', 'replace')
        except urllib.error.HTTPError as error:
            if error.code == 404:
                return ''
            if attempt == tries - 1:
                print(f'    {error.code} {url}', file=sys.stderr)
                return ''
            time.sleep(wait * (attempt + 1))
        except Exception as error:
            if attempt == tries - 1:
                print(f'    あきらめます {url}: {error}', file=sys.stderr)
                return ''
            time.sleep(wait * (attempt + 1))
    return ''


def plain(html):
    html = re.sub(r'<script.*?</script>|<style.*?</style>', '', html, flags=re.S)
    text = unescape(re.sub(r'<[^>]+>', '|', html))
    return re.sub(r'[ \t]+', ' ', re.sub(r'\|+', '|', text))


def tidy(value):
    return re.sub(r'\s+', ' ', (value or '').replace('|', ' ')).strip()


def zeroshiki():
    """王の洞窟の店舗ページ。住所・電話・曜日別の営業時間が構造化されている。"""
    rows = []
    for slug in ZEROSHIKI:
        url = f'https://ounodoukutsu.jp/zeroshiki/shop/{slug}/'
        html = fetch(url)
        time.sleep(PAUSE)
        if not html:
            continue
        text = plain(html)

        title = re.search(r'<title[^>]*>(.*?)</title>', html, re.S)
        name = unescape(title.group(1)).split(' - ')[0].strip() if title else ''

        block = re.search(r'\|\s*住所\s*\|(.*?)\|\s*電話番号\s*\|', text, re.S)
        address, access, zipcode = '', '', ''
        if block:
            parts = [tidy(x) for x in block.group(1).split('|') if tidy(x)]
            for part in parts:
                zip_match = re.match(r'〒\s*(\d{3}-?\d{4})', part)
                if zip_match:
                    zipcode = zip_match.group(1)
                elif re.search(r'(駅|出口|徒歩|バス|線)', part) and address:
                    access = part
                elif not address:
                    address = part
                else:
                    address += ' ' + part

        tel = re.search(r'\|\s*電話番号\s*\|(.*?)\|\s*営業時間\s*\|', text, re.S)
        hours = re.search(r'\|\s*営業時間\s*\|(.*?)\|\s*店舗基本情報', text, re.S)

        rows.append({
            'chain': '零式書店', 'name': name, 'zip': zipcode,
            'address': address, 'access': access,
            'tel': tidy(tel.group(1)) if tel else '',
            'hours': tidy(hours.group(1)) if hours else '',
            'parking': '', 'closed': '', 'items': '', 'buys': '',
            'site': 'https://ounodoukutsu.jp/zeroshiki/', 'source': url,
        })
        print(f'  零式 {name}', file=sys.stderr)
    return rows


def videomax():
    """DVDマックス（個室）と MAX書店（販売）。

    1ページに複数店が並ぶ。**店名のあとに住所が来るとは限らない**ので、
    店名を見つけてから、その先の窓の中で住所・TEL・注記を拾う。
    注記は「24時間営業・年中無休・無料P17台有」のように詰まっているが、
    **住所と同じかたまりに入ることがある**ので、まず区切り記号で割ってから振り分ける。
    """
    rows = []
    pages = [('https://videomax-group.com/shop.php', 'DVDマックス'),
             ('https://videomax-group.com/maxbook.php', 'MAX書店')]
    for url, chain in pages:
        html = fetch(url)
        time.sleep(PAUSE)
        if not html:
            continue
        text = plain(html)
        seen = set()
        for match in re.finditer(r'((?:DVDマックス|MAX書店)\s?[^|\s]{1,8}店)', text):
            name = tidy(match.group(1))
            if name in seen or not name.endswith('店') or name.endswith('マックス店'):
                continue
            window = text[match.end():match.end() + 700]
            address = re.search(r'(愛知県(?!.{0,4}と東海市)[^|]{5,45})', window)
            if not address:
                continue
            seen.add(name)
            tel = re.search(r'TEL\s*([\d\-]{9,14})', window)

            chunks = []
            for segment in window.split('|')[:14]:
                segment = tidy(segment)
                if not segment or '愛知県' in segment:
                    continue
                segment = re.sub(r'TEL\s*[\d\-]{9,14}', '', segment)
                chunks.extend(tidy(c) for c in re.split(r'[・/]', segment))

            hours, closed, parking, room, access = '', '', '', '', ''
            for chunk in chunks:
                if not chunk:
                    continue
                # **（年中無休）が営業時間と同じかたまりに入る。** 先に抜く。
                inside = re.search(r'[（(]([^）)]*休[^）)]*)[）)]', chunk)
                if inside and not closed:
                    closed = inside.group(1)
                    chunk = tidy(chunk.replace(inside.group(0), ''))
                if not chunk:
                    continue
                if re.search(r'(時間営業|\d{1,2}:\d{2}|午前|午後)', chunk) and not hours:
                    hours = re.sub(r'^営業時間\s*', '', chunk)
                elif '休' in chunk and not closed:
                    closed = chunk
                elif re.search(r'(無料P|駐車)', chunk) and not parking:
                    parking = chunk[:60]
                elif '個室' in chunk and not room:
                    room = chunk
                elif re.search(r'(駅|徒歩|I\.C)', chunk) and not access:
                    access = chunk

            rows.append({
                'chain': chain, 'name': name, 'zip': '',
                'address': tidy(address.group(1)), 'access': access,
                'tel': tel.group(1) if tel else '',
                'hours': hours, 'closed': closed, 'parking': parking,
                'items': room, 'buys': '',
                'site': 'https://videomax-group.com/', 'source': url,
            })
            print(f'  {chain} {name}', file=sys.stderr)
    return rows


def mikuni():
    """三國書店。**アダルトDVDの買取をやっている数少ない実店舗。**

    店舗ページが `■営業時間：`『■住所：』のように全角の■で区切られている。
    取扱い商品まで書いてあるので、そこも取る。
    """
    rows = []
    pages = [('11_nakagawa.html', '中川店'), ('12_kita.html', '名古屋北店'),
             ('13_nishibi.html', '西枇店')]
    labels = ['営業時間', '住所', '電話', '駐車場', '取扱い商品']

    def item(text, label):
        stop = '|'.join(labels)
        match = re.search(r'■\s*' + label + r'\s*[：:](.*?)(?=■\s*(?:' + stop + r')|\Z)',
                          text, re.S)
        value = tidy(match.group(1)) if match else ''
        # **「...他」の後ろに新着記事が続く。** そこで切る。
        value = re.split(r'\.\.\.他|…他|▼', value)[0]
        return value.strip('  ')[:120]

    for path, label in pages:
        url = f'http://mikunisyoten.com/{path}'
        html = fetch(url)
        time.sleep(PAUSE)
        if not html:
            continue
        text = plain(html)
        address = item(text, '住所')
        zipcode = ''
        zip_match = re.search(r'〒\s*(\d{3}-?\d{4})', address)
        if zip_match:
            zipcode = zip_match.group(1)
            address = tidy(address.replace(zip_match.group(0), ''))
        hours = item(text, '営業時間')
        if not hours:
            # **店によって■が無い。** OPEN〜CLOSE の記法を直接探す。
            fallback = re.search(r'(OPEN\s*\d{1,2}:\d{2}\s*[〜~\-～]\s*CLOSE\s*\d{1,2}:\d{2}'
                                 r'(?:\s*[（(][^）)]*[）)])?)', text)
            hours = tidy(fallback.group(1)) if fallback else ''
        closed = ''
        closed_match = re.search(r'[（(]([^）)]*休[^）)]*)[）)]', hours)
        if closed_match:
            closed = closed_match.group(1)
            hours = tidy(hours.replace(closed_match.group(0), ''))
        rows.append({
            'chain': '三國書店', 'name': f'三國書店 {label}', 'zip': zipcode,
            'address': address, 'access': '',
            'tel': item(text, '電話'), 'hours': hours, 'closed': closed,
            # **西枇店は駐車場の説明が長い。** 頭だけ残す。
            'parking': item(text, '駐車場')[:60],
            'items': item(text, '取扱い商品'),
            'buys': '店頭買取・宅配買取・処分',
            'site': 'http://mikunisyoten.com/', 'source': url,
        })
        print(f'  三國書店 {label}', file=sys.stderr)
    return rows


def takumi():
    """匠書店（takumi-dvd.shop）。**1ページに全店が同じ並びで載っている。**

        店名 | 営業時間: 12:00 ～ 26:00 | 年中無休 | 愛知県名古屋市南区 | 本地通4丁目2-1 | TEL ...

    住所が「市区」と「番地」の2つに割れているので、続けて拾ってつなぐ。
    DVD匠書店・綾波書店・匠書店壱見屋と屋号が混ざるが、同じ会社の店として扱う。
    """
    url = 'https://takumi-dvd.shop/'
    html = fetch(url)
    time.sleep(PAUSE)
    if not html:
        return []
    text = plain(html)

    buys = ''
    guide = fetch('https://takumi-dvd.shop/howto')
    time.sleep(PAUSE)
    if guide and '宅配' in guide:
        buys = '店頭買取・宅配買取'
    elif guide:
        buys = '店頭買取'

    rows, seen = [], set()
    # **空の区切りが挟まる。** `店名 | | 営業時間:` のように並ぶので、
    # 単純に `\|` でつなぐと1件も当たらない。
    sep = r'\s*\|(?:\s*\|)*\s*'
    pattern = (r'([^|]{2,22}店)' + sep + r'営業時間\s*[:：]\s*([^|]{3,30})' + sep
               + r'([^|]{0,12})' + sep + r'(愛知県[^|]{2,20})' + sep
               + r'([^|]{1,30})' + sep + r'TEL\s*([\d\-]{9,14})')
    for match in re.finditer(pattern, text):
        name = tidy(match.group(1))
        if name in seen or name.endswith('MAPで見る'):
            continue
        seen.add(name)
        rows.append({
            # **屋号が3つある**（DVD匠書店・綾波書店・あきば書店・匠書店壱見屋）。
            # 同じ会社の店なので、まとめて匠書店グループとして扱う。
            'chain': '匠書店', 'name': name, 'zip': '',
            'address': tidy(match.group(4)) + tidy(match.group(5)),
            'access': '', 'tel': tidy(match.group(6)),
            'hours': tidy(match.group(2)), 'closed': tidy(match.group(3)),
            'parking': '', 'items': '', 'buys': buys,
            'site': url, 'source': url,
        })
        print(f'  匠書店 {name}', file=sys.stderr)
    return rows


def azito():
    """アジト（azito.nagoya）は取らない。

    **公式サイトに住所が書かれていない。** アクセスページは地図画像だけで、
    〒も番地も文字では出していない（2026-09-07 確認）。
    まとめサイトには載っているが、そちらは規約で複製が禁止されている。
    出典を示せないので、この店は載せない。
    """
    return []


def main():
    shops = []
    for label, func in [('零式書店', zeroshiki), ('マックスグループ', videomax),
                        ('三國書店', mikuni), ('匠書店', takumi), ('アジト', azito)]:
        print(label, file=sys.stderr)
        shops.extend(func())

    # **住所が取れなかった店は落とす。** 名前だけのページは作らない。
    kept = [s for s in shops if s['address']]
    dropped = len(shops) - len(kept)
    kept.sort(key=lambda s: (s['chain'], s['name']))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        'confirmedOn': date.today().isoformat(),
        'note': '各店の公式サイトから取得。まとめサイトの掲載データは使っていない。',
        'shops': kept,
    }, ensure_ascii=False, indent=1), encoding='utf-8')

    print(f'\n{len(kept)}店を書き出しました（住所が取れず落とした: {dropped}件）',
          file=sys.stderr)
    for chain in sorted(set(s['chain'] for s in kept)):
        rows = [s for s in kept if s['chain'] == chain]
        full = sum(1 for s in rows if s['tel'] and s['hours'])
        print(f'  {chain} {len(rows)}店  電話と営業時間まで揃い {full}', file=sys.stderr)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
