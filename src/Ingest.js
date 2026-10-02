/**
 * Ingest — getting the Music League reveal data in.
 *
 * There is no public Music League API and no CSV export, so there are two
 * paths and both write to the same two tabs (Submissions, Votes):
 *
 *   MANUAL  — paste from the results page into Submissions and Votes.
 *             Works day one, no maintenance. Use this first.
 *
 *   PUSH    — deploy this script as a Web app (Deploy > New deployment >
 *             Web app, execute as you, access "Anyone"), then run the
 *             bookmarklet in bookmarklet.js on the results page. It scrapes
 *             the round and POSTs it here.
 *
 * The PUSH path depends on Music League's page internals, which are
 * undocumented and change. mapPayload_() below is the single seam you'll
 * need to adapt — the raw blob is always saved to _RawIngest first so you
 * can inspect the real shape before writing the mapping.
 */

function doPost(e) {
  try {
    const token = getProp_('INGEST_TOKEN', true);
    const body = JSON.parse(e.postData.contents);
    if (body.token !== token) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'bad token' }))
        .setMimeType(ContentService.MimeType.JSON);
    }

    // Always keep the raw payload — this is your debugging lifeline.
    withLock_(function () {
      sheet_(SHEETS.RAW).appendRow([new Date(), body.roundId || '', JSON.stringify(body).slice(0, 45000)]);
    });

    const mapped = mapPayload_(body);
    ensureRound_(mapped.roundId, mapped.theme);
    ingestTracks_(mapped.roundId, mapped.tracks);
    ingestResults_(mapped.roundId, mapped.submissions, mapped.votes);

    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      round: mapped.roundId,
      tracks: mapped.tracks.length,
      submissions: mapped.submissions.length,
      votes: mapped.votes.length
    })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * ADAPT ME. Turns whatever the bookmarklet scraped into the canonical shape.
 *
 * Expected output:
 *   {
 *     roundId: 'R01',
 *     submissions: [{track_id, submitter}],
 *     votes: [{track_id, voter, points, comment}]
 *   }
 *
 * If the bookmarklet already sends that shape (because you taught it the
 * page's DOM), this is a pass-through — which is how it ships.
 */
function mapPayload_(body) {
  if (body.submissions && body.votes) {
    return {
      roundId: body.roundId || currentRoundId_(),
      theme: body.theme || '',
      tracks: body.tracks || [],
      submissions: body.submissions,
      votes: body.votes
    };
  }
  throw new Error('Payload not in canonical shape. Inspect _RawIngest and write the mapping in mapPayload_().');
}

/**
 * Makes sure the round exists before anything references it.
 *
 * The scraper reads the round number off the page, so R04 here is round 4 in
 * Music League — the Rounds tab stays legible to everyone else in the league.
 * An existing row is left alone apart from its theme: it may carry a deadline
 * and a form id that the results page knows nothing about.
 */
function ensureRound_(roundId, theme) {
  return withLock_(function () {
    const sh = sheet_(SHEETS.ROUNDS);
    const values = sh.getDataRange().getValues();
    const head = values[0];
    const idCol = head.indexOf('round_id');
    const themeCol = head.indexOf('theme');

    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idCol]) === String(roundId)) {
        if (theme && !values[i][themeCol]) sh.getRange(i + 1, themeCol + 1).setValue(theme);
        return false;
      }
    }

    const week = Number(String(roundId).replace(/[^0-9]/g, '')) || values.length;
    const season = currentSeason_(readTable_(SHEETS.ROUNDS));
    sh.appendRow([roundId, week, theme || roundId, '', '', '', '', 'scored', season]);
    return true;
  });
}

/** Replaces this round's rows in Tracks. Idempotent, like ingestResults_. */
function ingestTracks_(roundId, tracks) {
  if (!tracks || !tracks.length) return;
  withLock_(function () {
    const keep = readTable_(SHEETS.TRACKS)
      .filter(function (t) { return String(t.round_id) !== String(roundId); })
      .map(function (t) {
        return [t.round_id, t.position, t.track_id, t.title, t.artist,
          t.artist_ids, t.genres, t.release_year, t.spotify_popularity];
      });
    tracks.forEach(function (t, i) {
      keep.push([roundId, t.position || i + 1, t.track_id, t.title || '', t.artist || '',
        '', '', '', '']);
    });
    warnIfLarge_('Tracks', keep.length);
    writeTable_(SHEETS.TRACKS, keep);
  });
}

/**
 * Replaces this round's rows in Submissions and Votes. Idempotent.
 *
 * Both tables are read-all then write-all, and the status flip has to land
 * with them, so the whole thing is one critical section — otherwise a menu
 * item running at the same time as doPost writes back a stale snapshot.
 */
