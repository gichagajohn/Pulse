(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PulsePhone = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // Accept Kenyan mobile numbers in local (07xx/01xx), national (7xx/1xx),
  // or international (+254/254) form; always return digits in 254 format.
  function normalizeKenyanMobile(raw) {
    if (typeof raw !== 'string') return null;
    const compact = raw.trim().replace(/[\s().-]/g, '');
    if (!/^\+?\d+$/.test(compact)) return null;
    let digits = compact.startsWith('+') ? compact.slice(1) : compact;

    if (/^0[17]\d{8}$/.test(digits)) digits = `254${digits.slice(1)}`;
    else if (/^[17]\d{8}$/.test(digits)) digits = `254${digits}`;

    return /^254[17]\d{8}$/.test(digits) ? digits : null;
  }

  function maskKenyanMobile(normalized) {
    if (!/^254[17]\d{8}$/.test(String(normalized || ''))) return '';
    return `${normalized.slice(0, 4)}•• ••• ${normalized.slice(-3)}`;
  }

  return Object.freeze({ normalizeKenyanMobile, maskKenyanMobile });
});
