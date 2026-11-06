-- Football Pulse admin dashboard API and payment-table hardening.
-- Run as a Supabase migration. No administrator email is stored in this file.

begin;

create table if not exists public.admin_users (
    user_id uuid primary key references auth.users(id) on delete cascade,
    created_at timestamptz not null default now()
);

alter table public.admin_users enable row level security;
revoke all on table public.admin_users from anon;
revoke all on table public.admin_users from authenticated;

-- Lock payment records from public reads/writes. The STK-push function uses the
-- signed-in user's JWT for its insert, so preserve only that narrow capability.
-- Service-role callback/status functions continue to bypass RLS.
alter table public.pending_payments enable row level security;
revoke all on table public.pending_payments from anon;
revoke all on table public.pending_payments from authenticated;
grant insert on table public.pending_payments to authenticated;

drop policy if exists "Users can create own pending payments" on public.pending_payments;
create policy "Users can create own pending payments"
on public.pending_payments
for insert
to authenticated
with check (
    (select auth.uid()) = user_id
    and status = 'pending'
    and (
        (plan = 'daily' and amount = 1000)
        or (plan = 'weekly' and amount = 5000)
    )
);

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
    select exists (
        select 1
        from public.admin_users
        where user_id = (select auth.uid())
    );
$$;

revoke all on function public.is_admin() from public;
revoke all on function public.is_admin() from anon;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.is_admin() to service_role;

-- A canonical read model for purchase attempts. Subscription rows are the
-- confirmed revenue ledger. Pending-payment rows are included only when no
-- subscription carries the same provider checkout ID, preventing direct duplicates.
create or replace view public.admin_payment_records
with (security_barrier = true) as
select
    'subscription:' || s.id::text as payment_id,
    'subscription'::text as source,
    s.id::text as source_id,
    s.user_id,
    s.plan,
    coalesce(s.amount, 0)::numeric as amount,
    s.status,
    s.status in ('success', 'active', 'expired') as is_paid,
    s.phone_number,
    s.mpesa_checkout_request_id as checkout_request_id,
    coalesce(s.mpesa_receipt_number, s.mpesa_checkout_request_id) as reference,
    s.started_at,
    s.expires_at,
    s.created_at,
    coalesce(s.started_at, s.created_at) as recorded_at
from public.subscriptions s
union all
select
    'pending:' || p.id::text as payment_id,
    'pending_payment'::text as source,
    p.id::text as source_id,
    p.user_id,
    p.plan,
    p.amount::numeric as amount,
    p.status,
    false as is_paid,
    null::text as phone_number,
    p.checkout_request_id,
    coalesce(p.external_reference, p.checkout_request_id) as reference,
    null::timestamptz as started_at,
    null::timestamptz as expires_at,
    p.created_at,
    p.created_at as recorded_at
from public.pending_payments p
where not exists (
    select 1
    from public.subscriptions s
    where nullif(s.mpesa_checkout_request_id, '') is not null
      and s.mpesa_checkout_request_id = p.checkout_request_id
);

revoke all on public.admin_payment_records from public;
revoke all on public.admin_payment_records from anon;
revoke all on public.admin_payment_records from authenticated;
grant select on public.admin_payment_records to service_role;

create or replace function public.admin_dashboard_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    result jsonb;
    nairobi_today date := (timezone('Africa/Nairobi', now()))::date;
