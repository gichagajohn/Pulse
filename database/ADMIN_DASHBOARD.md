# Football Pulse admin dashboard

## Components

- `/admin.html` — private, responsive dashboard UI. It is intentionally not linked from the public navigation.
- `/admin.js` — Supabase authentication, RPC loading, tables, ticket expansion, filtering, pagination, and CSV export.
- `/admin-strategy.js` — safe, aggregate-only Model lab rendering and nullable metric formatting.
- `/admin.css` — dashboard styling.
- `/model-validation.js` — dependency-free provenance gate and conservative-value mathematics shared by tests and intended for the prediction worker (see `database/MODEL_INTELLIGENCE.md`).
- `20261106_admin_dashboard.sql` — admin allowlist, admin-only RPC API, payment read model, and `pending_payments` RLS hardening.
- `20261108_admin_strategy_report.sql` — allowlisted-admin production/shadow aggregate reporting; no raw shadow-log API.
- `20261109_model_intelligence_diagnostics.sql` — allowlisted-admin Model health & provenance aggregates (kickoff/price timestamps, calibration readiness, model-vs-market scoring, selection bias, shadow/closing coverage); activates nothing.
- `database/MODEL_INTELLIGENCE.md` — staged model-intelligence implementation contract (provenance gates → shadow challenger → holdout-gated promotion).
- `20261108_access_pricing_100_500.sql` — current Daily KSh 100 and Weekly KSh 500 pending-payment policy; historical transaction amounts are not rewritten.

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

The Model lab uses `public.admin_strategy_report(integer)`. It checks the same allowlist and returns JSON aggregates only. Its `_admin_strategy_one(text, date)` helper is revoked from `PUBLIC`, `anon`, and `authenticated`. Neither function grants SELECT on `model_prediction_logs`, creates an RLS policy, nor returns teams, fixture IDs, features, rationales, or individual shadow picks. An authenticated non-admin receives SQLSTATE `42501` even though the outer function is executable by the `authenticated` role.

The Model health & provenance panel uses `public.admin_model_intelligence_report(integer)`. It applies the same allowlist pattern, returns aggregates only (counts, means, calibration readiness, scoring versus the no-vig market, selection-bias buckets, shadow/closing coverage), and activates nothing. It returns no team names, fixture identifiers outside aggregates, features, rationales, or individual rows.

## Apply the database migrations

Apply `20261106_admin_dashboard.sql` first and then `20261108_admin_strategy_report.sql` as Supabase migrations or in the Supabase SQL editor. Both are transactional and contain no personal email address. The second migration is reporting-only: it does not activate `robust_conservative_v1`, alter optimizer selections, or modify official tickets.

`20261109_model_intelligence_diagnostics.sql` is likewise transactional and reporting-only: it adds `public.admin_model_intelligence_report(integer)` for the allowlisted admin Model lab health panel. It does not activate `robust_conservative_v1`, alter optimizer selections, backfill timestamps, or modify official tickets. It was applied to production on 2026-11-09.

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
- Historical amounts come from each transaction, not from current plan prices. New access payments are Daily KSh 100 and Weekly KSh 500 under `20261108_access_pricing_100_500.sql`; older KSh 1,000/KSh 5,000 and earlier KSh 10 records remain unchanged for audit and revenue accuracy.

## Dashboard features

- Overview: total/today/30-day revenue, users, active passes, tickets, paid purchases, win rate, 14-day revenue, plan/status breakdowns, and data-quality warnings.
- Model lab: model health & provenance diagnostics (kickoff/price timestamp failures, calibration readiness, model-vs-market Brier/log-loss, selection-bias buckets, shadow and closing-price coverage), plus production-optimizer versus private `robust_conservative_v1` sample counts, hit rate, flat-stake ROI/profit, odds, break-even win rate, maximum drawdown, Brier score, log loss, CLV coverage/results, complete daily accumulators, and market/league/odds-band segments.
- Full tickets: original ticket text, selections, odds, rationales, outcomes, scores, stored-vs-actual selection counts, search/status filters, and pagination.
- Accounts: name, email, phone, user ID, email confirmation, creation, last sign-in, paid purchases, spending, active pass, and admin role.
- Purchases: customer, plan, actual amount, status, source, provider references, and access dates.
- Current-page CSV exports for all three record sections. Spreadsheet formula injection is neutralised.
- Read-only by design: no deletes, refunds, password changes, payment edits, or role changes in the browser.

## Model lab metric semantics

- **Production** means rows with `strategy = 'production'` (including legacy NULL strategy) and `selected = true`. It is optimizer output, not proof that the Auditor/Decision published an official ticket.
- **Shadow** means `strategy = 'robust_conservative_v1'` and `shadow_selected = true`. It remains private and inactive.
- The latest row per ticket date, fixture, market, and strategy is used. The date selector is inclusive and capped at 3,650 days.
- Singles use one flat unit each. Wins return decimal odds, losses return zero, and void/DNB-push rows return one unit. Hit rate excludes pushes; ROI divides net profit by total bets.
- Accumulators are evaluated only when every selected leg for that ticket date is settled with a valid price. A losing leg makes the return zero; void legs are removed from effective odds; an all-void accumulator returns stake.
- Maximum drawdown is the largest decline from the prior running equity peak, including a starting equity of zero. It is chronological and descriptive, not a risk forecast.
- Brier score and log loss use settled decisive selected rows with valid probabilities. Production displays model probability. Shadow displays robust probability when present, otherwise model probability. Empty samples remain unavailable.
- CLV is `taken_odds / closing_odds - 1`. Accumulator CLV is computed only when every leg has a closing price. Missing coverage is displayed explicitly and never converted into a profitable result.
- Segment tables use settled singles only. Small or missing samples trigger a warning; this dashboard never activates a strategy or claims that a small sample proves an edge.

## Checks

```sh
node --test tests/*.test.cjs
node --check admin.js
node --check admin-strategy.js
```

The JavaScript tests cover formatting, pagination, CSV injection protection, safe DOM rendering, element IDs, fixed search paths, admin gates, RLS hardening, revenue semantics, aggregate-only Model lab access, segment merging, nullable metrics, DNB-push SQL, and honest empty states. Database integration/access checks must also be run against the deployed Supabase project before using the dashboard.
