/**
 * Rounds — creating a round, generating the guess form, pulling responses.
 */

function newRoundFromPlaylist() {
  guard_('New round from playlist', function () { newRoundFromPlaylist_(); });
}

function newRoundFromPlaylist_() {
  const ui = SpreadsheetApp.getUi();

  const theme = promptOrThrow_(ui, 'Round theme', 'e.g. "Songs with a city in the title"');
  const playlistUrl = promptOrThrow_(ui, 'Spotify playlist URL', 'Paste the Music League round playlist link');
  const closeRaw = promptOrThrow_(ui, 'Voting deadline', 'YYYY-MM-DD HH:MM (local time)');

  const closeAt = new Date(closeRaw.replace(' ', 'T'));
  if (isNaN(closeAt.getTime())) throw new Error('Could not parse "' + closeRaw + '". Use YYYY-MM-DD HH:MM.');

  toast_('Fetching playlist from Spotify…');
  const tracks = fetchPlaylistTracks_(playlistUrl);
  if (!tracks.length) throw new Error('No playable tracks found in that playlist.');

  const allArtistIds = [];
  tracks.forEach(function (t) { t.artist_ids.forEach(function (a) { allArtistIds.push(a); }); });
  const genreMap = fetchArtistGenres_(allArtistIds);

  // The Spotify fetches above are slow, so the lock only covers the writes.
  const roundId = withLock_(function () {
    const rounds = readTable_(SHEETS.ROUNDS);
    const week = rounds.length + 1;
    // round_id stays globally sequential — it's the join key everywhere, so
    // week does not restart per season.
    const id = 'R' + Utilities.formatString('%02d', week);
    // New rounds join whichever season is already running. To start season 2,
    // type 2 into the season cell of its first round in the Rounds tab.
    const season = currentSeason_(rounds);

    sheet_(SHEETS.ROUNDS).appendRow([id, week, theme, playlistUrl, '', '', closeAt, 'open', season]);

    const trackRows = tracks.map(function (t) {
      const genres = [];
      t.artist_ids.forEach(function (a) {
        (genreMap[a] || []).forEach(function (g) { if (genres.indexOf(g) === -1) genres.push(g); });
      });
      // spotify_popularity is written empty: the API removed track popularity
      // in February 2026. The column stays so existing sheets keep their shape.
      return [id, t.position, t.track_id, t.title, t.artist,
        t.artist_ids.join(','), genres.slice(0, 6).join('; '), t.release_year, ''];
    });
    const trackSheet = sheet_(SHEETS.TRACKS);
    trackSheet.getRange(trackSheet.getLastRow() + 1, 1, trackRows.length, trackRows[0].length)
      .setValues(trackRows);
    return id;
  });

  toast_('Round ' + roundId + ' created with ' + tracks.length + ' tracks.');
  SpreadsheetApp.getUi().alert('Round ' + roundId + ' created (' + tracks.length + ' tracks).\n\nNext: "3. Create guess form".');
}

/** The highest season in the Rounds tab, or DEFAULT_SEASON if there are none. */
function currentSeason_(rounds) {
  let max = DEFAULT_SEASON;
  rounds.forEach(function (r) {
    const n = Number(r.season);
    if (n > max) max = n;
  });
  return max;
}

function promptOrThrow_(ui, title, help) {
  const res = ui.prompt(title, help, ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) throw new Error('Cancelled.');
  const v = res.getResponseText().trim();
  if (!v) throw new Error(title + ' is required.');
  return v;
}

// ---------------------------------------------------------------------------
// The guess form
// ---------------------------------------------------------------------------

function createGuessFormForCurrentRound() {
  guard_('Create guess form', function () {
    const r = round_(currentRoundId_());
    const url = createGuessForm_(r);
    SpreadsheetApp.getUi().alert('Form ready:\n\n' + url +
    '\n\nShare this link wherever your league talks. It is also saved in the ' +
    'form_url column of the Rounds tab.');
  });
}

