/**
 * bookmarklet.test.mjs — the Mode B scraper against a real captured results
 * page (test/page-results.html, "Cover Songs", captured 2026-09-09).
 *
 * Task 4 asks for exactly this: a saved payload so a Music League redesign
 * shows up as a failing test rather than a mystery. The scraper is a browser
 * console paste, not a module, so it is evalled inside jsdom the same way
 * analytics.test.mjs evals the Apps Script sources — the file under test is
 * the file that ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** Runs tools/bookmarklet.js against the fixture and returns window.ML. */
function run() {
  const html = readFileSync(join(HERE, 'page-results.html'), 'utf8');
  const code = readFileSync(join(ROOT, 'tools/bookmarklet.js'), 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const quiet = () => {};
  dom.window.console = { log: quiet, warn: quiet, table: quiet };
  dom.window.eval(code);
  // Copy out of the jsdom realm: its Array is not Node's Array, so
  // deepStrictEqual would fail on prototype identity alone.
  const ML = dom.window.ML;
  return {
    round: JSON.parse(JSON.stringify(ML.round)),
    songs: JSON.parse(JSON.stringify(ML.songs)),
    playersTSV: String(ML.playersTSV),
    tracksTSV: String(ML.tracksTSV),
    submissionsTSV: String(ML.submissionsTSV),
    votesTSV: String(ML.votesTSV),
    problems: Array.from(ML.problems, String),
    advisories: Array.from(ML.advisories, String),
  };
}

const ML = run();

test('it waits for htmx to swap the results in', async () => {
  // The bug that made the userscript look dead: Music League does not put the
  // songs in the initial HTML. The page loads, fires hx-get="-/results", and
  // swaps them in afterwards. Running once at document-idle finds nothing.
  const full = readFileSync(join(HERE, 'page-results.html'), 'utf8');
  const code = readFileSync(join(ROOT, 'tools/bookmarklet.js'), 'utf8');

  // A page with the chrome but no song cards yet.
  const shell = full.slice(0, full.indexOf('<div class="card mb-4" id="spotify:track:'));
  const dom = new JSDOM(shell + '</div></body></html>', { runScripts: 'outside-only' });
  const quiet = () => {};
  dom.window.console = { log: quiet, warn: quiet, error: quiet, table: quiet };
  dom.window.eval(code);

  // discover() is exposed immediately so it works on unreadable pages, but
  // nothing should be extracted until the results actually arrive.
  assert.equal(typeof dom.window.ML.discover, 'function');
  assert.equal(dom.window.ML.songs, undefined, 'must not conclude anything yet');

  // Now htmx delivers the results, exactly as it does on the real page.
  const body = full.slice(full.indexOf('<div class="card mb-4" id="spotify:track:'));
  const holder = dom.window.document.createElement('div');
  holder.innerHTML = body;
  dom.window.document.body.appendChild(holder);

  await new Promise((r) => setTimeout(r, 50));   // let the observer fire

  assert.ok(dom.window.ML, 'never noticed the results arriving');
  assert.equal(dom.window.ML.round.roundId, 'R04');
  assert.equal(dom.window.ML.songs.length, 11);
});

test('it reads the round number and theme off the page', () => {
  // A hardcoded round id in a script that auto-runs on every Music League
  // page would file an old round's results under the current round the first
  // time you looked at one. So it is read, not assumed.
  assert.equal(ML.round.number, 4);
  assert.equal(ML.round.roundId, 'R04');
  assert.equal(ML.round.theme, 'Cover Songs');
});

test('the detected round id is what lands in every TSV', () => {
  for (const tsv of [ML.tracksTSV, ML.submissionsTSV, ML.votesTSV]) {
    for (const line of tsv.split('\n')) {
      assert.equal(line.split('\t')[0], ML.round.roundId);
    }
  }
});

test('it finds every song card and its votes', () => {
  assert.equal(ML.songs.length, 11, 'song count');
  const votes = ML.songs.reduce((a, s) => a + s.votes.length, 0);
  assert.equal(votes, 52, 'vote row count');
  for (const s of ML.songs) {
    assert.match(s.track_id, /^[A-Za-z0-9]{22}$/, 'track id shape: ' + s.track_id);
    assert.ok(s.submitter, s.track_id + ' has no submitter');
    assert.ok(s.title, s.track_id + ' has no title');
  }
});

test('the self-check passes — votes reconcile with the page totals', () => {
  // The strongest assertion available: each card prints its own total, so a
  // selector quietly missing rows shows up here rather than as a plausible,
  // wrong leaderboard.
  assert.deepEqual(ML.problems, []);
});

test('the non-voter penalty is read as a penalty, not as a mismatch', () => {
  // Music League zeroes your song if you did not vote. The page shows
  // "<s>2</s> 0" plus a "Did not vote" badge. Reading the h3 naively yields
  // NaN and looks like a scraper bug, which is how this was found.
  const penalised = ML.songs.filter((s) => s.penalised);
  assert.equal(penalised.length, 1, 'expected exactly one penalised song');

  const s = penalised[0];
  assert.equal(s.submitter, 'Ravi Menon');
  assert.equal(s.total_points, 0, 'awarded total is zero');
  assert.equal(s.points_before_penalty, 2, 'pre-penalty total is struck through');
  assert.equal(s.votes.reduce((a, v) => a + v.points, 0), 2, 'votes as cast still total 2');

  // It must be an advisory, never a problem -- crying wolf here would train
  // everyone to paste through real errors.
  assert.equal(ML.problems.length, 0);
  assert.equal(ML.advisories.length, 1);
  assert.match(ML.advisories[0], /did not vote/i);
  assert.match(ML.advisories[0], /differ from the official standings/);
});

test('votes are still extracted for a song nobody voted on', () => {
  const empty = ML.songs.filter((s) => s.votes.length === 0);
  assert.equal(empty.length, 1);
  assert.equal(empty[0].total_points, 0);
  // No Votes rows, but it still needs a Submissions row or its submitter
  // silently drops out of the round.
  assert.ok(ML.submissionsTSV.includes(empty[0].track_id));
});

test('it reads a known song correctly', () => {
  const s = ML.songs.find((x) => x.track_id === '2zMYubbKqemHO2Yupz21cu');
  assert.ok(s, 'expected song missing');
  assert.equal(s.title, 'Street Spirit (Fade Out)');
  assert.equal(s.artist, 'Harakiri for the Sky');
  assert.equal(s.submitter, 'Alex Rivera');
  assert.equal(s.total_points, 15);
  assert.equal(s.votes.reduce((a, v) => a + v.points, 0), 15);
});

test('it keeps vote comments, including the punctuation', () => {
  const all = ML.songs.flatMap((s) => s.votes);
  const withComment = all.filter((v) => v.comment);
  assert.ok(withComment.length > 0, 'no comments extracted at all');

  const known = all.find((v) => v.comment.startsWith('great pick'));
  assert.ok(known, 'a known comment went missing');
  assert.equal(known.voter, 'Alex Rivera');
  assert.equal(known.points, 3);

  // Apostrophes are the characters most likely to be mangled on the way to a
  // spreadsheet, so make sure both kinds survive intact.
  assert.ok(withComment.some((v) => v.comment.includes("'")), 'straight apostrophe lost');
});

test('Players TSV is every participant, name + TRUE, nothing else', () => {
  const lines = ML.playersTSV.split('\n');
  assert.equal(lines.length, 11, 'round 4 had 11 participants');

  for (const line of lines) {
    const cols = line.split('\t');
    assert.equal(cols.length, 2, 'Players is two columns: ' + line);
    assert.ok(cols[0].length > 0, 'empty name');
    assert.equal(cols[1], 'TRUE');
  }

  const names = lines.map((l) => l.split('\t')[0]);
  assert.equal(new Set(names).size, names.length, 'duplicate player');

  // Exact spelling is the join key for every other tab, so pin the awkward ones.
  assert.ok(names.includes('Zoë Müller'), 'diacritics mangled');
  assert.ok(names.includes('André Costa'), 'diacritics mangled');
  assert.ok(names.includes('tcarter4471'), 'handle-style name missing');

  // A submitter who never voted must still be a player.
  assert.ok(names.includes('Ravi Menon'), 'the penalised non-voter went missing');
});

test('Players covers everyone named anywhere else in the output', () => {
  // If a name appears in Submissions or Votes but not Players, menu 5 flags it
  // and the round scores wrong. Catch it here instead.
  const players = new Set(ML.playersTSV.split('\n').map((l) => l.split('\t')[0]));
  for (const line of ML.submissionsTSV.split('\n')) {
    assert.ok(players.has(line.split('\t')[2]), 'submitter missing from Players: ' + line);
  }
  for (const line of ML.votesTSV.split('\n')) {
    assert.ok(players.has(line.split('\t')[2]), 'voter missing from Players: ' + line);
  }
});

test('Tracks TSV matches the Tracks tab layout', () => {
  const lines = ML.tracksTSV.split('\n');
  assert.equal(lines.length, 11);
  lines.forEach((line, i) => {
    const cols = line.split('\t');
    assert.equal(cols.length, 9, 'Tracks is nine columns: ' + line);
    assert.equal(cols[0], 'R04');
    assert.equal(cols[1], String(i + 1), 'positions run 1..n in page order');
    assert.match(cols[2], /^[A-Za-z0-9]{22}$/);
    assert.ok(cols[3].length > 0, 'missing title');
    assert.ok(cols[4].length > 0, 'missing artist');
    // The Spotify-only columns stay empty; nothing downstream needs them.
    assert.deepEqual(cols.slice(5), ['', '', '', '']);
  });
});

test('every Submissions track exists in Tracks', () => {
  const inTracks = new Set(ML.tracksTSV.split('\n').map((l) => l.split('\t')[2]));
  for (const line of ML.submissionsTSV.split('\n')) {
    assert.ok(inTracks.has(line.split('\t')[1]), 'submission with no Tracks row: ' + line);
  }
});

test('Submissions TSV is round_id / track_id / submitter / did_not_vote', () => {
  const lines = ML.submissionsTSV.split('\n');
  assert.equal(lines.length, 11);
  for (const line of lines) {
    const cols = line.split('\t');
    assert.equal(cols.length, 4, 'wrong column count: ' + line);
    assert.equal(cols[0], 'R04');
    assert.match(cols[1], /^[A-Za-z0-9]{22}$/);
    assert.ok(cols[2].length > 0);
    assert.match(cols[3], /^(TRUE|FALSE)$/, 'did_not_vote must be TRUE or FALSE');
  }
});

test('did_not_vote is TRUE for exactly the penalised submitter', () => {
  const flagged = ML.submissionsTSV.split('\n')
    .map((l) => l.split('\t'))
    .filter((c) => c[3] === 'TRUE');
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0][2], 'Ravi Menon');
});

