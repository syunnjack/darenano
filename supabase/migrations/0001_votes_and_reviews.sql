-- darekore.jp の投票と口コミ。
--
-- サイトは GitHub Pages の静的サイトなので、投稿の保存先として Supabase を使う。
-- ブラウザからは匿名キー（anon）で直接読み書きするため、守りは RLS だけが頼り。
-- 次の3つを必ず満たすこと。
--   1. 口コミは、承認したものしか読めない
--   2. 投稿されたものは必ず未承認から始まる（投稿者が承認済みにできない）
--   3. 投稿者は、自分の投稿を後から書き換えたり消したりできない
--
-- 実在の人物についての書き込みなので、公開前に運営が内容を確認する。
-- 承認は Supabase の Table Editor か、下の approve_review() で行う。

create table if not exists public.performer_votes (
    id          bigint generated always as identity primary key,
    slug        text        not null,
    voter_hash  text        not null,
    created_at  timestamptz not null default now(),

    -- 同じ人が同じ相手に何度も入れられないようにする。
    -- voter_hash はブラウザ側で作る識別子で、個人を特定するものではない。
    unique (slug, voter_hash)
);

create index if not exists performer_votes_slug_idx on public.performer_votes (slug);

create table if not exists public.performer_reviews (
    id          bigint generated always as identity primary key,
    slug        text        not null,
    nickname    text,
    body        text        not null,
    status      text        not null default 'pending',
    created_at  timestamptz not null default now(),
    reviewed_at timestamptz,

    constraint performer_reviews_status_check
        check (status in ('pending', 'approved', 'rejected')),
    constraint performer_reviews_body_length
        check (char_length(body) between 4 and 400),
    constraint performer_reviews_nickname_length
        check (nickname is null or char_length(nickname) <= 20)
);

create index if not exists performer_reviews_slug_idx
    on public.performer_reviews (slug) where status = 'approved';

create index if not exists performer_reviews_pending_idx
    on public.performer_reviews (created_at) where status = 'pending';

-- 承認済みの口コミの件数と、投票数をまとめて読むための眺め。
create or replace view public.performer_stats as
select
    slug,
    sum(votes)   as votes,
    sum(reviews) as reviews
from (
    select slug, count(*) as votes, 0 as reviews
      from public.performer_votes group by slug
    union all
    select slug, 0, count(*)
      from public.performer_reviews where status = 'approved' group by slug
) as combined
group by slug;

-- ここから RLS。
alter table public.performer_votes   enable row level security;
alter table public.performer_reviews enable row level security;

drop policy if exists "誰でも投票数を読める"        on public.performer_votes;
drop policy if exists "誰でも投票できる"            on public.performer_votes;
drop policy if exists "承認済みの口コミだけ読める"  on public.performer_reviews;
drop policy if exists "誰でも投稿できる"            on public.performer_reviews;

create policy "誰でも投票数を読める"
    on public.performer_votes for select
    to anon, authenticated
    using (true);

create policy "誰でも投票できる"
    on public.performer_votes for insert
    to anon, authenticated
    with check (char_length(slug) between 1 and 200
            and char_length(voter_hash) between 8 and 64);

create policy "承認済みの口コミだけ読める"
    on public.performer_reviews for select
    to anon, authenticated
    using (status = 'approved');

-- 投稿は必ず未承認から。status を指定して承認済みで入れることはできない。
create policy "誰でも投稿できる"
    on public.performer_reviews for insert
    to anon, authenticated
    with check (status = 'pending' and reviewed_at is null);

-- 更新と削除のポリシーは作らない。つまり anon は書き換えも削除もできない。

-- 運営が承認・却下するときに使う。Supabase の SQL Editor から呼ぶ。
create or replace function public.approve_review(review_id bigint)
returns void language sql security definer set search_path = public as $$
    update public.performer_reviews
       set status = 'approved', reviewed_at = now()
     where id = review_id;
$$;

create or replace function public.reject_review(review_id bigint)
returns void language sql security definer set search_path = public as $$
    update public.performer_reviews
       set status = 'rejected', reviewed_at = now()
     where id = review_id;
$$;

-- PostgreSQL では関数の実行権限が既定で PUBLIC に付く。
-- anon と authenticated から取り消すだけでは PUBLIC 経由で誰でも呼べてしまう。
-- 実際、これを書き忘れていたときは匿名キーで approve_review() を呼べてしまい、
-- 投稿者が自分の口コミを承認済みにできる状態だった。PUBLIC から取り消すこと。
revoke execute on function public.approve_review(bigint) from public;
revoke execute on function public.reject_review(bigint)  from public;
revoke execute on function public.approve_review(bigint) from anon, authenticated;
revoke execute on function public.reject_review(bigint)  from anon, authenticated;

-- 今後この方式で関数を足しても、同じ穴が開かないようにしておく。
alter default privileges in schema public revoke execute on functions from public;
