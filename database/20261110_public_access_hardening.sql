-- Public-safe ticket endpoints are read-only. This migration makes the
-- deployed view definition reproducible and closes inherited/default DML
-- grants without changing tickets, selections, outcomes, or RLS policies.
-- The SECURITY DEFINER outcome helper remains available to the database-owned
-- settlement trigger/service role, but not to browser roles.

begin;

create or replace view public.prediction_tickets_safe
with (security_barrier = true)
as
select
    pt.id,
    pt.ticket_date,
    pt.status,
    pt.combined_odds,
    pt.selection_count,
    pt.final_confidence,
    pt.risk_level,
    pt.outcome,
    pt.created_at
from public.prediction_tickets pt;

revoke all on table public.prediction_tickets_safe from public, anon, authenticated;
grant select on table public.prediction_tickets_safe to anon, authenticated;

-- This view is not currently automatically updatable, but make its read-only
-- contract explicit instead of relying on the current join definition.
revoke all on table public.ticket_selections_safe from public, anon, authenticated;
grant select on table public.ticket_selections_safe to anon, authenticated;

-- This SECURITY DEFINER helper updates the ticket's summary outcome. It is
-- intended for the settlement trigger, not as a public PostgREST RPC.
revoke all on function public.refresh_prediction_ticket_outcome(bigint)
    from public, anon, authenticated;
revoke all on function public.sync_prediction_ticket_outcome()
    from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;
