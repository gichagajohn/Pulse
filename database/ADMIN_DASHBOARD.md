# Football Pulse admin dashboard

## Components

- `/admin.html` — private, responsive dashboard UI. It is intentionally not linked from the public navigation.
- `/admin.js` — Supabase authentication, RPC loading, tables, ticket expansion, filtering, pagination, and CSV export.
- `/admin.css` — dashboard styling.
- `20261106_admin_dashboard.sql` — admin allowlist, admin-only RPC API, payment read model, and `pending_payments` RLS hardening.

## Security model

The browser receives only the existing public Supabase anonymous key. It never receives a service-role key.

Every private RPC:

1. Requires an authenticated Supabase session.
2. Checks `public.is_admin()` inside the security-definer function.
3. Raises SQLSTATE `42501` when the caller is not in `public.admin_users`.
4. Uses `SET search_path = ''` and fully qualified objects.
5. Is revoked from `PUBLIC` and `anon`, and granted only to `authenticated` and `service_role`.

Direct anonymous/authenticated reads and writes on `admin_users` and `admin_payment_records` are revoked. On `pending_payments`, anonymous access is revoked and authenticated users receive only a tightly scoped INSERT policy: their own user ID, `pending` status, and the authorised daily/weekly amounts. This preserves the existing STK-push flow. Users cannot SELECT, UPDATE, or DELETE payment rows. Callback/status Edge Functions use `service_role`, which bypasses RLS.

Do not weaken these controls by adding a public SELECT policy on `pending_payments`, broadening the INSERT policy, or putting service credentials in `admin.js`.

## Apply the database migration

Apply `20261106_admin_dashboard.sql` as a Supabase migration or in the Supabase SQL editor. It is transactional and contains no personal email address.

## Allowlist an administrator

After the person has created a normal Football Pulse account, run this in the trusted Supabase SQL editor, replacing the placeholder:

```sql
insert into public.admin_users (user_id)
select id from auth.users
where lower(email) = lower('ADMIN_EMAIL_HERE')
on conflict (user_id) do nothing;
```

Verify that exactly one row exists:

```sql
select a.user_id, a.created_at
from public.admin_users a
join auth.users u on u.id = a.user_id
where lower(u.email) = lower('ADMIN_EMAIL_HERE');
```

To remove an administrator without deleting their customer account:

```sql
delete from public.admin_users
where user_id = (
  select id from auth.users where lower(email) = lower('ADMIN_EMAIL_HERE')
);
```

Never add an open sign-up/first-user-claims-admin function. Admin grants must remain an explicit trusted-database operation.

## Revenue semantics

- **Received revenue** is the sum of recorded `subscriptions.amount` for `success`, `active`, and `expired` rows. Active and expired represent paid access lifecycle states; pending and failed attempts are excluded.
- `pending_payments` rows appear as provider attempts when no subscription has the same checkout ID. They are not counted as received revenue.
- A successful provider attempt without a matching subscription is surfaced as **Needs reconciliation** instead of being silently added to or omitted from totals.
- Today uses the `Africa/Nairobi` calendar date. The 30-day total is a rolling interval.
- Historical amounts come from each transaction, not from current plan prices.

## Dashboard features

- Overview: total/today/30-day revenue, users, active passes, tickets, paid purchases, win rate, 14-day revenue, plan/status breakdowns, and data-quality warnings.
- Full tickets: original ticket text, selections, odds, rationales, outcomes, scores, stored-vs-actual selection counts, search/status filters, and pagination.
- Accounts: name, email, phone, user ID, email confirmation, creation, last sign-in, paid purchases, spending, active pass, and admin role.
- Purchases: customer, plan, actual amount, status, source, provider references, and access dates.
- Current-page CSV exports for all three record sections. Spreadsheet formula injection is neutralised.
- Read-only by design: no deletes, refunds, password changes, payment edits, or role changes in the browser.

## Checks

```sh
node --test tests/auth_password_reset.test.cjs tests/admin_dashboard.test.cjs tests/admin_auth_flow.test.cjs
node --check admin.js
```

The JavaScript tests cover formatting, pagination, CSV injection protection, safe DOM rendering, element IDs, fixed search paths, admin gates, RLS hardening, and revenue semantics. Database integration/access checks must also be run against the deployed Supabase project before using the dashboard.
