const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
  .map(match => match[1])
  .filter(source => source.trim());
const mainScript = inlineScripts.find(source => source.includes('const SUPABASE_URL'));
const authStart = mainScript.indexOf("  let authMode = 'signin';");
const authEnd = mainScript.indexOf('/* =================== END STEP 5 ADDITION');
const authSource = mainScript.slice(authStart, authEnd);

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach(name => this.values.add(name)); }
  remove(...names) { names.forEach(name => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
}

class FakeElement {
  constructor(id, document) {
    this.id = id;
    this.ownerDocument = document;
    this.style = {};
    this.classList = new FakeClassList();
    this.attributes = {};
    this.textContent = '';
    this.innerHTML = '';
    this.disabled = false;
    this.autocomplete = '';
    this.placeholder = '';
    this.type = id.toLowerCase().includes('password') ? 'password' : 'text';
    this.validity = { valid: true };
    this.parentElement = null;
    this._value = '';
  }
  get value() { return this._value; }
  set value(nextValue) {
    this._value = String(nextValue);
    if (this.id === 'authEmail') {
      this.validity.valid = this._value.trim() === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this._value.trim());
    }
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name]; }
  focus() { this.ownerDocument.activeElement = this; }
}

function makeDocument() {
  const document = {
    title: 'Football Pulse',
    elements: {},
    activeElement: null,
    getElementById(id) { return this.elements[id] || null; },
    querySelector(selector) { return selector === '.user-avatar' ? this.avatar : null; }
  };
  const ids = [
    'authFullName', 'authEmail', 'authPhone', 'authPassword', 'authPasswordConfirm',
    'authError', 'authSubmitBtn', 'authModalTitle', 'authModalDescription', 'authSwitchLine',
    'authNameField', 'authEmailField', 'authPhoneField', 'authPasswordField',
    'authConfirmField', 'authForgotRow', 'authModal', 'signInBtn', 'userChip', 'userEmail'
  ];
  ids.forEach(id => { document.elements[id] = new FakeElement(id, document); });
  document.body = new FakeElement('body', document);
  document.avatar = new FakeElement('avatar', document);
  document.activeElement = document.elements.signInBtn;

  ['authPassword', 'authPasswordConfirm'].forEach(id => {
    const input = document.elements[id];
    const wrapper = new FakeElement(`${id}Wrapper`, document);
    const eyeButton = new FakeElement(`${id}Eye`, document);
    wrapper.querySelector = selector => selector === '.auth-eye-toggle' ? eyeButton : null;
    input.parentElement = wrapper;
  });
  return document;
}

async function createHarness(options = {}) {
  const document = makeDocument();
  const timers = [];
  const calls = [];
  const state = {
    initialSession: options.initialSession || null,
    resetError: null,
    updateError: null,
    signInError: null,
    resetThrows: false
  };
  let authStateCallback = null;
  const window = {
    location: {
      origin: 'https://pulse-iota-teal.vercel.app',
      pathname: '/',
      hash: options.hash || ''
    },
    history: {
      calls: [],
      replaceState(...args) { this.calls.push(args); }
    }
  };
  const sb = {
    auth: {
      onAuthStateChange(callback) { authStateCallback = callback; },
      async getSession() { return { data: { session: state.initialSession } }; },
      async signInWithPassword(credentials) {
        calls.push({ method: 'signInWithPassword', credentials });
        return { data: { session: state.signInError ? null : { user: { email: credentials.email } } }, error: state.signInError };
      },
      async signUp(credentials) {
        calls.push({ method: 'signUp', credentials });
        return { data: { session: null }, error: null };
      },
      async resetPasswordForEmail(email, resetOptions) {
        calls.push({ method: 'resetPasswordForEmail', email, options: resetOptions });
        if (state.resetThrows) throw new Error('Network unavailable');
        return { error: state.resetError };
      },
      async updateUser(attributes) {
        calls.push({ method: 'updateUser', attributes });
        return { error: state.updateError };
      }
    }
  };
  const context = vm.createContext({
    document,
    window,
    sb,
    URLSearchParams,
    console,
    renderPicks() {},
    goTo() {},
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    }
  });
  vm.runInContext(`${authSource}\n;globalThis.__authTest = {
    getMode: () => authMode,
    getSession: () => currentSession,
    setSession: session => { currentSession = session; }
  };`, context);
  await Promise.resolve();
  await Promise.resolve();

  return {
    context,
    document,
    window,
    state,
    calls,
    timers,
    el: id => document.getElementById(id),
    mode: () => context.__authTest.getMode(),
    setSession: session => context.__authTest.setSession(session),
    async emitAuth(event, session) {
      await authStateCallback(event, session);
      await Promise.resolve();
    }
  };
}

