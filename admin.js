'use strict';

const AdminUtils = (() => {
  function number(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatNumber(value) {
    return number(value).toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  function formatCurrency(value) {
    const amount = number(value);
    return `KSh ${amount.toLocaleString('en-KE', {
      minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2
    })}`;
  }

  function formatPercent(value) {
    return `${number(value).toFixed(1)}%`;
  }

  function formatConfidence(value) {
    const confidence = number(value);
    return formatPercent(confidence > 0 && confidence <= 1 ? confidence * 100 : confidence);
  }

  function formatDateTime(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return `${new Intl.DateTimeFormat('en-KE', {
      timeZone: 'Africa/Nairobi',
      dateStyle: 'medium',
      timeStyle: 'short'
    }).format(date)} EAT`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);
    if (Number.isNaN(date.getTime())) return '—';
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'UTC',
      day: '2-digit',
      month: 'short',
      year: 'numeric'
    }).format(date);
  }

  function formatShortDay(value) {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return value || '—';
    return new Intl.DateTimeFormat('en-KE', {
      timeZone: 'UTC', day: '2-digit', month: 'short'
    }).format(date);
  }

  function shortAmount(value) {
    const amount = number(value);
    if (amount >= 1000) {
      const thousands = amount / 1000;
      return `${thousands.toFixed(thousands >= 10 || Number.isInteger(thousands) ? 0 : 1)}k`;
    }
    return amount.toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  function titleCase(value) {
    return String(value || '—')
      .replace(/_/g, ' ')
      .replace(/\b\w/g, letter => letter.toUpperCase());
  }

  function statusClass(status) {
    const normalized = String(status || '').toLowerCase();
    const allowed = new Set([
      'success', 'active', 'win', 'published', 'pending', 'medium', 'failed',
      'loss', 'no_bet', 'expired', 'void', 'review'
    ]);
    return allowed.has(normalized) ? normalized : 'neutral';
  }

  function csvValue(value) {
    let text;
    if (value === null || value === undefined) text = '';
    else if (value instanceof Date) text = value.toISOString();
    else if (typeof value === 'object') text = JSON.stringify(value);
    else text = String(value);

    // Prevent user-controlled text cells from becoming spreadsheet formulas.
    // Numeric values remain numeric so negative amounts are not changed into text.
    if (typeof value === 'string' && /^\s*[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  }

  function toCsv(headers, rows) {
    return [headers, ...rows]
      .map(row => row.map(csvValue).join(','))
      .join('\r\n');
  }

  function pagination(total, offset, limit) {
    const safeTotal = Math.max(0, Math.floor(number(total)));
    const safeOffset = Math.max(0, Math.floor(number(offset)));
    const safeLimit = Math.max(1, Math.floor(number(limit)));
    const totalPages = Math.max(1, Math.ceil(safeTotal / safeLimit));
    return {
      start: safeTotal === 0 ? 0 : Math.min(safeOffset + 1, safeTotal),
      end: Math.min(safeOffset + safeLimit, safeTotal),
      total: safeTotal,
      page: Math.floor(safeOffset / safeLimit) + 1,
      totalPages,
      hasPrevious: safeOffset > 0 && safeTotal > 0,
      hasNext: safeOffset + safeLimit < safeTotal
    };
  }

  return {
    number,
    formatNumber,
    formatCurrency,
    formatPercent,
    formatConfidence,
    formatDateTime,
    formatDate,
    formatShortDay,
    shortAmount,
    titleCase,
    statusClass,
    csvValue,
    toCsv,
    pagination
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = AdminUtils;
}

if (typeof document !== 'undefined') {
  (() => {
    const SUPABASE_URL = 'https://lvadrzrbfxpizvwimqtf.supabase.co';
    const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imx2YWRyenJiZnhwaXp2d2ltcXRmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQzODM5MzYsImV4cCI6MjA5OTk1OTkzNn0.7jA6nnFbFxdZ5PKgf5TsdzdRj_xtAYNOCYECAUfGRFY';
    const sb = window.supabase
      ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
      : null;

    const state = {
      session: null,
      isAdmin: false,
      activeTab: 'overview',
      overviewRequest: 0,
      authRequest: 0,
      strategy: { days: 90, request: 0 },
      users: { search: '', offset: 0, limit: 25, total: 0, rows: [], request: 0, rpc: 'admin_list_users' },
      purchases: { search: '', status: 'all', offset: 0, limit: 25, total: 0, rows: [], request: 0, rpc: 'admin_list_purchases' },
      tickets: { search: '', status: 'all', offset: 0, limit: 10, total: 0, rows: [], request: 0, rpc: 'admin_list_tickets' }
    };
    const debounceTimers = {};
    const tabTitles = { overview: 'Overview', strategy: 'Model lab', tickets: 'Full tickets', users: 'Accounts', purchases: 'Purchases' };
    let toastTimer = null;

    const byId = id => document.getElementById(id);
    const text = (value, fallback = '—') => value === null || value === undefined || value === '' ? fallback : String(value);

    function makeElement(tag, className, content) {
      const element = document.createElement(tag);
      if (className) element.className = className;
      if (content !== undefined && content !== null) element.textContent = String(content);
      return element;
    }

    function clearElement(element) {
      element.replaceChildren();
    }

    function setText(id, value) {
      byId(id).textContent = value;
    }

    function showView(view) {
      byId('authView').hidden = view !== 'auth';
      byId('deniedView').hidden = view !== 'denied';
      byId('loadingView').hidden = view !== 'loading';
      byId('appView').hidden = view !== 'app';
    }

    function showMessage(element, message, type = 'error') {
      element.textContent = message || '';
      element.className = `notice${type === 'error' ? '' : ` ${type}`}`;
      element.hidden = !message;
    }

    function clearGlobalAlert() {
      showMessage(byId('globalAlert'), '');
    }

    function showGlobalAlert(message, type = 'error') {
      showMessage(byId('globalAlert'), message, type);
    }

    function showToast(message) {
      const toast = byId('toast');
      toast.textContent = message;
      toast.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => { toast.hidden = true; }, 3200);
    }

    function friendlyError(error) {
      return error?.message || 'The request could not be completed. Please try again.';
    }

    function statusBadge(status, label) {
      return makeElement('span', `status-badge ${AdminUtils.statusClass(status)}`, label || AdminUtils.titleCase(status));
    }

    function setLastUpdated(value) {
      setText('lastUpdated', AdminUtils.formatDateTime(value || new Date().toISOString()));
    }

    async function handleSession(session) {
      const request = ++state.authRequest;
      state.session = session;
      state.isAdmin = false;
      if (!session) {
        showView('auth');
        return;
      }

      showView('loading');
      const { data: isAdmin, error } = await sb.rpc('is_admin');
      if (request !== state.authRequest) return;
      if (error) {
        setText('deniedMessage', `Administrator access could not be verified: ${friendlyError(error)}`);
        showView('denied');
        return;
      }
      if (!isAdmin) {
        setText('deniedMessage', `${session.user?.email || 'This account'} is signed in, but it is not on the admin allowlist.`);
        showView('denied');
        return;
      }

      state.isAdmin = true;
      setText('adminIdentity', session.user?.email || 'Administrator');
      showView('app');
      await loadTab(state.activeTab);
    }

    async function handleAuthSubmit(event) {
      event.preventDefault();
      const email = byId('adminEmail').value.trim();
      const password = byId('adminPassword').value;
      const message = byId('authMessage');
      showMessage(message, '');
      if (!email || !byId('adminEmail').validity.valid || !password) {
        showMessage(message, 'Enter a valid email address and password.');
        return;
      }

      const button = byId('adminSignInButton');
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) showMessage(message, friendlyError(error));
      } catch (error) {
        showMessage(message, friendlyError(error));
      } finally {
        button.disabled = false;
        button.textContent = 'Sign in securely';
      }
    }

    async function handleAdminForgotPassword() {
      const emailInput = byId('adminEmail');
      const email = emailInput.value.trim();
      const message = byId('authMessage');
      showMessage(message, '');
      if (!email || !emailInput.validity.valid) {
        showMessage(message, 'Enter your admin email address first.');
        return;
      }
      const button = byId('adminForgotButton');
      button.disabled = true;
      try {
        const { error } = await sb.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/`
        });
        if (error) showMessage(message, friendlyError(error));
        else showMessage(message, 'If the account exists, a reset link has been sent. Open it to choose a new password on the main website.', 'success');
      } catch (error) {
        showMessage(message, friendlyError(error));
      } finally {
        button.disabled = false;
      }
    }

    async function signOut() {
      await sb.auth.signOut();
      state.isAdmin = false;
      state.session = null;
      byId('adminPassword').value = '';
      showView('auth');
    }

    function switchTab(tab) {
      if (!tabTitles[tab]) return;
      state.activeTab = tab;
      setText('pageTitle', tabTitles[tab]);
      document.querySelectorAll('[data-tab]').forEach(button => {
        button.classList.toggle('active', button.dataset.tab === tab);
      });
      document.querySelectorAll('.tab-panel').forEach(panel => {
        panel.hidden = panel.id !== `panel-${tab}`;
      });
      clearGlobalAlert();
      void loadTab(tab);
    }

    async function loadTab(tab) {
      if (!state.isAdmin) return;
      if (tab === 'overview') await loadOverview();
      else if (tab === 'strategy') await loadStrategy();
      else await loadCollection(tab);
    }

    async function loadOverview() {
      const request = ++state.overviewRequest;
      clearGlobalAlert();
      const { data, error } = await sb.rpc('admin_dashboard_overview');
      if (request !== state.overviewRequest) return;
      if (error) {
        showGlobalAlert(`Overview could not be loaded: ${friendlyError(error)}`);
        return;
      }
      renderOverview(data || {});
      setLastUpdated(data?.generated_at);
    }

    async function loadStrategy() {
      if (!state.isAdmin) return;
      const request = ++state.strategy.request;
      const view = window.AdminStrategyView;
      clearGlobalAlert();
      if (!view) {
        showGlobalAlert('Model lab could not be loaded because its rendering module is unavailable.');
        return;
      }
      view.renderLoading(byId('strategyReport'));
      view.renderHealthLoading(byId('modelHealthReport'));
      const strategyPromise = sb.rpc('admin_strategy_report', { p_days: state.strategy.days });
      const healthPromise = sb.rpc('admin_model_intelligence_report', { p_days: state.strategy.days });
      const [{ data, error }, healthResult] = await Promise.all([strategyPromise, healthPromise]);
      if (request !== state.strategy.request) return;
      if (error) {
        view.renderError(byId('strategyReport'), `Strategy diagnostics could not be loaded: ${friendlyError(error)}`);
      } else {
        try {
          view.render(byId('strategyReport'), data || {});
        } catch (renderError) {
          view.renderError(byId('strategyReport'), `Strategy diagnostics could not be rendered: ${friendlyError(renderError)}`);
        }
      }
      try {
        if (healthResult?.error) view.renderHealthError(byId('modelHealthReport'), `Model health diagnostics could not be loaded: ${friendlyError(healthResult.error)}`);
        else view.renderModelHealth(byId('modelHealthReport'), healthResult?.data || {});
      } catch (healthError) {
        view.renderHealthError(byId('modelHealthReport'), `Model health diagnostics could not be rendered: ${friendlyError(healthError)}`);
      }
      setLastUpdated(data?.generated_at);
    }

    async function loadCollection(kind) {
      const collection = state[kind];
      const request = ++collection.request;
      clearGlobalAlert();
      renderCollectionLoading(kind);
      const params = {
        p_search: collection.search,
        p_limit: collection.limit,
        p_offset: collection.offset
      };
      if (kind !== 'users') params.p_status = collection.status;

      const { data, error } = await sb.rpc(collection.rpc, params);
      if (request !== collection.request) return;
      if (error) {
        collection.rows = [];
        collection.total = 0;
        renderCollectionError(kind, friendlyError(error));
        renderPagination(kind);
        showGlobalAlert(`${tabTitles[kind]} could not be loaded: ${friendlyError(error)}`);
        return;
      }
      collection.rows = Array.isArray(data?.rows) ? data.rows : [];
      collection.total = AdminUtils.number(data?.total);
      if (kind === 'users') renderUsers(collection.rows);
      else if (kind === 'purchases') renderPurchases(collection.rows);
      else renderTickets(collection.rows);
      renderPagination(kind);
      setLastUpdated(new Date().toISOString());
    }

    function renderCollectionLoading(kind) {
      const message = makeElement('div', 'empty-state', 'Loading…');
      if (kind === 'tickets') {
        clearElement(byId('ticketsList'));
        byId('ticketsList').append(message);
      } else {
        const body = byId(kind === 'users' ? 'usersTableBody' : 'purchasesTableBody');
        clearElement(body);
        const row = makeElement('tr');
        const cell = makeElement('td', 'empty-state', 'Loading…');
        cell.colSpan = 8;
        row.append(cell);
        body.append(row);
      }
    }

    function renderCollectionError(kind, message) {
      if (kind === 'tickets') {
        clearElement(byId('ticketsList'));
        byId('ticketsList').append(makeElement('div', 'empty-state', message));
      } else {
        const body = byId(kind === 'users' ? 'usersTableBody' : 'purchasesTableBody');
        clearElement(body);
        const row = makeElement('tr');
        const cell = makeElement('td', 'empty-state', message);
        cell.colSpan = 8;
        row.append(cell);
        body.append(row);
      }
    }

    function renderPagination(kind) {
      const collection = state[kind];
      const container = byId(`${kind}Pagination`);
      clearElement(container);
      const page = AdminUtils.pagination(collection.total, collection.offset, collection.limit);
      container.append(makeElement('span', '', page.total
        ? `Showing ${page.start}–${page.end} of ${page.total} · Page ${page.page} of ${page.totalPages}`
        : 'No matching records'));
      const actions = makeElement('div', 'pagination-actions');
      const previous = makeElement('button', 'button button-secondary', '← Previous');
      previous.type = 'button';
      previous.disabled = !page.hasPrevious;
      previous.addEventListener('click', () => {
        collection.offset = Math.max(0, collection.offset - collection.limit);
        void loadCollection(kind);
      });
      const next = makeElement('button', 'button button-secondary', 'Next →');
      next.type = 'button';
      next.disabled = !page.hasNext;
      next.addEventListener('click', () => {
        collection.offset += collection.limit;
        void loadCollection(kind);
      });
      actions.append(previous, next);
      container.append(actions);
    }

    function renderOverview(data) {
      const metrics = data.metrics || {};
      setText('totalRevenue', AdminUtils.formatCurrency(metrics.total_revenue));
      setText('revenueToday', AdminUtils.formatCurrency(metrics.revenue_today));
      setText('revenue30d', AdminUtils.formatCurrency(metrics.revenue_30d));
      setText('totalUsers', AdminUtils.formatNumber(metrics.total_users));
      setText('newUsers30d', `${AdminUtils.formatNumber(metrics.new_users_30d)} joined in the last 30 days`);
      setText('activePasses', AdminUtils.formatNumber(metrics.active_passes));
      setText('publishedTickets', AdminUtils.formatNumber(metrics.published_tickets));
      setText('totalTickets', `${AdminUtils.formatNumber(metrics.total_tickets)} total ticket records`);
      setText('successfulPurchases', AdminUtils.formatNumber(metrics.successful_purchases));
      setText('pendingPurchases', `${AdminUtils.formatNumber(metrics.pending_purchases)} pending · ${AdminUtils.formatNumber(metrics.failed_purchases)} failed`);
      setText('winRate', AdminUtils.formatPercent(metrics.win_rate));
      setText('settledSelections', `${AdminUtils.formatNumber(metrics.settled_selections)} settled selections`);
      renderRevenueChart(Array.isArray(data.revenue_by_day) ? data.revenue_by_day : []);
      renderPlanBreakdown(Array.isArray(data.revenue_by_plan) ? data.revenue_by_plan : []);
      renderStatusBreakdown(Array.isArray(data.purchases_by_status) ? data.purchases_by_status : []);
      renderDataHealth(metrics);
    }

    function renderRevenueChart(rows) {
      const chart = byId('revenueChart');
      clearElement(chart);
      if (!rows.length) {
        chart.append(makeElement('div', 'empty-state', 'No revenue history is available.'));
        return;
      }
      const maximum = Math.max(0, ...rows.map(row => AdminUtils.number(row.amount)));
      rows.forEach(row => {
        const amount = AdminUtils.number(row.amount);
        const column = makeElement('div', 'chart-column');
        column.title = `${AdminUtils.formatDate(row.day)}: ${AdminUtils.formatCurrency(amount)} from ${AdminUtils.formatNumber(row.purchases)} purchase(s)`;
        const value = makeElement('span', 'chart-value', AdminUtils.shortAmount(amount));
        const track = makeElement('div', 'chart-bar-track');
        const bar = makeElement('div', 'chart-bar');
        bar.style.height = maximum > 0 ? `${Math.max(amount > 0 ? 3 : 0, (amount / maximum) * 100)}%` : '0%';
        track.append(bar);
        const day = makeElement('span', 'chart-day', AdminUtils.formatShortDay(row.day));
        column.append(value, track, day);
        chart.append(column);
      });
    }

    function renderPlanBreakdown(rows) {
      const container = byId('planBreakdown');
      clearElement(container);
      if (!rows.length) {
        container.append(makeElement('div', 'empty-state', 'No confirmed paid purchases yet.'));
        return;
      }
      rows.forEach(row => {
        const line = makeElement('div', 'breakdown-row');
        const label = makeElement('div');
        label.append(makeElement('strong', '', AdminUtils.titleCase(row.plan)), makeElement('small', '', `${AdminUtils.formatNumber(row.purchases)} paid purchase(s)`));
        line.append(label, makeElement('span', 'breakdown-value', AdminUtils.formatCurrency(row.amount)));
        container.append(line);
      });
    }

    function renderStatusBreakdown(rows) {
      const container = byId('statusBreakdown');
      clearElement(container);
      if (!rows.length) {
        container.append(makeElement('div', 'empty-state', 'No purchase attempts recorded.'));
        return;
      }
      rows.forEach(row => {
        const line = makeElement('div', 'breakdown-row');
        const label = makeElement('div');
        label.append(makeElement('strong', '', AdminUtils.titleCase(row.status)));
        line.append(label, makeElement('span', 'breakdown-value', AdminUtils.formatNumber(row.purchases)));
        container.append(line);
      });
    }

    function renderDataHealth(metrics) {
      const container = byId('dataHealth');
      clearElement(container);
      const unlinked = AdminUtils.number(metrics.unlinked_successes);
      const mismatches = AdminUtils.number(metrics.ticket_mismatches);
      const pending = AdminUtils.number(metrics.pending_purchases);
      if (unlinked > 0) {
        addHealthRow(container, 'warning', 'Provider payments need reconciliation', `${AdminUtils.formatNumber(unlinked)} successful provider attempt(s) are not linked to the confirmed subscription revenue ledger.`);
      }
      if (mismatches > 0) {
        addHealthRow(container, 'warning', 'Ticket selection counts differ', `${AdminUtils.formatNumber(mismatches)} published ticket(s) have a stored selection count different from their linked selection rows. Open Full tickets to inspect them.`);
      }
      if (pending > 0) {
        addHealthRow(container, '', 'Pending purchase attempts', `${AdminUtils.formatNumber(pending)} attempt(s) are still pending and are excluded from received revenue.`);
      }
      if (unlinked === 0 && mismatches === 0) {
        addHealthRow(container, 'good', 'No critical reconciliation issues', 'No unlinked provider successes or ticket selection-count mismatches were found.');
      }
    }

    function addHealthRow(container, type, title, body) {
      const row = makeElement('div', `health-row ${type}`.trim());
      row.append(makeElement('span', 'health-icon', type === 'good' ? '✓' : '•'));
      const copy = makeElement('div');
      copy.append(makeElement('strong', '', title), makeElement('p', '', body));
      row.append(copy);
      container.append(row);
    }

    function appendCell(row, primary, secondary, className = '') {
      const cell = makeElement('td', className);
      cell.append(makeElement('span', 'cell-primary', text(primary)));
      if (secondary) cell.append(makeElement('span', 'cell-secondary', secondary));
      row.append(cell);
      return cell;
    }

    function appendEmptyRow(body, message) {
      const row = makeElement('tr');
      const cell = makeElement('td', 'empty-state', message);
      cell.colSpan = 8;
      row.append(cell);
      body.append(row);
    }

    function renderUsers(rows) {
      const body = byId('usersTableBody');
      clearElement(body);
      if (!rows.length) {
        appendEmptyRow(body, 'No accounts match this search.');
        return;
      }
      rows.forEach(user => {
        const row = makeElement('tr');
        const displayName = user.full_name || user.email || 'Unnamed account';
        const accountCell = appendCell(row, displayName, user.email);
        accountCell.title = user.id;
        accountCell.append(makeElement('span', 'cell-secondary', `ID: ${user.id}`));
        accountCell.append(makeElement('span', 'cell-secondary', user.email_confirmed_at ? 'Email confirmed' : 'Email not confirmed'));
        appendCell(row, user.phone_number);
        appendCell(row, AdminUtils.formatDate(user.created_at));
        appendCell(row, AdminUtils.formatDateTime(user.last_sign_in_at));
        appendCell(row, AdminUtils.formatNumber(user.purchase_count));
        appendCell(row, AdminUtils.formatCurrency(user.total_spent), '', 'cell-number');
        if (user.active_pass_expires) {
          const cell = makeElement('td');
          cell.append(statusBadge('active', 'Active'));
          cell.append(makeElement('span', 'cell-secondary', `Until ${AdminUtils.formatDateTime(user.active_pass_expires)}`));
          row.append(cell);
        } else appendCell(row, 'No active pass');
        const roleCell = makeElement('td');
        roleCell.append(statusBadge(user.is_admin ? 'success' : 'neutral', user.is_admin ? 'Admin' : 'Customer'));
        row.append(roleCell);
        body.append(row);
      });
    }

    function renderPurchases(rows) {
      const body = byId('purchasesTableBody');
      clearElement(body);
      if (!rows.length) {
        appendEmptyRow(body, 'No purchases match these filters.');
        return;
      }
      rows.forEach(purchase => {
        const row = makeElement('tr');
        appendCell(row, AdminUtils.formatDateTime(purchase.created_at));
        const customerCell = appendCell(row, purchase.user_name || purchase.user_email || 'Unknown account', purchase.user_email);
        customerCell.title = purchase.user_id;
        appendCell(row, AdminUtils.titleCase(purchase.plan));
        appendCell(row, AdminUtils.formatCurrency(purchase.amount), purchase.is_paid ? 'Included in received revenue' : 'Not counted as received', 'cell-number');
        const statusCell = makeElement('td');
        statusCell.append(statusBadge(purchase.status));
        if (purchase.source === 'pending_payment' && purchase.status === 'success') {
          statusCell.append(makeElement('span', 'cell-secondary', 'Needs reconciliation'));
        }
        row.append(statusCell);
        appendCell(row, purchase.source === 'subscription' ? 'Subscription' : 'Provider attempt');
        const referenceCell = appendCell(row, purchase.reference, purchase.checkout_request_id);
        referenceCell.title = purchase.reference || purchase.checkout_request_id || '';
        appendCell(row, purchase.expires_at ? AdminUtils.formatDateTime(purchase.expires_at) : '—', purchase.started_at ? `Started ${AdminUtils.formatDateTime(purchase.started_at)}` : '');
        body.append(row);
      });
    }

    function renderTickets(rows) {
      const container = byId('ticketsList');
      clearElement(container);
      if (!rows.length) {
        container.append(makeElement('div', 'empty-state', 'No tickets match these filters.'));
        return;
      }
      rows.forEach(ticket => {
        const actualCount = AdminUtils.number(ticket.actual_selection_count);
        const expectedCount = AdminUtils.number(ticket.selection_count);
        const card = makeElement('article', 'ticket-card');
        const summary = makeElement('div', 'ticket-summary');
        const dateBlock = makeElement('div');
        const dateLine = makeElement('div', 'ticket-date', AdminUtils.formatDate(ticket.ticket_date));
        const badges = makeElement('div', 'cell-secondary');
        badges.append(statusBadge(ticket.status), document.createTextNode(` Ticket #${ticket.id}`));
        dateBlock.append(dateLine, badges);
        summary.append(dateBlock);
        summary.append(ticketStat('Combined odds', ticket.combined_odds === null || ticket.combined_odds === undefined ? '—' : AdminUtils.number(ticket.combined_odds).toFixed(2)));
        summary.append(ticketStat('Selections', `${actualCount} / ${expectedCount}`));
        summary.append(ticketStat('Confidence', AdminUtils.formatConfidence(ticket.final_confidence), 'optional'));
        const outcomeBlock = makeElement('div', 'ticket-stat optional');
        outcomeBlock.append(makeElement('small', '', 'Outcome'), statusBadge(ticket.outcome || 'pending'));
        summary.append(outcomeBlock);
        const toggle = makeElement('button', 'button button-secondary ticket-toggle', 'View full ticket');
        toggle.type = 'button';
        toggle.dataset.ticketId = ticket.id;
        toggle.setAttribute('aria-expanded', 'false');
        toggle.setAttribute('aria-controls', `ticket-details-${ticket.id}`);
        summary.append(toggle);
        card.append(summary);

        const details = makeElement('div', 'ticket-details');
        details.id = `ticket-details-${ticket.id}`;
        details.hidden = true;
        if (actualCount !== expectedCount) {
          details.append(makeElement('p', 'mismatch-note', `Selection mismatch: the ticket says ${expectedCount}, but ${actualCount} linked selection row(s) exist.`));
        }
        if (ticket.reason) details.append(makeElement('p', 'ticket-reason', ticket.reason));
        const selections = Array.isArray(ticket.selections) ? ticket.selections : [];
        if (!selections.length) details.append(makeElement('div', 'empty-state', 'No linked selections for this ticket.'));
        selections.forEach(selection => details.append(buildSelectionCard(selection)));
        if (ticket.ticket_text) {
          const raw = makeElement('details', 'raw-ticket');
          raw.append(makeElement('summary', '', 'View original full ticket text'));
          raw.append(makeElement('pre', '', ticket.ticket_text));
          details.append(raw);
        }
        card.append(details);
        container.append(card);
      });
    }

    function ticketStat(label, value, className = '') {
      const block = makeElement('div', `ticket-stat ${className}`.trim());
      block.append(makeElement('small', '', label), makeElement('strong', '', value));
      return block;
    }

    function buildSelectionCard(selection) {
      const card = makeElement('div', 'selection-card');
      const heading = makeElement('div', 'selection-heading');
      const teams = makeElement('div');
      teams.append(makeElement('strong', '', `${text(selection.home_team, 'Unknown home')} vs ${text(selection.away_team, 'Unknown away')}`));
      teams.append(makeElement('div', 'selection-meta', `${text(selection.league)} · Fixture ${text(selection.fixture_id)}`));
      heading.append(teams, statusBadge(selection.outcome || 'pending'));
      card.append(heading);
      const score = selection.home_score !== null && selection.away_score !== null
        ? ` · Final score ${selection.home_score}–${selection.away_score}`
        : '';
      const odds = selection.odds === null || selection.odds === undefined ? '—' : AdminUtils.number(selection.odds).toFixed(2);
      card.append(makeElement('div', 'selection-market', `${AdminUtils.titleCase(selection.market)} · Odds ${odds}${score}`));
      if (selection.rationale) card.append(makeElement('p', 'selection-rationale', selection.rationale));
      return card;
    }

    function exportCurrent(kind) {
      const collection = state[kind];
      if (!collection.rows.length) {
        showToast('There are no rows on this page to export.');
        return;
      }
      let filename;
      let csv;
      if (kind === 'users') {
        filename = 'football-pulse-accounts-page.csv';
        csv = AdminUtils.toCsv(
          ['User ID', 'Name', 'Email', 'Phone', 'Joined', 'Last sign in', 'Email confirmed', 'Paid purchases', 'Total spent KSh', 'Active pass expires', 'Admin'],
          collection.rows.map(user => [
            user.id, user.full_name, user.email, user.phone_number, user.created_at,
            user.last_sign_in_at, user.email_confirmed_at, user.purchase_count,
            user.total_spent, user.active_pass_expires, user.is_admin ? 'yes' : 'no'
          ])
        );
      } else if (kind === 'purchases') {
        filename = 'football-pulse-purchases-page.csv';
        csv = AdminUtils.toCsv(
          ['Payment ID', 'Source', 'Created', 'User ID', 'Customer', 'Email', 'Plan', 'Amount KSh', 'Status', 'Counted as revenue', 'Reference', 'Checkout request', 'Started', 'Expires'],
          collection.rows.map(purchase => [
            purchase.payment_id, purchase.source, purchase.created_at, purchase.user_id,
            purchase.user_name, purchase.user_email, purchase.plan, purchase.amount,
            purchase.status, purchase.is_paid ? 'yes' : 'no', purchase.reference,
            purchase.checkout_request_id, purchase.started_at, purchase.expires_at
          ])
        );
      } else {
        filename = 'football-pulse-tickets-page.csv';
        const rows = [];
        collection.rows.forEach(ticket => {
          const selections = Array.isArray(ticket.selections) && ticket.selections.length ? ticket.selections : [null];
          selections.forEach(selection => rows.push([
            ticket.id, ticket.ticket_date, ticket.status, ticket.outcome, ticket.combined_odds,
            ticket.final_confidence, ticket.risk_level, ticket.selection_count,
            ticket.actual_selection_count, selection?.fixture_id, selection?.home_team,
            selection?.away_team, selection?.league, selection?.market, selection?.odds,
            selection?.outcome, selection ? `${selection.home_score ?? ''}-${selection.away_score ?? ''}` : '',
            selection?.rationale, ticket.reason, ticket.ticket_text
          ]));
        });
        csv = AdminUtils.toCsv(
          ['Ticket ID', 'Date', 'Status', 'Outcome', 'Combined odds', 'Confidence', 'Risk', 'Stored selections', 'Actual selections', 'Fixture ID', 'Home', 'Away', 'League', 'Market', 'Selection odds', 'Selection outcome', 'Score', 'Rationale', 'Ticket reason', 'Original ticket text'],
          rows
        );
      }
      downloadCsv(filename, csv);
      showToast(`Exported the current ${tabTitles[kind].toLowerCase()} page.`);
    }

    function downloadCsv(filename, csv) {
      const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    function bindFilters() {
      const bindings = [
        ['ticketSearch', 'tickets', 'search'],
        ['userSearch', 'users', 'search'],
        ['purchaseSearch', 'purchases', 'search']
      ];
      bindings.forEach(([id, kind, property]) => {
        byId(id).addEventListener('input', event => {
          state[kind][property] = event.target.value.trim();
          state[kind].offset = 0;
          clearTimeout(debounceTimers[kind]);
          debounceTimers[kind] = setTimeout(() => void loadCollection(kind), 350);
        });
      });
      [['ticketStatus', 'tickets'], ['purchaseStatus', 'purchases']].forEach(([id, kind]) => {
        byId(id).addEventListener('change', event => {
          state[kind].status = event.target.value;
          state[kind].offset = 0;
          void loadCollection(kind);
        });
      });
      byId('strategyWindow').addEventListener('change', event => {
        const days = Number(event.target.value);
        state.strategy.days = Number.isFinite(days) ? Math.min(Math.max(Math.round(days), 1), 3650) : 90;
        void loadStrategy();
      });
    }

    async function init() {
      byId('adminAuthForm').addEventListener('submit', handleAuthSubmit);
      byId('adminForgotButton').addEventListener('click', () => void handleAdminForgotPassword());
      byId('signOutButton').addEventListener('click', () => void signOut());
      byId('deniedSignOutButton').addEventListener('click', () => void signOut());
      byId('refreshButton').addEventListener('click', async event => {
        event.currentTarget.disabled = true;
        try { await loadTab(state.activeTab); } finally { event.currentTarget.disabled = false; }
      });
      document.querySelectorAll('[data-tab]').forEach(button => {
        button.addEventListener('click', () => switchTab(button.dataset.tab));
      });
      document.querySelectorAll('[data-export]').forEach(button => {
        button.addEventListener('click', () => exportCurrent(button.dataset.export));
      });
      byId('ticketsList').addEventListener('click', event => {
        const button = event.target.closest('.ticket-toggle');
        if (!button) return;
        const details = byId(`ticket-details-${button.dataset.ticketId}`);
        if (!details) return;
        details.hidden = !details.hidden;
        button.setAttribute('aria-expanded', String(!details.hidden));
        button.textContent = details.hidden ? 'View full ticket' : 'Hide full ticket';
      });
      bindFilters();

      if (!sb) {
        showMessage(byId('authMessage'), 'The Supabase client could not be loaded. Check your connection and reload.');
        byId('adminSignInButton').disabled = true;
        return;
      }
      sb.auth.onAuthStateChange((_event, session) => { void handleSession(session); });
      const { data, error } = await sb.auth.getSession();
      if (error) {
        showView('auth');
        showMessage(byId('authMessage'), friendlyError(error));
        return;
      }
      await handleSession(data.session);
    }

    document.addEventListener('DOMContentLoaded', () => { void init(); });
  })();
}