begin
    if not public.is_admin() then
        raise exception 'Admin access required' using errcode = '42501';
    end if;

    select jsonb_build_object(
        'generated_at', now(),
        'metrics', jsonb_build_object(
            'total_revenue', coalesce((
                select sum(p.amount) from public.admin_payment_records p
                where p.source = 'subscription' and p.is_paid
            ), 0),
            'revenue_today', coalesce((
                select sum(p.amount) from public.admin_payment_records p
                where p.source = 'subscription' and p.is_paid
                  and (timezone('Africa/Nairobi', p.recorded_at))::date = nairobi_today
            ), 0),
            'revenue_30d', coalesce((
                select sum(p.amount) from public.admin_payment_records p
                where p.source = 'subscription' and p.is_paid
                  and p.recorded_at >= now() - interval '30 days'
            ), 0),
            'total_users', (select count(*) from auth.users),
            'new_users_30d', (
                select count(*) from auth.users u
                where u.created_at >= now() - interval '30 days'
            ),
            'active_passes', (
                select count(distinct s.user_id) from public.subscriptions s
                where s.status = 'active'
                  and s.started_at <= now()
                  and s.expires_at > now()
            ),
            'total_tickets', (select count(*) from public.prediction_tickets),
            'published_tickets', (
                select count(*) from public.prediction_tickets t
                where t.status = 'published'
            ),
            'successful_purchases', (
                select count(*) from public.admin_payment_records p
                where p.source = 'subscription' and p.is_paid
            ),
            'pending_purchases', (
                select count(*) from public.admin_payment_records p
                where p.status = 'pending'
            ),
            'failed_purchases', (
                select count(*) from public.admin_payment_records p
                where p.status = 'failed'
            ),
            'settled_selections', (
                select count(*) from public.ticket_selections s
                where s.outcome in ('win', 'loss')
            ),
            'win_rate', coalesce((
                select round(
                    100.0 * count(*) filter (where s.outcome = 'win')
                    / nullif(count(*) filter (where s.outcome in ('win', 'loss')), 0),
                    1
                )
                from public.ticket_selections s
            ), 0),
            'unlinked_successes', (
                select count(*) from public.admin_payment_records p
                where p.source = 'pending_payment' and p.status = 'success'
            ),
            'ticket_mismatches', (
                select count(*)
                from (
                    select t.id
                    from public.prediction_tickets t
                    left join public.ticket_selections s on s.ticket_id = t.id
                    where t.status = 'published'
                    group by t.id, t.selection_count
                    having coalesce(t.selection_count, 0) <> count(s.id)
                ) mismatched
            )
        ),
        'revenue_by_day', (
            select coalesce(jsonb_agg(day_data order by day_data.day), '[]'::jsonb)
            from (
                select
                    days.day,
                    coalesce(sum(p.amount), 0) as amount,
                    count(p.payment_id) as purchases
                from (
                    select generate_series(
                        nairobi_today - 13,
                        nairobi_today,
                        interval '1 day'
                    )::date as day
                ) days
                left join public.admin_payment_records p
                    on p.source = 'subscription'
                   and p.is_paid
                   and (timezone('Africa/Nairobi', p.recorded_at))::date = days.day
                group by days.day
            ) day_data
        ),
        'revenue_by_plan', (
            select coalesce(jsonb_agg(plan_data order by plan_data.plan), '[]'::jsonb)
            from (
                select
                    p.plan,
                    coalesce(sum(p.amount), 0) as amount,
                    count(*) as purchases
                from public.admin_payment_records p
                where p.source = 'subscription' and p.is_paid
                group by p.plan
            ) plan_data
        ),
        'purchases_by_status', (
            select coalesce(jsonb_agg(status_data order by status_data.status), '[]'::jsonb)
            from (
                select p.status, count(*) as purchases
                from public.admin_payment_records p
                group by p.status
            ) status_data
        )
    ) into result;

    return result;
end;
$$;

