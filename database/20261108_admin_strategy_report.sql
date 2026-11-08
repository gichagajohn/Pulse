-- Admin-only aggregated production-optimizer vs private-shadow diagnostics.
-- Returns metrics only: no teams, fixture IDs, features, rationales or raw logs.

begin;

create or replace function public._admin_strategy_one(
    p_strategy text,
    p_start_date date
)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
    with ranked as (
        select
            l.*,
            row_number() over (
                partition by l.ticket_date, l.fixture_id, l.market, coalesce(l.strategy, 'production')
                order by l.created_at desc, l.id desc
            ) as position
        from public.model_prediction_logs l
        where coalesce(l.strategy, 'production') = p_strategy
          and l.ticket_date >= p_start_date
    ), logs as (
        select * from ranked where position = 1
    ), selected as (
        select *
        from logs l
        where case when p_strategy = 'production'
            then coalesce(l.selected, false)
            else coalesce(l.shadow_selected, false)
        end
    ), selection_counts as (
        select
            (select count(*) from logs) as candidate_rows,
            (select count(*) from logs where outcome in ('win', 'loss', 'void')) as settled_candidate_rows,
            count(*) as selected_rows,
            count(*) filter (where outcome = 'pending') as pending_selected,
            count(*) filter (where outcome in ('win', 'loss', 'void')) as settled_selected
        from selected
    ), singles as (
        select
            s.id,
            s.ticket_date,
            s.created_at,
            s.fixture_id,
            s.league,
            s.market,
            s.bookmaker_odds as odds,
            s.closing_bookmaker_odds as closing_odds,
            s.outcome,
            case s.outcome
                when 'win' then s.bookmaker_odds
                when 'void' then 1.0
                else 0.0
            end as gross_return,
            (case s.outcome
                when 'win' then s.bookmaker_odds
                when 'void' then 1.0
                else 0.0
            end) - 1.0 as profit,
            case
                when s.closing_bookmaker_odds > 1.0
                then s.bookmaker_odds / s.closing_bookmaker_odds - 1.0
            end as clv,
            case
                when s.bookmaker_odds < 1.50 then '1.01-1.49'
                when s.bookmaker_odds < 2.00 then '1.50-1.99'
                when s.bookmaker_odds < 3.00 then '2.00-2.99'
                when s.bookmaker_odds < 5.00 then '3.00-4.99'
                else '5.00+'
            end as odds_band
        from selected s
        where s.outcome in ('win', 'loss', 'void')
          and s.bookmaker_odds > 1.0
          and s.bookmaker_odds < 1e300
    ), single_running as (
        select
            s.*,
            sum(s.profit) over (
                order by s.ticket_date, s.created_at, s.id
                rows between unbounded preceding and current row
            ) as equity
        from singles s
    ), single_peaks as (
        select
            s.equity,
            max(s.equity) over (
                order by s.ticket_date, s.created_at, s.id
                rows between unbounded preceding and current row
            ) as previous_peak
        from single_running s
    ), single_summary as (
        select
            count(*) as bets,
            count(*) filter (where outcome = 'win') as wins,
            count(*) filter (where outcome = 'loss') as losses,
            count(*) filter (where outcome = 'void') as pushes,
            case when count(*) filter (where outcome in ('win', 'loss')) > 0
                then count(*) filter (where outcome = 'win')::double precision
                    / count(*) filter (where outcome in ('win', 'loss'))
            end as hit_rate,
            count(*)::double precision as total_staked,
            coalesce(sum(gross_return), 0.0) as total_return,
            coalesce(sum(profit), 0.0) as net_profit,
            case when count(*) > 0 then sum(profit) / count(*) end as roi,
            avg(odds) as average_odds,
            case when avg(odds) > 0 then 1.0 / avg(odds) end as break_even_win_rate,
            coalesce((
                select max(greatest(0.0, previous_peak) - equity)
                from single_peaks
            ), 0.0) as max_drawdown,
            count(distinct fixture_id) as unique_fixtures,
            count(closing_odds) as clv_bets,
            case when count(*) > 0 then count(closing_odds)::double precision / count(*) end as clv_coverage,
            avg(clv) as average_clv,
            case when count(clv) > 0
                then count(*) filter (where clv > 0)::double precision / count(clv)
            end as beat_closing_rate
        from singles
    ), ready_days as (
        select s.ticket_date
        from selected s
        group by s.ticket_date
        having bool_and(s.outcome in ('win', 'loss', 'void'))
           and bool_and(s.bookmaker_odds > 1.0 and s.bookmaker_odds < 1e300)
    ), accumulator_days as (
        select
            s.ticket_date,
            max(s.created_at) as created_at,
            count(*) as legs,
            exp(sum(ln(s.odds))) as combined_odds,
            case when bool_or(s.outcome = 'loss') then 0.0
                else coalesce(exp(sum(ln(s.odds)) filter (where s.outcome <> 'void')), 1.0)
            end as gross_return,
            case
                when bool_or(s.outcome = 'loss') then 'loss'
                when bool_and(s.outcome = 'void') then 'void'
                else 'win'
            end as outcome,
            case when not bool_or(s.outcome = 'loss')
                then coalesce(exp(sum(ln(s.odds)) filter (where s.outcome <> 'void')), 1.0)
            end as effective_odds,
            case when count(s.closing_odds) = count(*)
                then exp(sum(ln(s.closing_odds)))
            end as closing_odds
        from singles s
        join ready_days d on d.ticket_date = s.ticket_date
        group by s.ticket_date
    ), accumulators as (
        select
            a.*,
            a.gross_return - 1.0 as profit,
            case when a.closing_odds > 1.0
                then a.combined_odds / a.closing_odds - 1.0
            end as clv
        from accumulator_days a
    ), accumulator_running as (
        select
            a.*,
            sum(a.profit) over (
                order by a.ticket_date, a.created_at
                rows between unbounded preceding and current row
            ) as equity
        from accumulators a
    ), accumulator_peaks as (
        select
            a.equity,
            max(a.equity) over (
                order by a.ticket_date, a.created_at
                rows between unbounded preceding and current row
            ) as previous_peak
        from accumulator_running a
    ), accumulator_summary as (
        select
            count(*) as bets,
            coalesce(sum(legs), 0) as legs,
            count(*) filter (where outcome = 'win') as wins,
            count(*) filter (where outcome = 'loss') as losses,
            count(*) filter (where outcome = 'void') as pushes,
            case when count(*) filter (where outcome in ('win', 'loss')) > 0
                then count(*) filter (where outcome = 'win')::double precision
                    / count(*) filter (where outcome in ('win', 'loss'))
            end as hit_rate,
            count(*)::double precision as total_staked,
            coalesce(sum(gross_return), 0.0) as total_return,
            coalesce(sum(profit), 0.0) as net_profit,
            case when count(*) > 0 then sum(profit) / count(*) end as roi,
            avg(combined_odds) as average_odds,
            case when avg(combined_odds) > 0 then 1.0 / avg(combined_odds) end as break_even_win_rate,
            coalesce((
                select max(greatest(0.0, previous_peak) - equity)
                from accumulator_peaks
            ), 0.0) as max_drawdown,
            count(closing_odds) as clv_bets,
            case when count(*) > 0 then count(closing_odds)::double precision / count(*) end as clv_coverage,
            avg(clv) as average_clv,
            case when count(clv) > 0
                then count(*) filter (where clv > 0)::double precision / count(clv)
            end as beat_closing_rate
        from accumulators
    ), selected_probabilities as (
        select
            s.outcome,
            s.model_prob,
            s.robust_model_prob,
            s.market_implied_prob
        from selected s
        where s.outcome in ('win', 'loss')
    ), probability_summary as (
        select
            count(model_prob) filter (where model_prob > 0 and model_prob < 1) as model_predictions,
            avg(power(model_prob - (outcome = 'win')::integer, 2))
                filter (where model_prob > 0 and model_prob < 1) as model_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then model_prob else 1.0 - model_prob end
            )))) filter (where model_prob > 0 and model_prob < 1) as model_log_loss,
            avg(model_prob) filter (where model_prob > 0 and model_prob < 1) as model_mean_probability,
            avg((outcome = 'win')::integer)
                filter (where model_prob > 0 and model_prob < 1) as model_observed_win_rate,
            count(robust_model_prob) filter (where robust_model_prob > 0 and robust_model_prob < 1) as robust_predictions,
            avg(power(robust_model_prob - (outcome = 'win')::integer, 2))
                filter (where robust_model_prob > 0 and robust_model_prob < 1) as robust_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then robust_model_prob else 1.0 - robust_model_prob end
            )))) filter (where robust_model_prob > 0 and robust_model_prob < 1) as robust_log_loss,
            avg(robust_model_prob) filter (where robust_model_prob > 0 and robust_model_prob < 1) as robust_mean_probability,
            avg((outcome = 'win')::integer)
                filter (where robust_model_prob > 0 and robust_model_prob < 1) as robust_observed_win_rate,
            count(market_implied_prob) filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_predictions,
            avg(power(market_implied_prob - (outcome = 'win')::integer, 2))
                filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_brier_score,
            avg(-ln(greatest(1e-15, least(1.0 - 1e-15,
                case when outcome = 'win' then market_implied_prob else 1.0 - market_implied_prob end
            )))) filter (where market_implied_prob > 0 and market_implied_prob < 1) as market_log_loss
        from selected_probabilities
    ), market_segments as (
        select
            market as key,
            count(*) as bets,
            count(*) filter (where outcome = 'win') as wins,
            count(*) filter (where outcome = 'loss') as losses,
            count(*) filter (where outcome = 'void') as pushes,
            case when count(*) filter (where outcome in ('win', 'loss')) > 0
                then count(*) filter (where outcome = 'win')::double precision
                    / count(*) filter (where outcome in ('win', 'loss'))
            end as hit_rate,
            case when count(*) > 0 then sum(profit) / count(*) end as roi,
            sum(profit) as net_profit,
            avg(odds) as average_odds,
            avg(clv) as average_clv
        from singles
        group by market
    ), league_segments as (
        select
            coalesce(nullif(league, ''), 'Unknown') as key,
            count(*) as bets,
            count(*) filter (where outcome = 'win') as wins,
            count(*) filter (where outcome = 'loss') as losses,
            count(*) filter (where outcome = 'void') as pushes,
            case when count(*) filter (where outcome in ('win', 'loss')) > 0
                then count(*) filter (where outcome = 'win')::double precision
                    / count(*) filter (where outcome in ('win', 'loss'))
            end as hit_rate,
            case when count(*) > 0 then sum(profit) / count(*) end as roi,
            sum(profit) as net_profit,
            avg(odds) as average_odds,
            avg(clv) as average_clv
        from singles
        group by coalesce(nullif(league, ''), 'Unknown')
    ), odds_segments as (
        select
            odds_band as key,
            count(*) as bets,
            count(*) filter (where outcome = 'win') as wins,
            count(*) filter (where outcome = 'loss') as losses,
            count(*) filter (where outcome = 'void') as pushes,
            case when count(*) filter (where outcome in ('win', 'loss')) > 0
                then count(*) filter (where outcome = 'win')::double precision
                    / count(*) filter (where outcome in ('win', 'loss'))
            end as hit_rate,
            case when count(*) > 0 then sum(profit) / count(*) end as roi,
            sum(profit) as net_profit,
            avg(odds) as average_odds,
            avg(clv) as average_clv
        from singles
        group by odds_band
    )
    select jsonb_build_object(
        'counts', (select to_jsonb(selection_counts) from selection_counts),
        'singles', (select to_jsonb(single_summary) from single_summary),
        'accumulator', (select to_jsonb(accumulator_summary) from accumulator_summary),
        'probability', (select to_jsonb(probability_summary) from probability_summary),
        'segments', jsonb_build_object(
            'market', coalesce((select jsonb_agg(market_segments order by key) from market_segments), '[]'::jsonb),
            'league', coalesce((select jsonb_agg(league_segments order by key) from league_segments), '[]'::jsonb),
            'odds_band', coalesce((select jsonb_agg(odds_segments order by key) from odds_segments), '[]'::jsonb)
        )
    );