const preventedEvent = { preventDefault() {} };

test('HTML and main JavaScript remain structurally valid', () => {
  assert.ok(mainScript, 'main inline script exists');
  assert.ok(authStart >= 0 && authEnd > authStart, 'auth section is extractable');
  assert.doesNotThrow(() => new vm.Script(mainScript));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, 'HTML IDs are unique');
  assert.match(html, /onclick="showForgotPassword\(event\)">Forgot password\?<\/a>/);
});

test('sign-in offers recovery and forgot mode preserves only the email', async () => {
  const h = await createHarness();
  h.context.openAuthModal('signin');
  assert.equal(h.mode(), 'signin');
  assert.equal(h.el('authForgotRow').style.display, 'block');
  assert.equal(h.el('authPasswordField').style.display, 'block');
  assert.equal(h.el('authConfirmField').style.display, 'none');

  h.el('authEmail').value = 'person@example.com';
  h.el('authPassword').value = 'old-secret';
  h.context.showForgotPassword(preventedEvent);
  assert.equal(h.mode(), 'forgot');
  assert.equal(h.el('authEmail').value, 'person@example.com');
  assert.equal(h.el('authPassword').value, '');
  assert.equal(h.el('authPasswordField').style.display, 'none');
  assert.equal(h.el('authEmailField').style.display, 'block');
  assert.equal(h.el('authConfirmField').style.display, 'none');
  assert.equal(h.el('authSubmitBtn').textContent, 'Send reset link');
});

test('reset request uses a trimmed email and a clean page redirect', async () => {
  const h = await createHarness();
  h.window.location.pathname = '/index.html';
  h.window.location.hash = '#access_token=do-not-send';
  h.context.openAuthModal('forgot');
  h.el('authEmail').value = ' person@example.com ';
  await h.context.handleAuthSubmit();

  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].method, 'resetPasswordForEmail');
  assert.equal(h.calls[0].email, 'person@example.com');
  assert.equal(h.calls[0].options.redirectTo, 'https://pulse-iota-teal.vercel.app/index.html');
  assert.match(h.el('authError').textContent, /If an account exists/);
  assert.ok(h.el('authError').classList.contains('success'));
  assert.equal(h.el('authSubmitBtn').disabled, false);
  assert.equal(h.el('authSubmitBtn').textContent, 'Send reset link');
});

test('invalid email and request failures do not pretend a reset was sent', async () => {
  const h = await createHarness();
  h.context.openAuthModal('forgot');
  h.el('authEmail').value = 'not-an-email';
  await h.context.handleAuthSubmit();
  assert.equal(h.calls.length, 0);
  assert.match(h.el('authError').textContent, /valid email/);

  h.el('authEmail').value = 'person@example.com';
  h.state.resetError = { message: 'Reset email could not be sent' };
  await h.context.handleAuthSubmit();
  assert.equal(h.calls.length, 1);
  assert.equal(h.el('authError').textContent, 'Reset email could not be sent');
  assert.equal(h.el('authError').classList.contains('success'), false);
  assert.equal(h.el('authSubmitBtn').disabled, false);

  h.state.resetError = null;
  h.state.resetThrows = true;
  await h.context.handleAuthSubmit();
  assert.equal(h.el('authError').textContent, 'Network unavailable');
  assert.equal(h.el('authSubmitBtn').disabled, false);
});

test('PASSWORD_RECOVERY opens the new-password form with a recovery session', async () => {
  const h = await createHarness();
  const session = { access_token: 'recovery-token', user: { email: 'person@example.com' } };
  await h.emitAuth('PASSWORD_RECOVERY', session);
  assert.equal(h.mode(), 'reset');
  assert.equal(h.context.__authTest.getSession(), session);
  assert.equal(h.el('authEmailField').style.display, 'none');
  assert.equal(h.el('authPasswordField').style.display, 'block');
  assert.equal(h.el('authConfirmField').style.display, 'block');
  assert.equal(h.el('authForgotRow').style.display, 'none');
  assert.equal(h.el('authSubmitBtn').textContent, 'Update password');
  assert.equal(h.el('authPassword').autocomplete, 'new-password');
});

