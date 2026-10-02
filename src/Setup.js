/**
 * Setup — one-time scaffolding, the spreadsheet menu, and cron triggers.
 */

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('🎵 Music League')
    .addItem('1. Create/repair tabs', 'setupSheets')
    .addSeparator()
    .addItem('2. New round from playlist…', 'newRoundFromPlaylist')
    .addItem('3. Create guess form', 'createGuessFormForCurrentRound')
    .addSeparator()
    .addItem('4. Import guesses from form', 'importGuessesForCurrentRound')
    .addItem('5. Validate ingested results', 'validateIngest')
    .addItem('6. Recompute analytics', 'recomputeAll')
    .addSeparator()
    .addItem('Sanity-check leaderboard', 'sanityCheck')
    .addItem('Lock guess form now', 'lockCurrentForm')
    .addItem('Install daily triggers', 'installTriggers')
    .addToUi();
}

function setupSheets() {
  guard_('Create/repair tabs', function () {
    withLock_(function () {
      const ss = ss_();
      Object.keys(HEADERS).forEach(function (name) {
        let sh = ss.getSheetByName(name);
        if (!sh) sh = ss.insertSheet(name);
        const head = HEADERS[name];
        sh.getRange(1, 1, 1, head.length).setValues([head]);
        sh.getRange(1, 1, 1, head.length).setFontWeight('bold').setBackground('#efefef');
        sh.setFrozenRows(1);
      });
      if (!ss.getSheetByName(SHEETS.RAW)) ss.insertSheet(SHEETS.RAW);

      // Seed the Players tab so the form has something to offer.
      const players = sheet_(SHEETS.PLAYERS);
      if (players.getLastRow() < 2) {
        players.getRange(2, 1, 3, 2).setValues([
          ['Klara', true],
          ['Player Two', true],
          ['Player Three', true]
        ]);
      }
    });
    toast_('Tabs ready. Fill in the Players tab next.');
  });
}

function installTriggers() {
  guard_('Install daily triggers', function () {
    ScriptApp.getProjectTriggers().forEach(function (t) {
      if (t.getHandlerFunction() === 'hourlyTick') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('hourlyTick').timeBased().everyHours(1).create();
    toast_('Hourly trigger installed.');
  });
}

/**
 * Runs every hour. When a round's voting deadline passes it locks the guess
 * form, pulls the responses in and marks the round locked.
 *
 * That is the whole automation. There is no notification layer, so nobody is
 * told the form closed and nobody is nudged beforehand — announcing rounds is
 * the operator's job. See "No notification layer" in README.md.
 */
function hourlyTick() {
  const now = new Date();
  readTable_(SHEETS.ROUNDS).forEach(function (r) {
    if (r.status !== 'open') return;

    // A round that has tracks but no form yet gets one made for it, and the
    // link mailed over. That is the step that used to need a menu click.
    if (!r.form_id) {
      autoCreateForm_(r);
      return;   // the row is stale now; the deadline is next hour's problem
    }

    if (!r.votes_close_at || now < new Date(r.votes_close_at)) return;
    lockForm_(r);
    importGuesses_(r.round_id);
    setRoundStatus_(r.round_id, 'locked');
    notify_('Guesses locked for ' + r.round_id,
      'The guess form for "' + r.theme + '" is closed and the responses are in.\n\n' +
      'When the Music League reveal drops, open the results page — the userscript ' +
      'ingests it automatically. Then run "Recompute analytics".');
  });
}

/**
 * Creates the guess form for a round that has tracks but no form, and mails
 * the link. Never throws into the trigger: one bad round must not stop the
 * others, and a trigger failure is invisible until someone goes looking.
 */
function autoCreateForm_(r) {
  const tracks = readTable_(SHEETS.TRACKS)
    .filter(function (t) { return String(t.round_id) === String(r.round_id); });
  if (!tracks.length) return;   // nothing to ask about yet

  try {
    const url = createGuessForm_(r);
    notify_('Guess form ready: ' + r.theme,
      'Round ' + r.round_id + ' — "' + r.theme + '"\n\n' +
      url + '\n\n' +
      tracks.length + ' songs. Paste the link wherever the league chats.');
  } catch (e) {
    Logger.log('autoCreateForm_ failed for ' + r.round_id + ': ' + e);
    notify_('Guess form FAILED for ' + r.round_id, String(e));
  }
}

function setRoundStatus_(roundId, status) {
  withLock_(function () {
    const sh = sheet_(SHEETS.ROUNDS);
    const values = sh.getDataRange().getValues();
    const head = values[0];
    const idCol = head.indexOf('round_id');
    const statusCol = head.indexOf('status');
    for (let i = 1; i < values.length; i++) {
      if (String(values[i][idCol]) === String(roundId)) {
        sh.getRange(i + 1, statusCol + 1).setValue(status);
        return;
      }
    }
  });
}
