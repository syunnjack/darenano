"""FANZA動画のジャンル名を一覧する。

出典: FANZA アフィリエイト Web サービス（FloorList / GenreSearch）
      https://affiliate.dmm.com/api/

fetch-genres.py はジャンル名で ID を引き当てる。名前が一字でも違うと
黙って飛ばすので、「実際に何という名前で登録されているか」を先に見る
ための道具。データは何も書き換えない。

認証は環境変数から読む。リポジトリには置かない。
  FANZA_API_ID / FANZA_AFFILIATE_ID
  KEYWORD を入れると、その語を含む名前だけを出す。

使い方:
  FANZA_API_ID=xxx FANZA_AFFILIATE_ID=yyy KEYWORD=人妻 \
    python scripts/list-genres.py
"""
import os

# 取得の手順は fetch-genres.py と同じものを使う。二重に書かない。
def load_helpers():
    """fetch-genres.py は読み込むと main() が走ってしまうので、関数だけ取る。"""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fetch-genres.py')
    source = open(path, encoding='utf-8').read().replace('\nmain()\n', '\n')
    namespace = {'__name__': 'fetch_genres'}
    exec(compile(source, path, 'exec'), namespace)
    return namespace


def main() -> None:
    api_id = os.environ.get('FANZA_API_ID')
    affiliate_id = os.environ.get('FANZA_AFFILIATE_ID')

    if not api_id or not affiliate_id:
        raise SystemExit('環境変数 FANZA_API_ID と FANZA_AFFILIATE_ID が必要です。')

    helpers = load_helpers()
    credentials = {'api_id': api_id, 'affiliate_id': affiliate_id}

    floor_id = helpers['videoa_floor_id'](credentials)
    table = helpers['genre_ids'](credentials, floor_id)

    keyword = (os.environ.get('KEYWORD') or '').strip()
    names = sorted(table)

    if keyword:
        names = [n for n in names if keyword in n]
        print(f'「{keyword}」を含むジャンル: {len(names)}件（全{len(table)}件中）')
    else:
        print(f'ジャンル: {len(names)}件')

    print()
    for name in names:
        print(f'  {name}\t{table[name]}')


main()
