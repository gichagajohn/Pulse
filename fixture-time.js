(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.FixtureTime = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // Supabase timestamptz values normally include Z or an offset. Treat a
  // zone-less timestamp as UTC too, because the database column is explicitly
  // kickoff_utc; never let the visitor's device timezone reinterpret it.
  function parseKickoffUtc(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    let text = value.trim();
    if (!text || /^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(text)) text = text.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text) && !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
      text += 'Z';
    }
    const parsed = new Date(text);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  function formatKickoffEAT(value) {
    const parsed = parseKickoffUtc(value);
    if (!parsed) return '';
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Nairobi',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).formatToParts(parsed).reduce((result, part) => {
      if (part.type !== 'literal') result[part.type] = part.value;
      return result;
    }, {});
    return `${parts.day} ${parts.month} · ${parts.hour}:${parts.minute} EAT`;
  }

  function kickoffISOString(value) {
    const parsed = parseKickoffUtc(value);
    return parsed ? parsed.toISOString() : '';
  }

  return { parseKickoffUtc, formatKickoffEAT, kickoffISOString };
});
