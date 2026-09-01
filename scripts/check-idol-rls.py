"""guradol.jp の投票・口コミテーブルを、匿名キーで実際に攻撃して確かめる。

**RLS は「書いたつもり」では守れない。** darekore.jp では
`revoke execute ... from public` を書き忘れ、匿名キーで承認関数を
呼べる状態になっていた。同じ穴が開いていないかを毎回この方法で見る。

守れていてほしいこと:
  1. 投票は入れられる（機能として必要）
  2. 口コミは投稿できるが、**必ず未承認から始まる**
  3. status='approved' を指定した投稿は**拒まれる**
  4. 未承認の口コミは**読めない**
  5. 承認関数は**呼べない**
  6. 既存の行を**書き換えられない・消せない**

環境変数: SUPABASE_URL / SUPABASE_ANON_KEY
"""
import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get('SUPABASE_URL', '').rstrip('/')
KEY = os.environ.get('SUPABASE_ANON_KEY', '')
SLUG = '__rls_test__'

results = []


def call(method: str, path: str, body=None, extra=None):
    url = f'{API}/rest/v1/{path}'
    headers = {'apikey': KEY, 'Authorization': f'Bearer {KEY}',
               'Content-Type': 'application/json'}
    headers.update(extra or {})
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.status, response.read().decode('utf-8', 'replace')
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode('utf-8', 'replace')
    except Exception as error:
        return 0, str(error)


def check(label: str, ok: bool, detail: str) -> None:
    results.append(ok)
    mark = 'OK  ' if ok else '危険'
    print(f'  [{mark}] {label}  … {detail}')


def main() -> int:
    if not API or not KEY:
        print('SUPABASE_URL と SUPABASE_ANON_KEY が要ります。', file=sys.stderr)
        return 1

    print('匿名キーで guradol のテーブルを触ります。')

    status, _ = call('POST', 'idol_votes', {'slug': SLUG, 'voter_hash': 'rlstest00000000'},
                     {'Prefer': 'return=minimal'})
    check('投票は入れられる', status in (201, 204, 409), f'HTTP {status}')

    status, _ = call('POST', 'idol_reviews',
                     {'slug': SLUG, 'body': 'RLSの確認用です。', 'status': 'pending'},
                     {'Prefer': 'return=minimal'})
    check('口コミは投稿できる', status in (201, 204), f'HTTP {status}')

    status, _ = call('POST', 'idol_reviews',
                     {'slug': SLUG, 'body': '承認済みで入れる試み。', 'status': 'approved'},
                     {'Prefer': 'return=minimal'})
    check('承認済みでの投稿は拒まれる', status not in (201, 204), f'HTTP {status}')

    status, body = call('GET', f'idol_reviews?slug=eq.{SLUG}&select=id,status')
    rows = json.loads(body) if status == 200 and body.startswith('[') else []
    check('未承認の口コミは読めない', all(r.get('status') == 'approved' for r in rows),
          f'HTTP {status} / 見えた行 {len(rows)}')

    status, _ = call('POST', 'rpc/approve_idol_review', {'review_id': 1})
    check('承認関数は呼べない', status not in (200, 204), f'HTTP {status}')

    status, _ = call('PATCH', f'idol_reviews?slug=eq.{SLUG}', {'status': 'approved'},
                     {'Prefer': 'return=minimal'})
    check('書き換えられない', status not in (200, 204), f'HTTP {status}')

    status, _ = call('DELETE', f'idol_reviews?slug=eq.{SLUG}', None,
                     {'Prefer': 'return=minimal'})
    check('消せない', status not in (200, 204), f'HTTP {status}')

    status, _ = call('DELETE', f'idol_votes?slug=eq.{SLUG}', None, {'Prefer': 'return=minimal'})
    check('投票も消せない', status not in (200, 204), f'HTTP {status}')

    bad = results.count(False)
    print(f'\n{len(results)}項目中 {bad}件が危険です。' if bad else
          f'\n{len(results)}項目すべて守れています。')
    print('確認用に入れた行（slug が __rls_test__）は、Supabase 側で消してください。')

    return 1 if bad else 0


if __name__ == '__main__':
    raise SystemExit(main())
