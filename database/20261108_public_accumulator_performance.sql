-- Add the original ticket identifier needed for whole-accumulator accounting.
-- This is an additive safe-view change: no prediction text, private logs,
-- customer data, financial records, table privileges, or RLS policies are changed.

begin;

create or replace view public.ticket_selections_safe
with (security_barrier = true)
as
select
    ts.id,
    ts.ticket_date,
    ts.fixture_id,
    ts.home_team,
    ts.away_team,
    ts.league,
    ts.outcome,
    ts.home_score,
    ts.away_score,
    case
        when ts.outcome in ('win', 'loss', 'void') then ts.market
        else null
    end as market,
    case
        when ts.outcome in ('win', 'loss', 'void') then ts.odds
        else null
    end as odds,
    case
        when ts.outcome in ('win', 'loss', 'void') then ts.rationale
        else null
    end as rationale,
    ts.ticket_id
from public.ticket_selections ts
join public.prediction_tickets pt on pt.id = ts.ticket_id
where pt.status = 'published';

comment on view public.ticket_selections_safe is
    'Public fixture and settled-result projection. Original ticket IDs support complete accumulator accounting; protected current analysis remains gated by get_daily_picks.';

notify pgrst, 'reload schema';
commit;
