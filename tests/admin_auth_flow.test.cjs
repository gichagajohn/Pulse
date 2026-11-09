const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const htmlIds = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  toggle(name, force) {
    if (force) this.values.add(name);
    else this.values.delete(name);
  }
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.children = [];
    this.style = {};
    this.dataset = {};
    this.attributes = {};
    this.classList = new FakeClassList();
    this.listeners = {};
    this.hidden = false;
    this.disabled = false;
    this.validity = { valid: true };
    this.value = '';
    this.textContent = '';
    this.className = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(name, callback) { this.listeners[name] = callback; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}

function emptyOverview() {
  return {
    generated_at: '2026-11-06T18:00:00Z',
    metrics: {},
    revenue_by_day: [],
    revenue_by_plan: [],
    purchases_by_status: []
  };
}

async function createHarness({ session, isAdmin, strategyReport = {}, healthReport = {} }) {
  const tabNames = ['overview', 'strategy', 'tickets', 'users', 'purchases'];
  const navButtons = tabNames.map(tab => {
    const button = new FakeElement(`tab-${tab}`);
    button.dataset.tab = tab;
    return button;
  });
  const document = {
    elements: {},
    listeners: {},
    getElementById(id) { return this.elements[id] || null; },
    createElement() { return new FakeElement(); },
    createTextNode(text) { return String(text); },
    querySelectorAll(selector) {
      if (selector === '[data-tab]') return navButtons;
      if (selector === '.tab-panel') return tabNames.map(tab => this.elements[`panel-${tab}`]);
      return [];
    },
    addEventListener(name, callback) { this.listeners[name] = callback; },
    body: new FakeElement('body')
  };
  htmlIds.forEach(id => { document.elements[id] = new FakeElement(id); });
  const calls = [];
  const client = {
    auth: {
      onAuthStateChange() {},
      async getSession() { return { data: { session }, error: null }; },
      async signInWithPassword() { return { error: null }; },
      async signOut() { return { error: null }; }
    },
    async rpc(name, params) {
      calls.push({ name, params });
      if (name === 'is_admin') return { data: isAdmin, error: null };
      if (name === 'admin_dashboard_overview') return { data: emptyOverview(), error: null };
      if (name === 'admin_strategy_report') return { data: strategyReport, error: null };
      if (name === 'admin_model_intelligence_report') return { data: healthReport, error: null };
      throw new Error(`Unexpected RPC: ${name}`);
    }
  };
  const context = vm.createContext({
    document,
    window: {
      supabase: { createClient() { return client; } },
      location: { origin: 'https://pulse-iota-teal.vercel.app' },
      AdminStrategyView: {
        renderLoading(element) { element.textContent = 'Loading strategy'; },
        render(element, data) {
          element.textContent = `Rendered strategy: ${data.marker || 'empty'}`;
        },
        renderError(element, message) { element.textContent = message; },
        renderHealthLoading(element) { element.textContent = 'Loading model health'; },
        renderModelHealth(element, data) {
          element.textContent = `Rendered model health: ${data.marker || 'empty'}`;
        },
        renderHealthError(element, message) { element.textContent = message; }
      }
    },
    console,
    setTimeout,
    clearTimeout,
    Intl,
    Date,
    Number,
    Math,
    Set,
    Array,
    Object,
    String,
    Boolean,
    RegExp,
    JSON,
    Promise
  });
  vm.runInContext(source, context);
  document.listeners.DOMContentLoaded();
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  return {
    document,
    calls,
    el: id => document.getElementById(id),
    async clickTab(tab) {
      const button = navButtons.find(candidate => candidate.dataset.tab === tab);
      button.listeners.click();
      await new Promise(resolve => setImmediate(resolve));
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('signed-out startup shows only the admin sign-in view', async () => {
  const h = await createHarness({ session: null, isAdmin: false });
  assert.equal(h.el('authView').hidden, false);
  assert.equal(h.el('appView').hidden, true);
  assert.equal(h.el('deniedView').hidden, true);
  assert.equal(h.calls.length, 0);
});

test('a non-admin session is denied before private RPCs are called', async () => {
  const session = { access_token: 'user-token', user: { email: 'customer@example.com' } };
  const h = await createHarness({ session, isAdmin: false });
  assert.equal(h.el('deniedView').hidden, false);
  assert.equal(h.el('appView').hidden, true);
  assert.match(h.el('deniedMessage').textContent, /customer@example\.com/);
  assert.deepEqual(h.calls.map(call => call.name), ['is_admin']);
});

test('an allowlisted admin reaches the overview through authorised RPCs', async () => {
  const session = { access_token: 'admin-token', user: { email: 'admin@example.com' } };
  const h = await createHarness({ session, isAdmin: true });
  assert.equal(h.el('appView').hidden, false);
  assert.equal(h.el('authView').hidden, true);
  assert.equal(h.el('deniedView').hidden, true);
  assert.deepEqual(h.calls.map(call => call.name), ['is_admin', 'admin_dashboard_overview']);
  assert.equal(h.el('adminIdentity').textContent, 'admin@example.com');
  assert.equal(h.el('totalRevenue').textContent, 'KSh 0');
});

test('an admin can open Model lab and reload its aggregate RPCs with a new window', async () => {
  const session = { access_token: 'admin-token', user: { email: 'admin@example.com' } };
  const h = await createHarness({ session, isAdmin: true, strategyReport: { marker: 'verified' }, healthReport: { marker: 'checked' } });
  const lastCall = name => [...h.calls].reverse().find(call => call.name === name);
  await h.clickTab('strategy');
  assert.equal(h.el('pageTitle').textContent, 'Model lab');
  assert.equal(h.el('panel-strategy').hidden, false);
  assert.equal(h.el('panel-overview').hidden, true);
  assert.equal(h.el('strategyReport').textContent, 'Rendered strategy: verified');
  assert.equal(h.el('modelHealthReport').textContent, 'Rendered model health: checked');
  assert.equal(lastCall('admin_strategy_report').params.p_days, 90);
  assert.equal(lastCall('admin_model_intelligence_report').params.p_days, 90);

  h.el('strategyWindow').value = '30';
  h.el('strategyWindow').listeners.change({ target: h.el('strategyWindow') });
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lastCall('admin_strategy_report').params.p_days, 30);
  assert.equal(lastCall('admin_model_intelligence_report').params.p_days, 30);
});