$$;

revoke all on function public._admin_strategy_one(text, date) from public;
revoke all on function public._admin_strategy_one(text, date) from anon;
revoke all on function public._admin_strategy_one(text, date) from authenticated;
grant execute on function public._admin_strategy_one(text, date) to service_role;

create or replace function public.admin_strategy_report(p_days integer default 90)
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

    select jsonb_build_object(
        'generated_at', now(),
        'window_start', start_date,
        'window_end', current_date,
        'strategies', jsonb_build_object(
            'production', public._admin_strategy_one('production', start_date),
            'robust_conservative_v1', public._admin_strategy_one('robust_conservative_v1', start_date)
        ),
        'methodology', jsonb_build_object(
            'production_scope', 'Production optimizer output; not necessarily published after Auditor/Decision.',
            'shadow_scope', 'Private shadow experiment; never an official publication.',
            'stake', 'One flat unit per settled single or complete daily accumulator.',
            'dnb', 'Void legs return stake in singles and reduce accumulator effective odds.',
            'clv', 'taken_odds / closing_odds - 1; null coverage means unavailable.',
            'activation', 'Descriptive diagnostics only; no automatic strategy activation.'
        )
    ) into result;
    return result;
end;
$$;

revoke all on function public.admin_strategy_report(integer) from public;
revoke all on function public.admin_strategy_report(integer) from anon;
grant execute on function public.admin_strategy_report(integer) to authenticated;
grant execute on function public.admin_strategy_report(integer) to service_role;

comment on function public.admin_strategy_report(integer) is
    'Allowlisted-admin aggregated production/shadow metrics; exposes no raw private prediction logs.';

commit;