test('Votes TSV is round_id / track_id / voter / points / comment / title', () => {
  const lines = ML.votesTSV.split('\n');
  assert.equal(lines.length, 52);
  for (const line of lines) {
    const cols = line.split('\t');
    // Exactly 6 columns even when the comment is empty, and never more --
    // a tab inside a comment would shift every column after it in Sheets.
    assert.equal(cols.length, 6, 'wrong column count: ' + line);
    assert.equal(cols[0], 'R04');
    assert.match(cols[1], /^[A-Za-z0-9]{22}$/);
    assert.ok(cols[2].length > 0, 'empty voter');
    assert.match(cols[3], /^-?\d+$/, 'points not an integer: ' + cols[3]);
    assert.ok(cols[5].length > 0, 'every vote row should name its song');
  }
});

test('the Votes title matches the Tracks title for the same track', () => {
  // Denormalised for readability only, so it must at least agree with itself.
  const titleOf = {};
  for (const line of ML.tracksTSV.split('\n')) {
    const c = line.split('\t');
    titleOf[c[2]] = c[3];
  }
  for (const line of ML.votesTSV.split('\n')) {
    const c = line.split('\t');
    assert.equal(c[5], titleOf[c[1]], 'Votes title disagrees with Tracks: ' + line);
  }
});

test('no TSV cell contains a tab or newline', () => {
  for (const tsv of [ML.submissionsTSV, ML.votesTSV]) {
    for (const line of tsv.split('\n')) {
      for (const cell of line.split('\t')) {
        assert.ok(!/[\t\r\n]/.test(cell), 'unsanitised cell: ' + JSON.stringify(cell));
      }
    }
  }
});

test('every vote names a track that appears in Submissions', () => {
  // The failure mode sanityCheck() exists to catch, caught one step earlier.
  const submitted = new Set(ML.submissionsTSV.split('\n').map((l) => l.split('\t')[1]));
  for (const line of ML.votesTSV.split('\n')) {
    const trackId = line.split('\t')[1];
    assert.ok(submitted.has(trackId), 'vote on an unsubmitted track: ' + trackId);
  }
});

test('nobody voted for their own song', () => {
  // Music League forbids it; if it ever appears, validateIngest should shout.
  const submitterOf = {};
  for (const s of ML.songs) submitterOf[s.track_id] = s.submitter;
  for (const s of ML.songs) {
    for (const v of s.votes) {
      assert.notEqual(v.voter, submitterOf[s.track_id],
        'self-vote extracted on ' + s.track_id);
    }
  }
});
