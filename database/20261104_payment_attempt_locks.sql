-- Server-only per-user lock for STK requests.
-- This prevents concurrent tabs/devices from sending duplicate prompts before
-- the provider checkout ID can be persisted to pending_payments.
-- Unknown provider outcomes intentionally keep the lock until support or a
-- later status reconciliation resolves the attempt; do not add an automatic TTL.

begin;

create table if not exists public.payment_attempt_locks (
    user_id uuid primary key references auth.users(id) on delete cascade,
    external_reference text not null unique,
    plan text not null,
    amount integer not null,
    checkout_request_id text unique,
    status text not null default 'initiating',
    created_at timestamptz not null default now(),
    constraint payment_attempt_locks_plan_amount_check check (
        (plan = 'daily' and amount = 100)
        or (plan = 'weekly' and amount = 500)
    ),
    constraint payment_attempt_locks_status_check check (
        status in ('initiating', 'pending')
    )
);

alter table public.payment_attempt_locks enable row level security;
revoke all on table public.payment_attempt_locks from public, anon, authenticated;
grant all on table public.payment_attempt_locks to service_role;

comment on table public.payment_attempt_locks is
    'Private in-flight STK reservations; only service-role Edge Functions may read or mutate. Terminal attempts release the per-user lock after reconciliation.';

commit;
