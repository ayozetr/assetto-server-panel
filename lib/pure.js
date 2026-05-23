'use strict';
// Pure helpers, exported as their own module so tools/unit-tests.js can
// import them without booting the HTTP server, opening the DB or starting
// the log-tail watcher. Functions here MUST stay free of I/O and free of
// any reference to the panel-wide singletons (db, log, sse clients) so
// they're equally usable from production server.js and from the test
// harness. Add to this list as the panel grows — anything that's "given X,
// return Y" with no side effect belongs here.

// RFC 4180 CSV cell: quote any field that contains a quote, comma or any
// newline; escape internal quotes by doubling them.
function _csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Heuristic log line parser for acServer output. acServer emits unstructured
// English prose, so classification is best-effort: word-boundary regex
// matches narrow the false positive rate, but if AC ever changes its strings
// or runs in another language the worst case is "info" tag/level — never a
// crash. The frontend filters by these levels so accuracy isn't load-bearing.
const _LVL_ERROR   = /\b(error|exception|fatal|fail(ed|ure)?)\b/i;
const _LVL_WARN    = /\b(warn(ing)?|deprecated|skipped|missing)\b/i;
const _LVL_OK      = /\b(connected|joined|lap completed|validated|best lap|ok|success)\b/i;
const _TAG_BRACKET = /\[([A-Z_0-9]{2,12})\]/;
const _TAG_HTTP    = /^(PAGE:|Serve |GET |POST |HEAD )/;
const _TAG_CFG     = /^(REQ|\{)/;
const _TIME        = /(\d{2}:\d{2}:\d{2})/;

function parseLine(raw, id) {
  const lvl = _LVL_ERROR.test(raw) ? 'error'
            : _LVL_WARN.test(raw)  ? 'warn'
            : _LVL_OK.test(raw)    ? 'ok'
            : 'info';
  const tm  = raw.match(_TAG_BRACKET);
  const tag = tm                          ? tm[1]
            : _TAG_HTTP.test(raw)         ? 'HTTP'
            : _TAG_CFG.test(raw.trim())   ? 'CFG'
            : 'SRV';
  const timeMatch = raw.match(_TIME);
  return { id, time: timeMatch ? timeMatch[1] : '', lvl, tag, msg: raw };
}

module.exports = { _csvCell, parseLine };