create or replace function public.admin_list_users(
    p_search text,
    p_limit integer,
    p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    result jsonb;
    normalized_search text := lower(trim(coalesce(p_search, '')));
    safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
    safe_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
    if not public.is_admin() then
        raise exception 'Admin access required' using errcode = '42501';
    end if;

    with filtered as (
        select
            u.id,
            coalesce(u.email, p.email) as email,
            coalesce(nullif(p.full_name, ''), u.raw_user_meta_data->>'full_name') as full_name,
            coalesce(nullif(p.phone_number, ''), u.raw_user_meta_data->>'phone_number') as phone_number,
            u.created_at,
            u.last_sign_in_at,
            u.email_confirmed_at,
            exists(select 1 from public.admin_users a where a.user_id = u.id) as is_admin
        from auth.users u
        left join public.profiles p on p.id = u.id
        where normalized_search = ''
           or lower(coalesce(u.email, p.email, '')) like '%' || normalized_search || '%'
           or lower(coalesce(p.full_name, u.raw_user_meta_data->>'full_name', '')) like '%' || normalized_search || '%'
           or lower(coalesce(p.phone_number, u.raw_user_meta_data->>'phone_number', '')) like '%' || normalized_search || '%'
           or lower(u.id::text) = normalized_search
    ), enriched as (
        select
            f.*,
            coalesce((
                select sum(p.amount) from public.admin_payment_records p
                where p.user_id = f.id and p.source = 'subscription' and p.is_paid
            ), 0) as total_spent,
            (
                select count(*) from public.admin_payment_records p
                where p.user_id = f.id and p.source = 'subscription' and p.is_paid
            ) as purchase_count,
            (
                select max(s.expires_at) from public.subscriptions s
                where s.user_id = f.id and s.status = 'active'
                  and s.started_at <= now() and s.expires_at > now()
            ) as active_pass_expires
        from filtered f
    )
    select jsonb_build_object(
        'total', (select count(*) from filtered),
        'rows', coalesce((
            select jsonb_agg(user_data order by user_data.created_at desc)
            from (
                select * from enriched
                order by created_at desc
                limit safe_limit offset safe_offset
            ) user_data
        ), '[]'::jsonb)
    ) into result;

    return result;
end;
$$;

create or replace function public.admin_list_purchases(
    p_search text,
    p_status text,
    p_limit integer,
    p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    result jsonb;
    normalized_search text := lower(trim(coalesce(p_search, '')));
    normalized_status text := lower(trim(coalesce(p_status, 'all')));
    safe_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
    safe_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
    if not public.is_admin() then
        raise exception 'Admin access required' using errcode = '42501';
    end if;

    with enriched as (
        select
            p.*,
            coalesce(u.email, profile.email) as user_email,
            coalesce(nullif(profile.full_name, ''), u.raw_user_meta_data->>'full_name') as user_name
        from public.admin_payment_records p
        left join auth.users u on u.id = p.user_id
        left join public.profiles profile on profile.id = p.user_id
    ), filtered as (
        select * from enriched e
        where (normalized_status = 'all' or e.status = normalized_status)
          and (
              normalized_search = ''
              or lower(coalesce(e.user_email, '')) like '%' || normalized_search || '%'
              or lower(coalesce(e.user_name, '')) like '%' || normalized_search || '%'
              or lower(coalesce(e.reference, '')) like '%' || normalized_search || '%'
              or lower(coalesce(e.checkout_request_id, '')) like '%' || normalized_search || '%'
              or lower(e.user_id::text) = normalized_search
          )
    )
    select jsonb_build_object(
        'total', (select count(*) from filtered),
        'rows', coalesce((
            select jsonb_agg(purchase_data order by purchase_data.created_at desc nulls last)
            from (
                select * from filtered
                order by created_at desc nulls last
                limit safe_limit offset safe_offset
            ) purchase_data
        ), '[]'::jsonb)
    ) into result;

    return result;
end;
$$;

create or replace function public.admin_list_tickets(
    p_search text,
    p_status text,
    p_limit integer,
    p_offset integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    result jsonb;
    normalized_search text := lower(trim(coalesce(p_search, '')));
    normalized_status text := lower(trim(coalesce(p_status, 'all')));
    safe_limit integer := least(greatest(coalesce(p_limit, 25), 1), 50);
    safe_offset integer := greatest(coalesce(p_offset, 0), 0);
begin
    if not public.is_admin() then
        raise exception 'Admin access required' using errcode = '42501';
    end if;

    with filtered as (
        select t.*
        from public.prediction_tickets t
        where (normalized_status = 'all' or t.status = normalized_status)
          and (
              normalized_search = ''
              or lower(t.ticket_date::text) like '%' || normalized_search || '%'
              or lower(coalesce(t.status, '')) like '%' || normalized_search || '%'
              or lower(coalesce(t.outcome, '')) like '%' || normalized_search || '%'
              or lower(coalesce(t.ticket_text, '')) like '%' || normalized_search || '%'
              or exists (
                  select 1 from public.ticket_selections s
                  where s.ticket_id = t.id
                    and (
                        lower(coalesce(s.home_team, '')) like '%' || normalized_search || '%'
                        or lower(coalesce(s.away_team, '')) like '%' || normalized_search || '%'
                        or lower(coalesce(s.league, '')) like '%' || normalized_search || '%'
                    )
              )
          )
    ), enriched as (
        select
            f.*,
            (select count(*) from public.ticket_selections s where s.ticket_id = f.id) as actual_selection_count,
            coalesce((
                select jsonb_agg(selection_data order by selection_data.id)
                from (
                    select
                        s.id, s.fixture_id, s.home_team, s.away_team, s.league,
                        s.market, s.odds, s.rationale, s.outcome,
                        s.home_score, s.away_score
                    from public.ticket_selections s
                    where s.ticket_id = f.id
                    order by s.id
                ) selection_data
            ), '[]'::jsonb) as selections
        from filtered f
    )
    select jsonb_build_object(
        'total', (select count(*) from filtered),
        'rows', coalesce((
            select jsonb_agg(ticket_data order by ticket_data.ticket_date desc, ticket_data.id desc)
            from (
                select * from enriched
                order by ticket_date desc, id desc
                limit safe_limit offset safe_offset
            ) ticket_data
        ), '[]'::jsonb)
    ) into result;

    return result;
end;
$$;

-- Security-definer APIs must never be callable by anonymous users or PUBLIC.
revoke all on function public.admin_dashboard_overview() from public;
revoke all on function public.admin_dashboard_overview() from anon;
revoke all on function public.admin_list_users(text, integer, integer) from public;
revoke all on function public.admin_list_users(text, integer, integer) from anon;
revoke all on function public.admin_list_purchases(text, text, integer, integer) from public;
revoke all on function public.admin_list_purchases(text, text, integer, integer) from anon;
revoke all on function public.admin_list_tickets(text, text, integer, integer) from public;
revoke all on function public.admin_list_tickets(text, text, integer, integer) from anon;

grant execute on function public.admin_dashboard_overview() to authenticated;
grant execute on function public.admin_dashboard_overview() to service_role;
grant execute on function public.admin_list_users(text, integer, integer) to authenticated;
grant execute on function public.admin_list_users(text, integer, integer) to service_role;
grant execute on function public.admin_list_purchases(text, text, integer, integer) to authenticated;
grant execute on function public.admin_list_purchases(text, text, integer, integer) to service_role;
grant execute on function public.admin_list_tickets(text, text, integer, integer) to authenticated;
grant execute on function public.admin_list_tickets(text, text, integer, integer) to service_role;

comment on table public.admin_users is 'Explicit allowlist for read-only Football Pulse admin APIs.';
comment on view public.admin_payment_records is 'Admin-only canonical purchase ledger; direct client access is revoked.';

commit;
