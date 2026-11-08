-- Current access prices: Daily KSh 100, Weekly KSh 500.
-- Historical pending/subscription amounts are intentionally not modified.

begin;

drop policy if exists "Users can create own pending payments" on public.pending_payments;

create policy "Users can create own pending payments"
on public.pending_payments
for insert
to authenticated
with check (
  (select auth.uid()) = user_id
  and status = 'pending'
  and (
    (plan = 'daily' and amount = 100)
    or (plan = 'weekly' and amount = 500)
  )
);

comment on policy "Users can create own pending payments" on public.pending_payments is
  'Own pending Daily KSh 100 or Weekly KSh 500 only; no client SELECT/UPDATE/DELETE.';

commit;
