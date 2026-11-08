-- Expose only the public fixture kickoff timestamp through the existing RPC.
-- The paywall, current-ticket filtering, fields and access model remain intact.

begin;

-- PostgreSQL cannot change a function's RETURNS TABLE columns with CREATE OR
-- REPLACE, so recreate it atomically and restore explicit grants below.
drop function public.get_daily_picks();

create function public.get_daily_picks()
returns table(
    fixture_id bigint,
    home_team text,
    away_team text,
    league text,
    ticket_date date,
    kickoff_utc timestamptz,
    final_confidence numeric,
    market text,
    odds numeric,
    rationale text,
    is_unlocked boolean
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    caller_is_unlocked boolean := false;
begin
    select exists (
        select 1
        from public.subscriptions subscription
        where subscription.user_id = auth.uid()
          and subscription.status = 'active'
          and subscription.started_at <= now()
          and subscription.expires_at > now()
    ) into caller_is_unlocked;

    return query
    with current_ticket as (
        select pt.id, pt.ticket_date, pt.final_confidence
        from public.prediction_tickets pt
        where pt.status = 'published'
          and pt.ticket_date = (timezone('Africa/Nairobi', now()))::date
        order by pt.created_at desc, pt.id desc
        limit 1
    )
    select
        ts.fixture_id::bigint,
        ts.home_team::text,
        ts.away_team::text,
        ts.league::text,
        ticket.ticket_date::date,
        ts.kickoff_utc,
        ticket.final_confidence::numeric,
        case when caller_is_unlocked then ts.market::text else null end,
        case when caller_is_unlocked then ts.odds::numeric else null end,
        case when caller_is_unlocked then ts.rationale::text else null end,
        caller_is_unlocked
    from current_ticket ticket
    join public.ticket_selections ts on ts.ticket_id = ticket.id
    order by ts.id;
end;
$$;

revoke all on function public.get_daily_picks() from public;
grant execute on function public.get_daily_picks() to anon;
grant execute on function public.get_daily_picks() to authenticated;
grant execute on function public.get_daily_picks() to service_role;

comment on function public.get_daily_picks() is
    'Current Nairobi-day published fixtures; kickoff is public, while market/odds/rationale require an active pass.';

notify pgrst, 'reload schema';
commit;
