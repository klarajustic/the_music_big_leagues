/**
 * Config — all tunable settings live here.
 */

const SHEETS = {
  PLAYERS: 'Players',
  ROUNDS: 'Rounds',
  TRACKS: 'Tracks',
  SUBMISSIONS: 'Submissions',
  VOTES: 'Votes',
  GUESSES: 'Guesses',
  ROUND_RESULTS: 'RoundResults',
  GUESS_SCORES: 'GuessScores',
  LEADERBOARD: 'Leaderboard',
  FAN_MATRIX: 'FanMatrix',
  GENRE_STATS: 'GenreStats',
  AWARDS: 'Awards',
  RAW: '_RawIngest'
};

const HEADERS = {
  Players: ['name', 'active'],
  Rounds: ['round_id', 'week', 'theme', 'playlist_url', 'form_url', 'form_id', 'votes_close_at', 'status', 'season'],
  Tracks: ['round_id', 'position', 'track_id', 'title', 'artist', 'artist_ids', 'genres', 'release_year', 'spotify_popularity'],
  Submissions: ['round_id', 'track_id', 'submitter', 'did_not_vote'],
  Votes: ['round_id', 'track_id', 'voter', 'points', 'comment', 'title'],
  Guesses: ['round_id', 'track_id', 'guesser', 'guessed', 'timestamp'],
  RoundResults: ['round_id', 'position', 'title', 'artist', 'submitter', 'total_points', 'voters', 'avg_per_voter', 'spread', 'genres'],
  GuessScores: ['round_id', 'guesser', 'eligible', 'correct', 'hit_rate', 'guess_points'],
  Leaderboard: ['season', 'player', 'song_points', 'popularity_points', 'guess_points', 'combined', 'rounds_played'],
  FanMatrix: ['voter', 'submitter', 'points_given', 'share_of_votes', 'shared_rounds'],
  GenreStats: ['genre', 'submissions', 'total_points', 'avg_points', 'avg_voters'],
  Awards: ['season', 'award', 'winner', 'detail', 'value']
};

/**
 * Weights for the combined leaderboard. Each component is normalised to a
 * share of that round's total before weighting, so rounds with different
 * player counts or point pools stay comparable.
 *
 * song  — points your submissions received (the classic Music League score)
 * pop   — how many distinct people voted for your song (breadth, not depth)
 * guess — how well you guessed who submitted what
 *
 * They must sum to 1. combined is a share of 100 per round, so any other total
 * silently breaks invariant 2 and sanityCheck along with it.
 *
 * guess was 0.4 and is now 0.2: the league is a music competition first, and
 * an equal weighting let someone who picked indifferently but read the room
 * well finish above someone whose songs everybody liked. song absorbed the
 * difference rather than pop, because pop is held low on purpose (below).
 */
const WEIGHTS = { song: 0.6, pop: 0.2, guess: 0.2 };

/** 'inverse_frequency' rewards hard guesses more; 'flat' gives 1 per correct. */
const GUESS_SCORING = 'inverse_frequency';
const GUESS_POINTS_CAP = 5;

/** Option shown in the form when someone has no clue. */
const NO_IDEA = 'No idea';

/**
 * Rounds with a blank season — every round created before seasons existed —
 * are season 1. Nothing has to be backfilled.
 */
const DEFAULT_SEASON = 1;

/**
 * Above this, the read-all/write-all rewrite in importGuesses_ and
 * ingestResults_ starts to be worth worrying about. ~10 players x 50 rounds x
 * 15 tracks is nowhere near it; a runaway ingest loop is.
 */
const ROW_WARN_THRESHOLD = 5000;

// ---------------------------------------------------------------------------

function props_() {
  return PropertiesService.getScriptProperties();
}

function getProp_(key, required) {
  const v = props_().getProperty(key);
  if (!v && required) {
    throw new Error('Missing script property: ' + key + '. Set it under Project Settings > Script properties.');
  }
  return v;
}

function ss_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found. Run Setup > Create/repair tabs.');
  return sh;
}

/** Reads a sheet into an array of objects keyed by header. */
function readTable_(name) {
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return [];
  const head = values[0];
  return values.slice(1)
    .filter(function (r) { return r.join('') !== ''; })
    .map(function (r) {
      const o = {};
      head.forEach(function (h, i) { o[h] = r[i]; });
      return o;
    });
}