function ingestResults_(roundId, submissions, votes) {
  withLock_(function () {
    const keepSubs = readTable_(SHEETS.SUBMISSIONS)
      .filter(function (s) { return String(s.round_id) !== String(roundId); })
      .map(function (s) { return [s.round_id, s.track_id, s.submitter, s.did_not_vote]; });
    submissions.forEach(function (s) {
      keepSubs.push([roundId, s.track_id, s.submitter, s.did_not_vote === true]);
    });
    warnIfLarge_('Submissions', keepSubs.length);
    writeTable_(SHEETS.SUBMISSIONS, keepSubs);

    // title is denormalised from Tracks purely so the tab is readable: 96 rows
    // of 22-character ids tells a human nothing. Nothing reads it back --
    // analytics join on track_id -- so a stale one is cosmetic, not a bug.
    const titleOf = {};
    readTable_(SHEETS.TRACKS)
      .filter(function (t) { return String(t.round_id) === String(roundId); })
      .forEach(function (t) { titleOf[String(t.track_id)] = t.title; });

    const keepVotes = readTable_(SHEETS.VOTES)
      .filter(function (v) { return String(v.round_id) !== String(roundId); })
      .map(function (v) { return [v.round_id, v.track_id, v.voter, v.points, v.comment, v.title]; });
    votes.forEach(function (v) {
      keepVotes.push([roundId, v.track_id, v.voter, Number(v.points) || 0, v.comment || '',
        v.title || titleOf[String(v.track_id)] || '']);
    });
    warnIfLarge_('Votes', keepVotes.length);
    writeTable_(SHEETS.VOTES, keepVotes);

    setRoundStatus_(roundId, 'scored');
  });
}

/**
 * Sanity-checks what's in Submissions and Votes against Players and Tracks.
 * Catches the three things that actually break analytics: a name spelled
 * differently in Music League than in the Players tab, a track that isn't in
 * the round playlist, and a submitter voting for their own song.
 */
function validateIngest() {
  guard_('Validate ingested results', function () {
    const roundId = currentRoundId_();
    const players = activePlayers_();
    const trackIds = readTable_(SHEETS.TRACKS)
      .filter(function (t) { return String(t.round_id) === String(roundId); })
      .map(function (t) { return String(t.track_id); });

    const problems = [];
    const seenNames = {};
    const submitterOf = {};
    const flaggedNoVote = {};

    readTable_(SHEETS.SUBMISSIONS)
      .filter(function (s) { return String(s.round_id) === String(roundId); })
      .forEach(function (s) {
        const submitter = String(s.submitter).trim();
        seenNames[submitter] = true;
        submitterOf[String(s.track_id)] = submitter;
        if (truthy_(s.did_not_vote)) flaggedNoVote[submitter] = true;
        if (trackIds.indexOf(String(s.track_id)) === -1) {
          problems.push('Submission references unknown track: ' + s.track_id);
        }
      });

    const voted = {};
    readTable_(SHEETS.VOTES)
      .filter(function (v) { return String(v.round_id) === String(roundId); })
      .forEach(function (v) {
        const voter = String(v.voter).trim();
        seenNames[voter] = true;
        voted[voter] = true;
        if (trackIds.indexOf(String(v.track_id)) === -1) {
          problems.push('Vote references unknown track: ' + v.track_id);
        }
        // Music League doesn't allow voting for yourself, so this is never a
        // real result — it's a mis-paste or a scraper bug. The analytics would
        // drop the points on the floor without saying anything.
        if (submitterOf[String(v.track_id)] === voter) {
          problems.push('Self-vote: ' + voter + ' has ' + v.points + ' point(s) on their own song (' +
            v.track_id + '). Music League does not allow this — fix the source rows, ' +
            'or the points vanish silently.');
        }
      });

    // did_not_vote says they cast nothing. A vote row says otherwise. One of
    // the two is wrong, and their song's score depends on which.
    Object.keys(flaggedNoVote).forEach(function (n) {
      if (voted[n]) {
        problems.push('"' + n + '" is flagged did_not_vote but has vote rows in this round. ' +
          'Their song is being zeroed; clear the flag if they did vote.');
      }
    });

    Object.keys(seenNames).forEach(function (n) {
      if (n && players.indexOf(n) === -1) {
        problems.push('Name "' + n + '" is not in the Players tab (guesses will not match).');
      }
    });

    const uniq = [];
    problems.forEach(function (p) { if (uniq.indexOf(p) === -1) uniq.push(p); });

    SpreadsheetApp.getUi().alert(uniq.length
      ? 'Found ' + uniq.length + ' issue(s):\n\n' + uniq.slice(0, 20).join('\n')
      : 'Round ' + roundId + ' looks clean. Run "Recompute analytics".');
  });
}