test('implicit recovery hash also opens the new-password form', async () => {
  const session = { access_token: 'recovery-token', user: { email: 'person@example.com' } };
  const h = await createHarness({ initialSession: session, hash: '#type=recovery&access_token=recovery-token' });
  assert.equal(h.mode(), 'reset');
  assert.equal(h.context.__authTest.getSession(), session);
});

test('new-password validation blocks short, mismatched, and expired submissions', async () => {
  const h = await createHarness();
  await h.emitAuth('PASSWORD_RECOVERY', { access_token: 'token', user: {} });
  h.el('authPassword').value = '12345';
  h.el('authPasswordConfirm').value = '12345';
  await h.context.handleAuthSubmit();
  assert.match(h.el('authError').textContent, /at least 6/);

  h.el('authPassword').value = '123456';
  h.el('authPasswordConfirm').value = '654321';
  await h.context.handleAuthSubmit();
  assert.match(h.el('authError').textContent, /do not match/);

  h.el('authPasswordConfirm').value = '123456';
  h.setSession(null);
  await h.context.handleAuthSubmit();
  assert.match(h.el('authError').textContent, /invalid or expired/);
  assert.equal(h.calls.some(call => call.method === 'updateUser'), false);
});

test('successful password update clears secrets, cleans the URL, and restores the button', async () => {
  const h = await createHarness();
  h.window.location.pathname = '/';
  await h.emitAuth('PASSWORD_RECOVERY', { access_token: 'token', user: {} });
  h.el('authPassword').value = 'new-secret';
  h.el('authPasswordConfirm').value = 'new-secret';
  await h.context.handleAuthSubmit();

  const update = h.calls.find(call => call.method === 'updateUser');
  assert.ok(update);
  assert.equal(update.attributes.password, 'new-secret');
  assert.equal(Object.keys(update.attributes).length, 1);
  assert.equal(h.el('authPassword').value, '');
  assert.equal(h.el('authPasswordConfirm').value, '');
  assert.match(h.el('authError').textContent, /updated successfully/);
  assert.ok(h.el('authError').classList.contains('success'));
  assert.equal(h.window.history.calls.length, 1);
  assert.equal(h.window.history.calls[0][2], '/');
  assert.equal(h.el('authSubmitBtn').disabled, false);
  assert.equal(h.el('authSubmitBtn').textContent, 'Update password');

  const closeTimer = h.timers.find(timer => timer.delay === 1600);
  assert.ok(closeTimer);
  closeTimer.callback();
  assert.equal(h.el('authModal').getAttribute('aria-hidden'), 'true');
});

test('password update errors keep the form usable', async () => {
  const h = await createHarness();
  await h.emitAuth('PASSWORD_RECOVERY', { access_token: 'token', user: {} });
  h.state.updateError = { message: 'Recovery link has expired' };
  h.el('authPassword').value = 'new-secret';
  h.el('authPasswordConfirm').value = 'new-secret';
  await h.context.handleAuthSubmit();
  assert.equal(h.el('authError').textContent, 'Recovery link has expired');
  assert.equal(h.el('authPassword').value, 'new-secret');
  assert.equal(h.el('authSubmitBtn').disabled, false);
  assert.equal(h.window.history.calls.length, 0);
});

test('existing sign-in and sign-up submissions still use their Supabase methods', async () => {
  const h = await createHarness();
  h.context.openAuthModal('signin');
  h.el('authEmail').value = 'person@example.com';
  h.el('authPassword').value = 'current-secret';
  await h.context.handleAuthSubmit();
  assert.equal(h.calls[0].method, 'signInWithPassword');
  assert.equal(h.calls[0].credentials.email, 'person@example.com');
  assert.equal(h.el('authModal').getAttribute('aria-hidden'), 'true');

  h.context.openAuthModal('signup');
  h.el('authFullName').value = 'Test Person';
  h.el('authEmail').value = 'person@example.com';
  h.el('authPhone').value = '0712345678';
  h.el('authPassword').value = 'new-secret';
  h.el('authPasswordConfirm').value = 'new-secret';
  await h.context.handleAuthSubmit();
  const signup = h.calls.find(call => call.method === 'signUp');
  assert.ok(signup);
  assert.equal(signup.credentials.options.data.full_name, 'Test Person');
  assert.equal(signup.credentials.options.data.phone_number, '0712345678');
  assert.match(h.el('authError').textContent, /Check your email/);
});