/**
 * Clears a sheet's body and writes rows (array of arrays).
 *
 * The header is rewritten from HEADERS every time, so adding a column to a
 * derived table migrates itself on the next recompute — no "run Create/repair
 * tabs first" step. Raw tables written through here get the same treatment.
 */
function writeTable_(name, rows) {
  return withLock_(function () {
    const sh = sheet_(name);
    const head = HEADERS[name];
    if (head) sh.getRange(1, 1, 1, head.length).setValues([head]);
    const lastRow = sh.getLastRow();
    if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, sh.getLastColumn()).clearContent();
    if (rows.length) {
      sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
    }
  });
}

/**
 * Warns when one of the read-all/write-all paths is about to move a lot of
 * rows. Uses toast_, which falls back to the log when there's no UI, so it is
 * safe from the hourly trigger and from doPost.
 */
function warnIfLarge_(label, rowCount) {
  if (rowCount <= ROW_WARN_THRESHOLD) return;
  toast_(label + ' is rewriting ' + rowCount + ' rows. Past ~' + ROW_WARN_THRESHOLD +
    ' this whole-table rewrite gets slow and can hit the execution time limit. ' +
    'Consider archiving finished seasons.');
}

function activePlayers_() {
  return readTable_(SHEETS.PLAYERS)
    .filter(function (p) { return p.name && String(p.active).toLowerCase() !== 'false' && p.active !== false; })
    .map(function (p) { return String(p.name).trim(); });
}

function round_(roundId) {
  const rows = readTable_(SHEETS.ROUNDS).filter(function (r) { return String(r.round_id) === String(roundId); });
  if (!rows.length) throw new Error('No round with id ' + roundId);
  return rows[0];
}

function currentRoundId_() {
  const rounds = readTable_(SHEETS.ROUNDS);
  const open = rounds.filter(function (r) { return r.status === 'open'; });
  if (open.length) return open[open.length - 1].round_id;
  if (!rounds.length) throw new Error('No rounds yet. Run "New round from playlist".');
  return rounds[rounds.length - 1].round_id;
}

/**
 * Emails the operator. The only outbound channel this project has: Slack is
 * blocked by workspace policy, so a mail to one address is what replaced it.
 * Set NOTIFY_EMAIL in Script properties; unset means stay silent.
 */
function notify_(subject, body) {
  const to = getProp_('NOTIFY_EMAIL');
  if (!to) { Logger.log('No NOTIFY_EMAIL set, skipping: ' + subject); return; }
  try {
    MailApp.sendEmail(to, subject, body);
  } catch (e) {
    Logger.log('Could not send "' + subject + '": ' + e);
  }
}

function toast_(msg) {
  try { ss_().toast(msg, 'Music League', 6); } catch (e) { Logger.log(msg); }
}

// ---------------------------------------------------------------------------
// Concurrency and error surfacing
// ---------------------------------------------------------------------------

/**
 * doPost and the hourly trigger can both be rewriting Submissions/Votes while
 * you have a menu item running, and every write path here is read-all then
 * write-all — so an interleave loses rows rather than merging them.
 *
 * Re-entrant on purpose: ingestResults_ holds the lock across two writeTable_
 * calls, and Apps Script hands out a fresh Lock object per getScriptLock(),
 * so a naive nested waitLock() would deadlock against our own execution.
 */
let lockDepth_ = 0;
let heldLock_ = null;

function withLock_(fn) {
  if (lockDepth_ > 0) {
    lockDepth_ += 1;
    try { return fn(); } finally { lockDepth_ -= 1; }
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    throw new Error('Another Music League job is writing to the sheet right now. ' +
      'Wait a moment and try again.');
  }

  heldLock_ = lock;
  lockDepth_ = 1;
  try {
    return fn();
  } finally {
    lockDepth_ = 0;
    heldLock_ = null;
    lock.releaseLock();
  }
}

/**
 * Every menu entry runs inside this. Without it a thrown error dies in the
 * execution log, which nobody outside this repo is ever going to open.
 */
function guard_(label, fn) {
  try {
    return fn();
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    Logger.log(label + ' failed: ' + (err && err.stack ? err.stack : msg));
    if (msg.indexOf('Cancelled.') === 0) return null; // user backed out of a prompt
    try {
      SpreadsheetApp.getUi().alert(label + ' failed\n\n' + msg);
    } catch (e) {
      // No UI attached (trigger or web app context) — the log above is it.
    }
    return null;
  }
}
