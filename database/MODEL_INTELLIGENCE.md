# Pulse model intelligence: safe implementation plan

Companion to `pulse_model_intelligence_audit.md`. This file is the engineering
contract for fixing the Pulse prediction pipeline without retrofitting history,
leaking selections, or activating an unproven strategy.

## What already landed

- `model-validation.js` — shared, dependency-free reference implementation of the
  provenance gate and conservative-value mathematics. The prediction worker
  should port these functions 1:1 or require this module directly. It is also
  unit-tested in `tests/model_intelligence.test.cjs`.
- `database/20261109_model_intelligence_diagnostics.sql` — allowlisted-admin
  RPC `public.admin_model_intelligence_report(p_days)`. Aggregates only:
  provenance health, calibration readiness, model-vs-market scoring (overall and
  on timestamp-consistent rows), selection bias (selected / eligible-unselected /
  ineligible), claimed-EV≥10% diagnostics, shadow and closing-price coverage,
  and version integrity. Admin gate is `public.is_admin()`, exactly like the
  existing strategy report. It activates nothing.
- Model lab UI now shows those aggregates in a **Model health & provenance**
  panel above the production-vs-shadow comparison, with honest empty and
  insufficient-evidence states.

## Current state (as of the audit)

- All 324 production logs lack `kickoff_utc`; 162 rows carry provider price
  updates later than the prediction; eligibility gate alone cannot rescue this.
- Probability calibration is inactive everywhere (`guarded_platt_v1` correctly
  refuses to fire on tiny class counts); production uses raw probabilities.
- Closing prices: 0/324. Robust/shadow fields: 0/324. The challenger comparison
  and any CLV verdict are therefore literally impossible today.
- `FORCE_PUBLISH` currently cannot be allowed to override provenance failures.

## Stage A — provenance hard gates (worker change; required before anything else)

1. **Kickoff is mandatory.** The worker must read fixture kickoff into
   `model_prediction_logs.kickoff_utc` and `ticket_selections.kickoff_utc` for
   every candidate. Null kickoff ⇒ candidate is unverifiable ⇒ not publishable.
2. **Hard validation before publication.** Port `validateCandidate` from
   `model-validation.js`. A candidate passes only when:
   - `created_at` and `kickoff_utc` parse and `created_at < kickoff_utc`;
   - `price_updated_at` parses, is `<= created_at + maxFuturePriceSkewSeconds`
     (default 120s; tighten to 0 once the provider clock is understood),
     and is `<= kickoff_utc`;
   - `bookmaker_odds > 1` and finite; `model_prob` and `market_implied_prob`
     are strictly inside (0, 1).
   Any failure ⇒ no leg. If nothing survives, the day's output is `NO BET`.
   `FORCE_PUBLISH: "true"` must bypass none of these checks.
3. **Deterministic linkage.** One `run_id` (uuid) per worker invocation; the
   run publishes `prediction_tickets` rows stamped with it; each official leg
   in `ticket_selections` carries that `ticket_id`; each candidate log row in
   `model_prediction_logs` carries it too (add `run_id` to the log table if
   absent). Publication links selections to the exact probability row — never
   "latest unassigned rows by date and capacity". `prediction_ticket_versions`
   gets the same `run_id`, `version_status = 'published'`, and
   `integrity_status = 'verified'` on write.
4. **Immutable versions.** Never overwrite a published version. Corrections are
   new versions with superseded_at set on the old row. Legacy rows remain
   labelled `legacy_unverified`; do not relabel them retroactively.
5. **Closing-price capture (prospective only).** A pre-kickoff scheduler records
   the last observed executable price per selected leg into
   `closing_bookmaker_odds` (plus source and observation time inside
   `feature_snapshot`). Never backfill from results or post-match data.
6. **Shadow logging.** For every production candidate, also compute the
   conservative-shadow fields on the same snapshot: `robust_model_prob`,
   `robust_expected_value`, `strategy = 'robust_conservative_v1'`,
   `shadow_selected`. Shadow rows are never published and never settle as
   official tickets.

Definition of done for Stage A: the diagnostics RPC reports
`missing_kickoff = 0`, `price_after_prediction = 0`, `eligible_unverifiable = 0`
for a full settled window, and closing capture is running for newly published
tickets.

## Stage B — shadow challenger (research; never published)

1. Keep the Dixon–Coles-adjusted Poisson core. Chronological split:
   train / validation / untouched test, strictly by fixture date.
2. Bootstrap training matches to get a probability distribution per candidate,
   not a point estimate. Rank by `wilsonLowerBound(p, effectiveN) * odds − 1`
   (`conservativeExpectedValue` in `model-validation.js`), not raw EV.
3. Accumulators from the joint scoreline distribution (model same-fixture
   markets jointly via the Dixon–Coles grid; independent legs across fixtures
   via `summarizeTicket`). Optimize conservative whole-ticket value. No
   arbitrary leg, market, league, or odds caps; `NO BET` is a valid answer.
4. Calibration stays guarded: 200 settled outputs, 30 per class, **and** at
   least 50 distinct fixtures and 10 distinct settled dates before activation;
   otherwise `guarded_platt_v1` remains inactive and probabilities are raw.

## Stage C — promotion gates (the only path to production)

All of these, on the untouched chronological holdout only:

- provenance clean: 100% kickoff present, 0 future-price rows, 0 ambiguous
  run/ticket linkages;
- calibration curve slope/intercept acceptable; Brier and log loss materially
  better than raw production and no worse than the no-vig market;
- CLV ≥ 0 on the selected portfolio with non-zero closing coverage;
- ROI and maximum drawdown reported with fixture/date-clustered intervals;
- the promotion thresholds registered before the holdout is inspected;
- otherwise the challenger stays shadowed forever and production (or `NO BET`)
  remains the output. No activation from diagnostics or from November 6–8 data.

## Rules that never change

- November 6–8 2026 outputs are historical contaminated observations. Never
  re-run, edit, or "fix" them; add no backfilled closing prices.
- Official-ticket performance is reported by original `ticket_id`; optimizer
  diagnostics are reported by `run_id`. The two never mix.
- Model intelligence claims require settled, timestamped, provenance-clean
  outputs. Win rate alone proves nothing.
