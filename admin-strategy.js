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

  function selectedProbability(strategy, preferRobust) {
    const probability = strategy?.probability || {};
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
    renderError
  };
});