function createGuessForm_(r) {
  const players = activePlayers_();
  if (players.length < 2) throw new Error('Add at least 2 active players to the Players tab.');

  const tracks = readTable_(SHEETS.TRACKS)
    .filter(function (t) { return String(t.round_id) === String(r.round_id); })
    .sort(function (a, b) { return a.position - b.position; });
  if (!tracks.length) throw new Error('No tracks stored for ' + r.round_id);

  // A round ingested from the results page has no deadline, and
  // formatDate on an Invalid Date throws -- which would take the whole
  // hourly trigger down rather than just skipping the sentence.
  const closeAt = r.votes_close_at ? new Date(r.votes_close_at) : null;
  const closes = closeAt && !isNaN(closeAt.getTime())
    ? ' Closes ' + Utilities.formatDate(closeAt, Session.getScriptTimeZone(), 'EEE d MMM, HH:mm') + '.'
    : '';

  const form = FormApp.create('Music League — ' + r.theme + ' (' + r.round_id + ')');
  form.setDescription('Guess who submitted each song.' + closes +
    ' You can resubmit — only your last response counts.');
  form.setLimitOneResponsePerUser(false);
  form.setShowLinkToRespondAgain(false);
  form.setConfirmationMessage('Locked in. Results after the reveal.');

  const who = form.addListItem();
  who.setTitle('Who are you?').setRequired(true).setChoiceValues(players);

  const choices = players.concat([NO_IDEA]);
  tracks.forEach(function (t) {
    const item = form.addListItem();
    item.setTitle('T' + t.position + '. ' + t.title + ' — ' + t.artist)
      .setRequired(true)
      .setChoiceValues(choices);
  });

  // Store form references on the round row.
  withLock_(function () {
    const sh = sheet_(SHEETS.ROUNDS);
    const values = sh.getDataRange().getValues();
    const head = values[0];
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][head.indexOf('round_id')]) === String(r.round_id)) {
        sh.getRange(i + 1, head.indexOf('form_url') + 1).setValue(form.getPublishedUrl());
        sh.getRange(i + 1, head.indexOf('form_id') + 1).setValue(form.getId());
        break;
      }
    }
  });
  return form.getPublishedUrl();
}

// ---------------------------------------------------------------------------
// Pulling responses in
// ---------------------------------------------------------------------------

function importGuessesForCurrentRound() {
  guard_('Import guesses', function () {
    const n = importGuesses_(currentRoundId_());
    SpreadsheetApp.getUi().alert('Imported guesses from ' + n + ' player(s).');
  });
}

/**
 * Reads the form responses and rewrites this round's rows in Guesses.
 * Last response per player wins, so people can change their minds.
 */
function importGuesses_(roundId) {
  const r = round_(roundId);
  if (!r.form_id) throw new Error('No form for ' + roundId + ' yet.');

  // Reading the form is a Forms API round trip, so it happens before the lock.
  const form = FormApp.openById(r.form_id);
  const tracks = readTable_(SHEETS.TRACKS).filter(function (t) { return String(t.round_id) === String(roundId); });
  const byPosition = {};
  tracks.forEach(function (t) { byPosition[String(t.position)] = t.track_id; });

  const latest = {}; // guesser -> {timestamp, answers: {position: guessed}}
  form.getResponses().forEach(function (resp) {
    const ts = resp.getTimestamp();
    let guesser = null;
    const answers = {};

    resp.getItemResponses().forEach(function (ir) {
      const title = ir.getItem().getTitle();
      const answer = ir.getResponse();
      if (title === 'Who are you?') {
        guesser = String(answer).trim();
        return;
      }
      const m = title.match(/^T(\d+)\./);
      if (m) answers[m[1]] = String(answer).trim();
    });

    if (!guesser) return;
    if (!latest[guesser] || ts > latest[guesser].timestamp) {
      latest[guesser] = { timestamp: ts, answers: answers };
    }
  });

  // Rewrite only this round's rows, keep other rounds intact. Read and write
  // are one critical section: the hourly trigger can be doing this too.
  withLock_(function () {
    const existing = readTable_(SHEETS.GUESSES).filter(function (g) { return String(g.round_id) !== String(roundId); });
    const rows = existing.map(function (g) {
      return [g.round_id, g.track_id, g.guesser, g.guessed, g.timestamp];
    });

    Object.keys(latest).forEach(function (guesser) {
      const entry = latest[guesser];
      Object.keys(entry.answers).forEach(function (pos) {
        const trackId = byPosition[pos];
        if (!trackId) return;
        rows.push([roundId, trackId, guesser, entry.answers[pos], entry.timestamp]);
      });
    });

    warnIfLarge_('Guesses', rows.length);
    writeTable_(SHEETS.GUESSES, rows);
  });
  return Object.keys(latest).length;
}

function lockCurrentForm() {
  guard_('Lock guess form', function () {
    lockForm_(round_(currentRoundId_()));
    SpreadsheetApp.getUi().alert('Form closed to new responses.');
  });
}

function lockForm_(r) {
  if (!r.form_id) return;
  FormApp.openById(r.form_id).setAcceptingResponses(false);
}
