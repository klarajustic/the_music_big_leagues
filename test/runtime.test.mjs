/**
 * runtime.test.mjs — the Task 3 hardening helpers in src/Config.js.
 *
 * These touch LockService / SpreadsheetApp / Logger, so unlike the analytics
 * functions they can't just be evaluated in a bare scope. Config.js is evalled
 * with those three globals stubbed instead. The lock is the part worth testing:
 * Apps Script hands out a fresh Lock object per getScriptLock(), so a nested
 * waitLock() deadlocks an execution against itself, and ingestResults_ nests
 * three deep.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Evaluates src/Config.js against stubbed Apps Script globals. */
function loadConfig({ withUi = true } = {}) {
  const state = { alerts: [], logs: [], acquired: 0, released: 0, held: false, reentered: false };

  const stubs = {
    LockService: {
      getScriptLock: () => ({
        tryLock: () => {
          if (state.held) { state.reentered = true; return false; }
          state.held = true;
          state.acquired += 1;
          return true;
        },
        releaseLock: () => { state.held = false; state.released += 1; },
      }),
    },
    SpreadsheetApp: {
      getUi: () => {
        if (!withUi) throw new Error('Cannot call SpreadsheetApp.getUi() from this context.');
        return { alert: (m) => state.alerts.push(m) };
      },
      getActiveSpreadsheet: () => { throw new Error('no spreadsheet'); },
    },
    Logger: { log: (m) => state.logs.push(String(m)) },
    PropertiesService: undefined,
    CacheService: undefined,
    UrlFetchApp: undefined,
  };

  const names = Object.keys(stubs);
  const body = readFileSync(join(ROOT, 'src/Config.js'), 'utf8')
    + '\nreturn { withLock_, guard_, warnIfLarge_, ROW_WARN_THRESHOLD };';
  // eslint-disable-next-line no-new-func
  const api = new Function(...names, body)(...names.map((n) => stubs[n]));
  return { ...api, state };
}

test('withLock_ acquires once and always releases', () => {
  const c = loadConfig();

  assert.equal(c.withLock_(() => 'ok'), 'ok');
  assert.equal(c.state.acquired, 1);
  assert.equal(c.state.released, 1);
  assert.equal(c.state.held, false);
});

test('withLock_ is re-entrant — ingestResults_ nests three deep', () => {
  const c = loadConfig();

  const result = c.withLock_(() => c.withLock_(() => c.withLock_(() => 'deep')));

  assert.equal(result, 'deep');
  assert.equal(c.state.reentered, false, 'nested call tried to re-acquire and would have deadlocked');
  assert.equal(c.state.acquired, 1, 'nesting must not re-acquire');
  assert.equal(c.state.held, false, 'lock still held after unwinding');
});

test('withLock_ releases when the body throws, at any depth', () => {
  const c = loadConfig();

  assert.throws(() => c.withLock_(() => { throw new Error('boom'); }), /boom/);
  assert.equal(c.state.held, false, 'lock leaked after a throw');

  assert.throws(
    () => c.withLock_(() => c.withLock_(() => { throw new Error('nested boom'); })),
    /nested boom/,
  );
  assert.equal(c.state.held, false, 'lock leaked after a nested throw');

  // The depth counter must have reset, or every later write is blocked.
  assert.equal(c.withLock_(() => 'recovered'), 'recovered');
  assert.equal(c.state.acquired, 3);
  assert.equal(c.state.released, 3);
});

test('withLock_ explains itself when another execution holds the lock', () => {
  const c = loadConfig();
  c.state.held = true; // pretend doPost is mid-write

  assert.throws(() => c.withLock_(() => 'never runs'), /Another Music League job is writing/);
});

test('guard_ returns the value and stays quiet on success', () => {
  const c = loadConfig();

  assert.equal(c.guard_('Thing', () => 42), 42);
  assert.deepEqual(c.state.alerts, []);
  assert.deepEqual(c.state.logs, []);
});

test('guard_ surfaces a thrown error through ui.alert and the log', () => {
  const c = loadConfig();

  assert.equal(c.guard_('Recompute analytics', () => { throw new Error('Sheet "Votes" not found.'); }), null);
  assert.equal(c.state.alerts.length, 1);
  assert.match(c.state.alerts[0], /^Recompute analytics failed/);
  assert.match(c.state.alerts[0], /Sheet "Votes" not found\./);
  assert.equal(c.state.logs.length, 1, 'should also reach the execution log');
});

test('guard_ does not alert when the user cancels a prompt', () => {
  const c = loadConfig();

  assert.equal(c.guard_('New round from playlist', () => { throw new Error('Cancelled.'); }), null);
  assert.deepEqual(c.state.alerts, [], 'backing out of a prompt is not an error');
  assert.equal(c.state.logs.length, 1);
});

test('guard_ falls back to the log with no UI attached', () => {
  const c = loadConfig({ withUi: false });

  assert.equal(c.guard_('Hourly tick', () => { throw new Error('headless'); }), null);
  assert.equal(c.state.alerts.length, 0);
  assert.match(c.state.logs[0], /Hourly tick failed/);
});

test('warnIfLarge_ fires only past the threshold', () => {
  const c = loadConfig();

  c.warnIfLarge_('Votes', c.ROW_WARN_THRESHOLD);
  assert.deepEqual(c.state.logs, [], 'must not warn at the threshold');

  c.warnIfLarge_('Votes', c.ROW_WARN_THRESHOLD + 1);
  assert.equal(c.state.logs.length, 1);
  assert.match(c.state.logs[0], /Votes is rewriting 5001 rows/);
  assert.match(c.state.logs[0], /archiving finished seasons/);
});
