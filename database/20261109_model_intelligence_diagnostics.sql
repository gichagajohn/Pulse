-- Model-intelligence diagnostics for allowlisted admins.
-- Read-only aggregates over the production optimizer logs: provenance health,
-- calibration readiness, model-vs-market scoring, selection bias, and shadow
-- experiment coverage. Returns no team names, no fixture identifiers outside
-- aggregates, and no individual rows. Does not activate anything.

begin;

create or replace function public.admin_model_intelligence_report(
    p_days integer default 90
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
    safe_days integer := least(greatest(coalesce(p_days, 90), 1), 3650);
    start_date date := current_date - safe_days + 1;
    result jsonb;
begin
    if not public.is_admin() then
        raise exception 'Admin access required' using errcode = '42501';
    end if;

    with ranked as (
        select
            l.*,
            row_number() over (
                partition by l.ticket_date, l.fixture_id, l.market, coalesce(l.strategy, 'production')
                order by l.created_at desc, l.id desc
            ) as position
        from public.model_prediction_logs l
        where coalesce(l.strategy, 'production') = 'production'
          and l.ticket_date >= start_date
    ), logs as (
        select
            l.*,
            case
                when (l.feature_snapshot ->> 'odds_last_update') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}'
                    then (l.feature_snapshot ->> 'odds_last_update')::timestamptz
            end as price_updated_at,
            nullif(l.feature_snapshot -> 'probability_calibration' ->> 'samples', '')::integer as calibration_samples,
            coalesce((l.feature_snapshot -> 'probability_calibration' ->> 'active')::boolean, false) as calibration_active
        from ranked l
        where l.position = 1
    ), provenance as (
        select
            count(*) as candidate_rows,
            count(*) filter (where outcome in ('win', 'loss', 'void')) as settled_candidate_rows,
            count(*) filter (where kickoff_utc is null) as missing_kickoff,
            count(*) filter (where bookmaker_odds is null or bookmaker_odds <= 1) as missing_price,
            count(*) filter (where market_implied_prob is null or market_implied_prob <= 0 or market_implied_prob >= 1) as missing_market_prob,
            count(*) filter (where price_updated_at is null) as price_update_missing,
            count(*) filter (where price_updated_at > created_at) as price_after_prediction,
            count(*) filter (where eligible is true) as eligible_rows,
            count(*) filter (
                where eligible is true and (
                    kickoff_utc is null
                    or bookmaker_odds is null or bookmaker_odds <= 1
                    or price_updated_at is null or price_updated_at > created_at
                )
            ) as eligible_unverifiable,
            max(extract(epoch from (price_updated_at - created_at))) filter (where price_updated_at > created_at) as max_future_price_skew_seconds,
            count(distinct fixture_id) filter (where outcome in ('win', 'loss')) as distinct_settled_fixtures,
            count(distinct ticket_date) filter (where outcome in ('win', 'loss')) as settled_dates
        from logs
    ), settled as (
        select *
        from logs
        where outcome in ('win', 'loss')
          and model_prob > 0 and model_prob < 1
    ), scoring as (
        select
            count(*) as n,
            avg(power(model_prob - (outcome = 'win')::integer, 2)) as model_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then model_prob else 1.0 - model_prob end
            )))) as model_log_loss,
            avg(model_prob) as model_mean_probability,
            avg((outcome = 'win')::integer) as observed_win_rate,
            count(*) filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_n,
            avg(power(market_implied_prob - (outcome = 'win')::integer, 2))
                filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then market_implied_prob else 1.0 - market_implied_prob end
            )))) filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_log_loss
        from settled
    ), scoring_clean as (
        select
            count(*) as n,
            avg(power(model_prob - (outcome = 'win')::integer, 2)) as model_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then model_prob else 1.0 - model_prob end
            )))) as model_log_loss,
            avg(power(market_implied_prob - (outcome = 'win')::integer, 2))
                filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then market_implied_prob else 1.0 - market_implied_prob end
            )))) filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_log_loss
        from settled
        where price_updated_at is not null
          and price_updated_at <= created_at
    ), calibration as (
        select
            count(*) filter (where calibration_active) as active_rows,
            count(*) filter (where not calibration_active) as inactive_rows,
            max(calibration_samples) as max_observed_samples,
            200 as min_samples_required,
            30 as min_per_class_required
        from logs
    ), buckets as (
        select
            case
                when selected then 'selected'
                when eligible then 'eligible_unselected'
                else 'ineligible'
            end as bucket,
            count(*) as n,
            count(*) filter (where outcome = 'win') as wins,
            count(*) filter (where outcome = 'loss') as losses,
            avg(expected_value) filter (where expected_value is not null) as mean_claimed_ev,
            avg(model_prob) as mean_model_prob,
            avg(market_implied_prob) filter (where market_implied_prob > 0 and market_implied_prob < 1) as mean_market_prob,
            avg((outcome = 'win')::integer) as observed_win_rate,
            sum(case when outcome = 'win' then bookmaker_odds - 1.0 else -1.0 end)
                / nullif(count(*), 0) as flat_roi
        from logs
        where outcome in ('win', 'loss')
        group by 1
    ), bucket_stats as (
        select
            bucket,
            n,
            wins,
            losses,
            mean_claimed_ev,
            mean_model_prob,
            mean_market_prob,
            observed_win_rate,
            flat_roi,
            case
                when wins + losses = 0 then null
                else greatest(0.0, (
                    (wins::double precision / (wins + losses) + 1.959964 * 1.959964 / (2 * (wins + losses)))
                    / (1 + 1.959964 * 1.959964 / (wins + losses))
                    - 1.959964 * sqrt(
                        (wins::double precision / (wins + losses)) * (1 - wins::double precision / (wins + losses)) / (wins + losses)
                        + 1.959964 * 1.959964 / (4 * (wins + losses) * (wins + losses))
                    ) / (1 + 1.959964 * 1.959964 / (wins + losses))
                ))
            end as wilson_low,
            case
                when wins + losses = 0 then null
                else least(1.0, (
                    (wins::double precision / (wins + losses) + 1.959964 * 1.959964 / (2 * (wins + losses)))
                    / (1 + 1.959964 * 1.959964 / (wins + losses))
                    + 1.959964 * sqrt(
                        (wins::double precision / (wins + losses)) * (1 - wins::double precision / (wins + losses)) / (wins + losses)
                        + 1.959964 * 1.959964 / (4 * (wins + losses) * (wins + losses))
                    ) / (1 + 1.959964 * 1.959964 / (wins + losses))
                ))
            end as wilson_high
        from buckets
    ), high_ev as (
        select
            count(*) as n,
            avg(expected_value) filter (where expected_value is not null) as mean_claimed_ev,
            avg(model_prob) as mean_model_prob,
            avg(market_implied_prob) filter (where market_implied_prob > 0 and market_implied_prob < 1) as mean_market_prob,
            avg((outcome = 'win')::integer) as observed_win_rate,
            sum(case when outcome = 'win' then bookmaker_odds - 1.0 else -1.0 end)
                / nullif(count(*), 0) as flat_roi,
            count(*) filter (where selected) as selected_rows
        from logs
        where outcome in ('win', 'loss')
          and expected_value >= 0.10
    ), challenger as (
        select
            count(*) filter (where robust_model_prob > 0 and robust_model_prob < 1) as robust_probability_rows,
            count(*) filter (where shadow_selected is true) as shadow_selected_rows,
            count(*) filter (where closing_bookmaker_odds > 1) as closing_price_rows,
            count(*) as rows
        from logs
    ), version_integrity as (
        select
            count(*) as versions,
            count(*) filter (where v.integrity_status = 'legacy_unverified') as legacy_unverified
        from public.prediction_ticket_versions v
        where v.ticket_date >= start_date
    )
    select jsonb_build_object(
        'generated_at', now(),
        'window_start', start_date,
        'window_end', current_date,
        'provenance', (select to_jsonb(provenance) from provenance),
        'calibration', (select to_jsonb(calibration) from calibration),
        'scoring', (select to_jsonb(scoring) || jsonb_build_object(
            'timestamp_consistent', (select to_jsonb(scoring_clean) from scoring_clean)
        ) from scoring),
        'selection_bias', coalesce(
            (select jsonb_object_agg(bucket, to_jsonb(bucket_stats) - 'bucket') from bucket_stats),
            '{}'::jsonb
        ),
        'high_ev_10_plus', (select to_jsonb(high_ev) from high_ev),
        'challenger', (select to_jsonb(challenger) || jsonb_build_object(
            'closing_price_coverage',
            case when rows > 0 then closing_price_rows::double precision / rows else null end
        ) from challenger),
        'version_integrity', (select to_jsonb(version_integrity) from version_integrity),
        'methodology', jsonb_build_object(
            'scope', 'Production optimizer logs only; deduplicated to the latest row per ticket_date, fixture_id, market and strategy.',
            'official_comparison', 'Original published tickets are reported separately and by ticket_id; optimizer output is not necessarily a published selection.',
            'stake', 'Hypothetical one flat unit per settled candidate; unselected rows are counterfactual diagnostics, not realized profit.',
            'voids', 'Excluded from wins, losses, hit rates, ROI and probability scoring.',
            'wilson', '95% Wilson score interval on wins over wins+losses; descriptive only.',
            'activation', 'Diagnostics only. Nothing here activates a model, strategy, or publication.'
        )
    ) into result;
    return result;
end;
$$;

revoke all on function public.admin_model_intelligence_report(integer) from public;
revoke all on function public.admin_model_intelligence_report(integer) from anon;
grant execute on function public.admin_model_intelligence_report(integer) to authenticated;
grant execute on function public.admin_model_intelligence_report(integer) to service_role;

comment on function public.admin_model_intelligence_report(integer) is
    'Allowlisted-admin aggregated model-intelligence diagnostics: provenance, calibration, scoring vs market, selection bias, and shadow coverage. No team-level data; activates nothing.';

commit;
