(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AdminStrategyView = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  const EMPTY = '—';
  const STRATEGIES = [
    { key: 'production', label: 'Production optimizer', scope: 'Optimizer output' },
    { key: 'robust_conservative_v1', label: 'Robust conservative v1', scope: 'Private shadow only' }
  ];

  function number(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatInteger(value) {
    const parsed = number(value);
    return parsed === null ? EMPTY : Math.round(parsed).toLocaleString('en-KE');
  }

  function formatPercent(value, signed = false) {
    const parsed = number(value);
    if (parsed === null) return EMPTY;
    const percentage = parsed * 100;
    const sign = signed && percentage > 0 ? '+' : '';
    return `${sign}${percentage.toFixed(1)}%`;
  }

  function formatUnits(value, signed = false) {
    const parsed = number(value);
    if (parsed === null) return EMPTY;
    const sign = signed && parsed > 0 ? '+' : '';
    return `${sign}${parsed.toFixed(2)}u`;
  }

  function formatOdds(value) {
    const parsed = number(value);
    return parsed === null ? EMPTY : parsed.toFixed(2);
  }

  function formatDecimal(value) {
    const parsed = number(value);
    return parsed === null ? EMPTY : parsed.toFixed(4);
  }

  function formatClv(row) {
    if (!row || number(row.clv_bets) === 0) return 'No coverage';
    return formatPercent(row.average_clv, true);
  }

  function formatClvCoverage(row) {
    if (!row) return EMPTY;
    const covered = Math.round(number(row.clv_bets) || 0);
    const bets = Math.round(number(row.bets) || 0);
    if (!bets) return EMPTY;
    return `${covered}/${bets} (${formatPercent(row.clv_coverage)})`;
  }

  const BUCKET_LABELS = { selected: 'Optimizer selected', eligible_unselected: 'Eligible, not selected', ineligible: 'Not eligible' };
  const BUCKET_ORDER = ['selected', 'eligible_unselected', 'ineligible'];

  function healthValue(value, format) {
    if (format === 'integer') return formatInteger(value);
    if (format === 'signedPercent') return formatPercent(value, true);
    if (format === 'plainPercent') return formatPercent(value);
    if (format === 'decimal') return formatDecimal(value);
    return value === null || value === undefined ? EMPTY : String(value);
  }

  function healthWarnings(provenance, calibration, scoring) {
    const warnings = [];
    const missingKickoff = number(provenance?.missing_kickoff) || 0;
    if (missingKickoff > 0) warnings.push(`kickoff_utc is missing on ${formatInteger(missingKickoff)} candidate rows. Timing gates cannot pass until the worker populates it; treated as unverifiable, never as pre-match-safe.`);
    const futurePrice = number(provenance?.price_after_prediction) || 0;
    if (futurePrice > 0) warnings.push(`Provider prices updated after prediction on ${formatInteger(futurePrice)} rows. These are not usable pre-match evidence and must not be published or scored as clean.`);
    const unverifiable = number(provenance?.eligible_unverifiable) || 0;
    if (unverifiable > 0) warnings.push(`${formatInteger(unverifiable)} optimizer-eligible rows fail provenance verification and must resolve to NO BET, not publication.`);
    const inactive = number(calibration?.inactive_rows) || 0;
    if (inactive > 0) warnings.push(`Probability calibration is inactive on ${formatInteger(inactive)} rows. Production is using raw model/market blends; claimed EV is not calibrated EV.`);
    const n = number(scoring?.n) || 0;
    const settledDates = number(provenance?.settled_dates);
    const fixtures = number(provenance?.distinct_settled_fixtures);
    const thinWindow = (settledDates !== null && settledDates < 10) || (fixtures !== null && fixtures < 100) || n < 200;
    if (thinWindow) warnings.push(`Only ${formatInteger(n)} settled, scored outputs across ${formatInteger(settledDates)} settled dates and ${formatInteger(fixtures)} fixtures. Descriptive only; do not promote or activate anything from this window.`);
    return warnings;
  }

  function healthTable(doc, caption, headers, rows) {
    const wrapper = element(doc, 'div', 'strategy-table-wrap');
    const table = element(doc, 'table', 'strategy-table comparison-table');
    table.append(element(doc, 'caption', '', caption));
    const head = element(doc, 'thead');
    const headerRow = element(doc, 'tr');
    headers.forEach(label => headerRow.append(element(doc, 'th', '', label)));
    head.append(headerRow);
    table.append(head);
    const body = element(doc, 'tbody');
    rows.forEach(cells => {
      const row = element(doc, 'tr');
      cells.forEach((cell, index) => row.append(element(doc, index === 0 ? 'th' : 'td', '', cell)));
      body.append(row);
    });
    table.append(body);
    wrapper.append(table);
    return wrapper;
  }

  function selectionBiasTable(doc, buckets) {
    const rows = BUCKET_ORDER.map(key => {
      const bucket = buckets?.[key];
      return [
        BUCKET_LABELS[key],
        healthValue(bucket?.n, 'integer'),
        healthValue(bucket?.mean_claimed_ev, 'signedPercent'),
        healthValue(bucket?.mean_model_prob, 'plainPercent'),
        healthValue(bucket?.observed_win_rate, 'plainPercent'),
        healthValue(bucket?.flat_roi, 'signedPercent'),
        key === 'selected'
          ? `${healthValue(bucket?.wilson_low, 'plainPercent')} – ${healthValue(bucket?.wilson_high, 'plainPercent')}`
          : EMPTY
      ];
    });
    return healthTable(doc,
      'Selection bias: optimizer output versus the eligible pool it leaves behind (flat one unit, settled win/loss rows only)',
      ['Group', 'n', 'Mean claimed EV', 'Mean model p', 'Observed win rate', 'Flat-stake ROI', '95% Wilson interval (selected)'],
      rows);
  }

  function scoringTable(doc, scoring) {
    const clean = scoring?.timestamp_consistent || {};
    const rows = [
      ['Brier score (lower is better)', healthValue(scoring?.model_brier_score, 'decimal'), healthValue(scoring?.market_brier_score, 'decimal'), healthValue(clean?.model_brier_score, 'decimal'), healthValue(clean?.market_brier_score, 'decimal')],
      ['Log loss (lower is better)', healthValue(scoring?.model_log_loss, 'decimal'), healthValue(scoring?.market_log_loss, 'decimal'), healthValue(clean?.model_log_loss, 'decimal'), healthValue(clean?.market_log_loss, 'decimal')],
      ['Scored outputs', healthValue(scoring?.n, 'integer'), healthValue(scoring?.market_n, 'integer'), healthValue(clean?.n, 'integer'), healthValue(clean?.market_n, 'integer')]
    ];
    return healthTable(doc,
      'Model versus no-vig market, overall and on timestamp-consistent rows only',
      ['Metric', 'Model (all)', 'Market (all)', 'Model (timestamp-consistent)', 'Market (timestamp-consistent)'],
      rows);
  }

  function challengerBlock(doc, challenger) {
    const section = element(doc, 'section', 'segment-card');
    section.append(element(doc, 'h3', '', 'Private shadow experiment & closing prices'));
    const robustRows = number(challenger?.robust_probability_rows) || 0;
    const shadowSelected = number(challenger?.shadow_selected_rows) || 0;
    const closingRows = number(challenger?.closing_price_rows) || 0;
    const coverage = number(challenger?.closing_price_coverage);
    const lines = [
      `Robust probabilities populated on ${formatInteger(robustRows)} rows.`,
      `Shadow-selected rows: ${formatInteger(shadowSelected)}.`,
      `Closing prices available on ${formatInteger(closingRows)} rows (${coverage === null ? EMPTY : formatPercent(coverage)} coverage).`
    ];
    lines.forEach(line => section.append(element(doc, 'p', 'health-line', line)));
    if (robustRows === 0 || shadowSelected === 0 || closingRows === 0) {
      section.append(element(doc, 'p', 'notice warning', 'Insufficient shadow/closing evidence. No challenger comparison, CLV assessment, or strategy activation is possible yet; the shadow experiment stays read-only.'));
    } else {
      section.append(element(doc, 'p', 'notice info', 'Coverage reported for monitoring only. Activation still requires an untouched chronological holdout and the pre-registered promotion rule.'));
    }
    return section;
  }

  function renderModelHealth(container, report, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!container || !documentRef) throw new Error('A document and report container are required.');
    container.replaceChildren();
    if (!report || typeof report !== 'object') {
      container.append(element(documentRef, 'div', 'notice warning', 'Model health diagnostics are unavailable.'));
      return;
    }
    const provenance = report.provenance || {};
    const calibration = report.calibration || {};
    const scoring = report.scoring || {};
    const warnings = healthWarnings(provenance, calibration, scoring);
    warnings.forEach(warning => container.append(element(documentRef, 'div', 'notice warning', warning)));

    const provenanceRows = [
      ['Candidate rows (deduplicated)', healthValue(provenance.candidate_rows, 'integer')],
      ['Settled candidate rows', healthValue(provenance.settled_candidate_rows, 'integer')],
      ['Missing kickoff_utc', healthValue(provenance.missing_kickoff, 'integer')],
      ['Prices updated after prediction', healthValue(provenance.price_after_prediction, 'integer')],
      ['Rows missing usable price', healthValue(provenance.missing_price, 'integer')],
      ['Max future price skew', provenance.max_future_price_skew_seconds === null || provenance.max_future_price_skew_seconds === undefined ? EMPTY : `${formatInteger(provenance.max_future_price_skew_seconds)}s`],
      ['Optimizer-eligible rows failing verification', healthValue(provenance.eligible_unverifiable, 'integer')],
      ['Calibration-active rows', healthValue(calibration.active_rows, 'integer')],
      ['Calibration-inactive rows', healthValue(calibration.inactive_rows, 'integer')],
      ['Max observed calibration samples', healthValue(calibration.max_observed_samples, 'integer')]
    ];
    container.append(healthTable(documentRef,
      'Provenance and calibration gate status',
      ['Check', 'Value'],
      provenanceRows));

    container.append(scoringTable(documentRef, scoring));
    container.append(selectionBiasTable(documentRef, report.selection_bias));

    const highEv = report.high_ev_10_plus || {};
    container.append(healthTable(documentRef,
      'Claimed model EV of at least 10% (hypothesis-generating only; not an activation rule)',
      ['Group', 'n', 'Mean claimed EV', 'Mean model p', 'Mean market p', 'Observed', 'Flat-stake ROI', 'Selected'],
      [[
        'EV ≥ 10% candidates',
        healthValue(highEv.n, 'integer'),
        healthValue(highEv.mean_claimed_ev, 'signedPercent'),
        healthValue(highEv.mean_model_prob, 'plainPercent'),
        healthValue(highEv.mean_market_prob, 'plainPercent'),
        healthValue(highEv.observed_win_rate, 'plainPercent'),
        healthValue(highEv.flat_roi, 'signedPercent'),
        healthValue(highEv.selected_rows, 'integer')
      ]]));

    container.append(challengerBlock(documentRef, report.challenger));
    container.append(element(documentRef, 'p', 'methodology-note', 'Aggregates only over deduplicated production optimizer logs. Unselected rows are counterfactual diagnostics, not realized profit. Voids are excluded. Original published tickets are evaluated separately by ticket id. Diagnostics never activate a model or publish a selection.'));
  }

  function renderHealthLoading(container, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!container) return;
    container.replaceChildren(element(documentRef, 'div', 'empty-state', 'Loading model health diagnostics…'));
  }

  function renderHealthError(container, message, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!container) return;
    container.replaceChildren(element(documentRef, 'div', 'notice warning', message || 'Model health diagnostics could not be loaded.'));
  }

  function selectedProbability(strategy, preferRobust) {    const probability = strategy?.probability || {};
    const robustCount = number(probability.robust_predictions) || 0;
    const useRobust = preferRobust && robustCount > 0;
    const prefix = useRobust ? 'robust' : 'model';
    return {
      source: useRobust ? 'Robust probability' : 'Model probability',
      predictions: number(probability[`${prefix}_predictions`]) || 0,
      brier_score: probability[`${prefix}_brier_score`],
      log_loss: probability[`${prefix}_log_loss`],
      mean_probability: probability[`${prefix}_mean_probability`],
      observed_win_rate: probability[`${prefix}_observed_win_rate`]
    };
  }

  function whenSettled(row, key) {
    return number(row?.bets) > 0 ? row[key] : null;
  }

  function metricRows(production, shadow) {
    const productionProbability = selectedProbability(production, false);
    const shadowProbability = selectedProbability(shadow, true);
    return [
      { label: 'Settled single bets', values: [production.singles?.bets, shadow.singles?.bets], format: 'integer' },
      { label: 'Pending optimizer selections', values: [production.counts?.pending_selected, shadow.counts?.pending_selected], format: 'integer' },
      { label: 'Single hit rate', values: [production.singles?.hit_rate, shadow.singles?.hit_rate], format: 'percent' },
      { label: 'Single ROI', values: [production.singles?.roi, shadow.singles?.roi], format: 'signedPercent', tone: true },
      { label: 'Single net profit', values: [whenSettled(production.singles, 'net_profit'), whenSettled(shadow.singles, 'net_profit')], format: 'signedUnits', tone: true },
      { label: 'Average single odds', values: [production.singles?.average_odds, shadow.singles?.average_odds], format: 'odds' },
      { label: 'Break-even win rate', values: [production.singles?.break_even_win_rate, shadow.singles?.break_even_win_rate], format: 'percent' },
      { label: 'Maximum drawdown', values: [whenSettled(production.singles, 'max_drawdown'), whenSettled(shadow.singles, 'max_drawdown')], format: 'units' },
      { label: 'Unique settled fixtures', values: [production.singles?.unique_fixtures, shadow.singles?.unique_fixtures], format: 'integer' },
      { label: 'Complete accumulators', values: [production.accumulator?.bets, shadow.accumulator?.bets], format: 'integer' },
      { label: 'Accumulator ROI', values: [production.accumulator?.roi, shadow.accumulator?.roi], format: 'signedPercent', tone: true },
      { label: 'Accumulator net profit', values: [whenSettled(production.accumulator, 'net_profit'), whenSettled(shadow.accumulator, 'net_profit')], format: 'signedUnits', tone: true },
      { label: 'Selected Brier score', values: [productionProbability.brier_score, shadowProbability.brier_score], format: 'decimal' },
      { label: 'Selected log loss', values: [productionProbability.log_loss, shadowProbability.log_loss], format: 'decimal' },
      { label: 'Mean CLV (singles)', values: [production.singles, shadow.singles], format: 'clv', tone: true },
      { label: 'CLV coverage (singles)', values: [production.singles, shadow.singles], format: 'clvCoverage' }
    ];
  }

  function formatMetric(value, format) {
    if (format === 'integer') return formatInteger(value);
    if (format === 'percent') return formatPercent(value);
    if (format === 'signedPercent') return formatPercent(value, true);
    if (format === 'units') return formatUnits(value);
    if (format === 'signedUnits') return formatUnits(value, true);
    if (format === 'odds') return formatOdds(value);
    if (format === 'decimal') return formatDecimal(value);
    if (format === 'clv') return formatClv(value);
    if (format === 'clvCoverage') return formatClvCoverage(value);
    return value === null || value === undefined ? EMPTY : String(value);
  }

  function mergeSegments(productionRows, shadowRows, dimension) {
    const production = new Map((Array.isArray(productionRows) ? productionRows : []).map(row => [String(row.key), row]));
    const shadow = new Map((Array.isArray(shadowRows) ? shadowRows : []).map(row => [String(row.key), row]));
    const keys = [...new Set([...production.keys(), ...shadow.keys()])];
    const bandOrder = ['1.01-1.49', '1.50-1.99', '2.00-2.99', '3.00-4.99', '5.00+'];
    return keys.map(key => ({ key, production: production.get(key) || null, shadow: shadow.get(key) || null }))
      .sort((a, b) => {
        if (dimension === 'odds_band') return bandOrder.indexOf(a.key) - bandOrder.indexOf(b.key);
        const betsA = Math.max(number(a.production?.bets) || 0, number(a.shadow?.bets) || 0);
        const betsB = Math.max(number(b.production?.bets) || 0, number(b.shadow?.bets) || 0);
        return betsB - betsA || a.key.localeCompare(b.key);
      });
  }

  function element(doc, tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function toneClass(value, rawValue) {
    const raw = rawValue && typeof rawValue === 'object' ? rawValue.average_clv : rawValue;
    const parsed = number(raw);
    if (parsed === null || parsed === 0) return '';
    return parsed > 0 ? 'metric-positive' : 'metric-negative';
  }

  function strategyCard(doc, definition, strategy) {
    const singles = strategy.singles || {};
    const counts = strategy.counts || {};
    const probability = selectedProbability(strategy, definition.key !== 'production');
    const card = element(doc, 'article', `strategy-card ${definition.key === 'production' ? 'production' : 'shadow'}`);
    const heading = element(doc, 'div', 'strategy-card-heading');
    const title = element(doc, 'div');
    title.append(
      element(doc, 'h3', '', definition.label),
      element(doc, 'p', '', definition.scope)
    );
    heading.append(title, element(doc, 'span', 'status-badge', definition.key === 'production' ? 'PRODUCTION' : 'SHADOW'));
    card.append(heading);
    card.append(element(doc, 'div', 'strategy-roi', formatPercent(singles.roi, true)));
    card.append(element(doc, 'div', 'strategy-roi-label', 'Settled single ROI'));
    const stats = element(doc, 'div', 'strategy-card-stats');
    [
      ['Bets', formatInteger(singles.bets)],
      ['Hit rate', formatPercent(singles.hit_rate)],
      ['Net', formatUnits(whenSettled(singles, 'net_profit'), true)],
      ['Max DD', formatUnits(whenSettled(singles, 'max_drawdown'))],
      ['Pending', formatInteger(counts.pending_selected)],
      [probability.source, probability.predictions ? `${formatInteger(probability.predictions)} scored` : EMPTY]
    ].forEach(([label, value]) => {
      const stat = element(doc, 'div');
      stat.append(element(doc, 'small', '', label), element(doc, 'strong', '', value));
      stats.append(stat);
    });
    card.append(stats);
    if (!(number(singles.bets) > 0)) {
      card.append(element(doc, 'p', 'strategy-empty', definition.key === 'production'
        ? 'No settled production optimizer selections in this window.'
        : 'No settled shadow selections yet. Run and settle a fresh-day shadow portfolio before comparing performance.'));
    } else if ((number(singles.bets) || 0) < 100) {
      card.append(element(doc, 'p', 'strategy-empty', 'Small sample: descriptive only; not evidence of a stable edge.'));
    }
    return card;
  }

  function comparisonTable(doc, production, shadow) {
    const wrapper = element(doc, 'div', 'strategy-table-wrap');
    const table = element(doc, 'table', 'strategy-table comparison-table');
    const caption = element(doc, 'caption', '', 'Flat one-unit singles and complete daily accumulators');
    table.append(caption);
    const head = element(doc, 'thead');
    const header = element(doc, 'tr');
    ['Metric', 'Production optimizer', 'Robust conservative v1 (shadow)'].forEach(label => header.append(element(doc, 'th', '', label)));
    head.append(header);
    table.append(head);
    const body = element(doc, 'tbody');
    metricRows(production, shadow).forEach(metric => {
      const row = element(doc, 'tr');
      row.append(element(doc, 'th', '', metric.label));
      metric.values.forEach(value => {
        const cell = element(doc, 'td', metric.tone ? toneClass(value, value) : '', formatMetric(value, metric.format));
        row.append(cell);
      });
      body.append(row);
    });
    table.append(body);
    wrapper.append(table);
    return wrapper;
  }

  function segmentValue(doc, row) {
    if (!row || !(number(row.bets) > 0)) return element(doc, 'span', 'metric-muted', EMPTY);
    const container = element(doc, 'div', 'segment-value');
    container.append(
      element(doc, 'strong', '', `${formatInteger(row.bets)} bets`),
      element(doc, 'small', '', `${formatPercent(row.hit_rate)} hit`),
      element(doc, 'small', toneClass(row.roi), formatPercent(row.roi, true))
    );
    return container;
  }

  function segmentTable(doc, title, production, shadow, dimension) {
    const section = element(doc, 'section', 'segment-card');
    section.append(element(doc, 'h3', '', title));
    const rows = mergeSegments(production.segments?.[dimension], shadow.segments?.[dimension], dimension);
    if (!rows.length) {
      section.append(element(doc, 'p', 'empty-state', 'No settled selections in this window.'));
      return section;
    }
    const wrapper = element(doc, 'div', 'strategy-table-wrap');
    const table = element(doc, 'table', 'strategy-table segment-table');
    const head = element(doc, 'thead');
    const header = element(doc, 'tr');
    [title.replace('By ', '').replace(/s$/, ''), 'Production', 'Shadow'].forEach(label => header.append(element(doc, 'th', '', label)));
    head.append(header);
    table.append(head);
    const body = element(doc, 'tbody');
    rows.forEach(item => {
      const row = element(doc, 'tr');
      row.append(element(doc, 'th', '', titleCase(item.key)));
      const productionCell = element(doc, 'td');
      productionCell.append(segmentValue(doc, item.production));
      const shadowCell = element(doc, 'td');
      shadowCell.append(segmentValue(doc, item.shadow));
      row.append(productionCell, shadowCell);
      body.append(row);
    });
    table.append(body);
    wrapper.append(table);
    section.append(wrapper);
    return section;
  }

  function titleCase(value) {
    return String(value || EMPTY).replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function render(container, report, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    if (!container || !documentRef) throw new Error('A document and report container are required.');
    container.replaceChildren();
    const production = report?.strategies?.production || {};
    const shadow = report?.strategies?.robust_conservative_v1 || {};
    const summary = element(documentRef, 'div', 'strategy-summary-grid');
    STRATEGIES.forEach(definition => summary.append(strategyCard(documentRef, definition, definition.key === 'production' ? production : shadow)));
    container.append(summary);

    const productionBets = number(production.singles?.bets) || 0;
    const shadowBets = number(shadow.singles?.bets) || 0;
    if (productionBets + shadowBets === 0) {
      container.append(element(documentRef, 'div', 'notice warning', 'No settled optimizer selections are available in this window. Metrics remain unavailable rather than zero-performance claims.'));
    } else if (productionBets < 100 || shadowBets < 100) {
      container.append(element(documentRef, 'div', 'notice warning', 'Small or missing samples: these diagnostics do not establish an edge and cannot activate the shadow strategy.'));
    }
    container.append(comparisonTable(documentRef, production, shadow));
    const segments = element(documentRef, 'div', 'segment-grid');
    segments.append(
      segmentTable(documentRef, 'By market', production, shadow, 'market'),
      segmentTable(documentRef, 'By league', production, shadow, 'league'),
      segmentTable(documentRef, 'By odds band', production, shadow, 'odds_band')
    );
    container.append(segments);
    container.append(element(documentRef, 'p', 'methodology-note', 'One flat unit per bet. DNB/void singles return stake; void accumulator legs are removed from effective odds. Production means optimizer output, not necessarily a published official ticket. CLV is taken odds ÷ closing odds − 1 and is shown only when closing prices exist.'));
  }

  function renderLoading(container, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    container.replaceChildren(element(documentRef, 'div', 'empty-state', 'Loading aggregated strategy diagnostics…'));
  }

  function renderError(container, message, doc) {
    const documentRef = doc || (typeof document !== 'undefined' ? document : null);
    container.replaceChildren(element(documentRef, 'div', 'notice warning', message || 'Strategy diagnostics could not be loaded.'));
  }

  return {
    formatInteger,
    formatPercent,
    formatUnits,
    formatOdds,
    formatDecimal,
    formatClv,
    formatClvCoverage,
    selectedProbability,
    metricRows,
    formatMetric,
    mergeSegments,
    titleCase,
    render,
    renderLoading,
    renderError,
    renderModelHealth,
    renderHealthError,
    renderHealthLoading
  };
});
