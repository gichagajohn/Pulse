(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PulseModelValidation = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const MIN_CALIBRATION_SAMPLES = 200;
  const MIN_CALIBRATION_PER_CLASS = 30;
  // Provider clocks occasionally run a moment ahead of the worker; the historical
  // failures this gate exists for were hours-to-days ahead, not seconds.
  const DEFAULT_MAX_FUTURE_PRICE_SKEW_SECONDS = 120;
  const WILSON_Z_95 = 1.959963984540054;

  function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
  }

  // Accepts Date instances, epoch milliseconds, and ISO-8601 strings (including
  // a trailing Z). Returns a Date, or null when the value cannot be trusted.
  function parseTime(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number' && Number.isFinite(value)) {
      const fromNumber = new Date(value);
      return Number.isNaN(fromNumber.getTime()) ? null : fromNumber;
    }
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Date.parse(value);
      return Number.isNaN(parsed) ? null : new Date(parsed);
    }
    return null;
  }

  function isValidProbability(value) {
    return isFiniteNumber(value) && value > 0 && value < 1;
  }

  function isValidPrice(value) {
    return isFiniteNumber(value) && value > 1;
  }

  // Hard pre-publication provenance gate. Every official selection must pass
  // this check; when it does not, the safe output is NO BET, not a published
  // leg and never a bypass of FORCE_PUBLISH.
  function validateCandidate(input, options) {
    const settings = options || {};
    const maxFuturePriceSkewSeconds = isFiniteNumber(settings.maxFuturePriceSkewSeconds)
      ? settings.maxFuturePriceSkewSeconds
      : DEFAULT_MAX_FUTURE_PRICE_SKEW_SECONDS;
    const requireMarketProb = settings.requireMarketProb !== false;

    const issues = [];
    const source = input || {};

    const createdAt = parseTime(source.created_at);
    if (createdAt === null) {
      issues.push(source.created_at === undefined || source.created_at === null ? 'created_at_missing' : 'created_at_invalid');
    }

    const kickoff = parseTime(source.kickoff_utc);
    if (kickoff === null) {
      issues.push(source.kickoff_utc === undefined || source.kickoff_utc === null ? 'kickoff_missing' : 'kickoff_invalid');
    }

    if (createdAt && kickoff && createdAt.getTime() >= kickoff.getTime()) {
      issues.push('prediction_not_before_kickoff');
    }

    const priceUpdatedAt = parseTime(source.price_updated_at);
    if (priceUpdatedAt === null) {
      issues.push(source.price_updated_at === undefined || source.price_updated_at === null ? 'price_updated_at_missing' : 'price_updated_at_invalid');
    } else {
      if (createdAt && priceUpdatedAt.getTime() > createdAt.getTime() + maxFuturePriceSkewSeconds * 1000) {
        issues.push('price_updated_after_prediction');
      }
      if (kickoff && priceUpdatedAt.getTime() > kickoff.getTime()) {
        issues.push('price_updated_after_kickoff');
      }
    }

    if (!isValidPrice(source.bookmaker_odds)) issues.push('bookmaker_odds_invalid');
    if (!isValidProbability(source.model_prob)) issues.push('model_prob_invalid');
    if (requireMarketProb && !isValidProbability(source.market_implied_prob)) issues.push('market_implied_prob_invalid');

    return {
      ok: issues.length === 0,
      issues,
      checked: {
        created_at: createdAt ? createdAt.toISOString() : null,
        kickoff_utc: kickoff ? kickoff.toISOString() : null,
        price_updated_at: priceUpdatedAt ? priceUpdatedAt.toISOString() : null,
        bookmaker_odds: isValidPrice(source.bookmaker_odds) ? source.bookmaker_odds : null,
        model_prob: isValidProbability(source.model_prob) ? source.model_prob : null,
        market_implied_prob: isValidProbability(source.market_implied_prob) ? source.market_implied_prob : null
      }
    };
  }

  // Normalise raw implied probabilities (which sum to above 1 because of the
  // bookmaker margin) into no-vig probabilities that sum to exactly 1.
  // Returns null when any input is invalid; never throws.
  function noVigProbability(rawProbs) {
    if (!Array.isArray(rawProbs) || rawProbs.length === 0) return null;
    let sum = 0;
    for (const raw of rawProbs) {
      if (!isValidProbability(raw)) return null;
      sum += raw;
    }
    if (!(sum > 0) || !Number.isFinite(sum)) return null;
    return rawProbs.map(raw => raw / sum);
  }

  // Wilson score interval for a binomial proportion. Returns null for n <= 0.
  function wilsonInterval(wins, trials, z) {
    const n = Number(trials);
    const k = Number(wins);
    const zScore = isFiniteNumber(z) ? z : WILSON_Z_95;
    if (!Number.isFinite(n) || !Number.isFinite(k) || n <= 0 || k < 0 || k > n) return null;
    const p = k / n;
    const zSquared = zScore * zScore;
    const denominator = 1 + zSquared / n;
    const centre = (p + zSquared / (2 * n)) / denominator;
    const halfWidth = (zScore * Math.sqrt((p * (1 - p)) / n + zSquared / (4 * n * n))) / denominator;
    return { lower: Math.max(0, centre - halfWidth), upper: Math.min(1, centre + halfWidth), centre };
  }

  // Conservative lower bound for an estimated probability pHat derived from
  // effectiveN observations (for example calibration-eligible settled outputs).
  // pHat is clipped into (0, 1) so integer binomial accounting stays valid.
  function wilsonLowerBound(pHat, effectiveN, z) {
    if (!isValidProbability(pHat)) return null;
    const n = Math.round(Number(effectiveN));
    if (!Number.isFinite(n) || n <= 0) return null;
    const wins = Math.min(n, Math.max(0, Math.round(pHat * n)));
    const interval = wilsonInterval(wins, n, z);
    return interval ? interval.lower : null;
  }

  function expectedValue(probability, odds) {
    if (!isValidProbability(probability) || !isValidPrice(odds)) return null;
    return probability * odds - 1;
  }

  // Headline companion to raw EV. A candidate only has conservative value when
  // its lower confidence probability still beats the bookmaker's price.
  function conservativeExpectedValue(pHat, odds, effectiveN, z) {
    const lower = wilsonLowerBound(pHat, effectiveN, z);
    if (lower === null || !isValidPrice(odds)) return null;
    return { probability_lower: lower, expected_value: lower * odds - 1 };
  }

  function combinedOdds(oddsList) {
    if (!Array.isArray(oddsList) || oddsList.length === 0) return null;
    let product = 1;
    for (const odds of oddsList) {
      if (!isValidPrice(odds)) return null;
      product *= odds;
    }
    return Number.isFinite(product) ? product : null;
  }

  // Joint probability under an explicit independence assumption between legs.
  // Same-fixture markets are NOT independent; the caller must use a joint
  // scoreline distribution for those instead of this helper.
  function jointProbability(probList) {
    if (!Array.isArray(probList) || probList.length === 0) return null;
    let product = 1;
    for (const prob of probList) {
      if (!isValidProbability(prob)) return null;
      product *= prob;
    }
    return Number.isFinite(product) ? product : null;
  }

  // Whole-ticket conservative assessment. Legs must be distinct fixtures (or
  // otherwise validated as independent); each leg carries its own effective
  // sample size. Returns null when any leg is invalid, so a broken leg can
  // never silently enter a ticket.
  function summarizeTicket(legs, z) {
    if (!Array.isArray(legs) || legs.length === 0) return null;
    const normalised = [];
    for (const leg of legs) {
      const source = leg || {};
      if (!isValidProbability(source.prob) || !isValidPrice(source.odds)) return null;
      const n = Math.round(Number(source.effective_n));
      const effectiveN = Number.isFinite(n) && n > 0 ? n : null;
      const lower = effectiveN === null ? null : wilsonLowerBound(source.prob, effectiveN, z);
      normalised.push({ prob: source.prob, odds: source.odds, effective_n: effectiveN, prob_lower: lower });
    }
    const combined = combinedOdds(normalised.map(leg => leg.odds));
    const joint = jointProbability(normalised.map(leg => leg.prob));
    if (combined === null || joint === null) return null;
    const lowers = normalised.map(leg => leg.prob_lower);
    const conservativeProbability = lowers.every(lower => lower !== null) ? jointProbability(lowers) : null;
    return {
      legs: normalised,
      combined_odds: combined,
      joint_probability: joint,
      joint_probability_lower: conservativeProbability,
      model_expected_value: joint * combined - 1,
      conservative_expected_value: conservativeProbability === null ? null : conservativeProbability * combined - 1
    };
  }

  // Mirror of the guarded calibration rule already used in production logs,
  // kept in one place so the worker and the reports can share the thresholds.
  function calibrationReadiness(input, options) {
    const settings = options || {};
    const minSamples = Number.isInteger(settings.minSamples) ? settings.minSamples : MIN_CALIBRATION_SAMPLES;
    const minPerClass = Number.isInteger(settings.minPerClass) ? settings.minPerClass : MIN_CALIBRATION_PER_CLASS;
    const source = input || {};
    const wins = Math.max(0, Math.floor(Number(source.wins) || 0));
    const losses = Math.max(0, Math.floor(Number(source.losses) || 0));
    const samples = Number.isInteger(source.samples) ? source.samples : wins + losses;
    const active = samples >= minSamples && wins >= minPerClass && losses >= minPerClass;
    return {
      active,
      reason: active
        ? null
        : `Need at least ${minSamples} settled outputs and ${minPerClass} per class; have ${samples} (${wins} wins/${losses} losses).`,
      samples,
      wins,
      losses,
      min_samples: minSamples,
      min_per_class: minPerClass
    };
  }

  return {
    MIN_CALIBRATION_SAMPLES,
    MIN_CALIBRATION_PER_CLASS,
    DEFAULT_MAX_FUTURE_PRICE_SKEW_SECONDS,
    WILSON_Z_95,
    parseTime,
    isValidProbability,
    isValidPrice,
    validateCandidate,
    noVigProbability,
    wilsonInterval,
    wilsonLowerBound,
    expectedValue,
    conservativeExpectedValue,
    combinedOdds,
    jointProbability,
    summarizeTicket,
    calibrationReadiness
  };
});
