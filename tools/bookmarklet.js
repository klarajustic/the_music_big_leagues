// ==UserScript==
// @name         Music League -> Sheet
// @namespace    the-music-big-leagues
// @version      1.1
// @description  Sends a Music League round straight to the tracker Sheet.
// @match        https://app.musicleague.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/**
 * bookmarklet.js — read a Music League round off the page and get it into the
 * Sheet. Works two ways from one file:
 *
 *   USERSCRIPT  Install in Tampermonkey, fill in ENDPOINT and TOKEN below, and
 *               it runs by itself on every Music League page. A completed
 *               round posts straight to the Apps Script web app.
 *
 *   CONSOLE     Leave ENDPOINT and TOKEN empty, paste the file into DevTools,
 *               and it prints TSV blocks to copy into the Sheet by hand. No
 *               network calls at all on this path.
 *
 * TIMING MATTERS. Music League is server-rendered htmx: the results are NOT in
 * the initial HTML. The page loads, then fires hx-get="-/results" and swaps the
 * song cards in afterwards. Running at document-idle finds nothing, which is
 * exactly the bug that made this look broken. So it waits for the cards via a
 * MutationObserver rather than assuming they are there.
 *
 * SCOPE MATTERS. @grant none injects into the page's own context, next to
 * Music League's variables, so everything below lives inside an IIFE. Only
 * window.ML is deliberately exported.
 *
 * MODE B (results page) is implemented and tested against test/page-results.html.
 * MODE A (voting page) is NOT — no round has reached voting since this was
 * written. See Task 4 in CLAUDE.md; run ML.discover() on it when one does.
 *
 * WHY THIS BREAKS EVENTUALLY
 *   Music League has no public API and no export, so the selectors below are
 *   the only seam. They are all in SELECTORS, so a redesign is a five-minute
 *   fix, and the manual paste path in the README always still works.
 */

(function () {
  'use strict';

  /**
   * Fill these two in to send straight to the Sheet. Leave them empty and the
   * script prints TSV for copy-paste instead — same data, one more step.
   *
   * TOKEN must match the INGEST_TOKEN script property, or the endpoint refuses
   * the request. Do not commit a filled-in copy.
   */
  const ENDPOINT = '';
  const TOKEN = '';

  /**
   * Normally left null: the round is read off the page, because a hardcoded id
   * in a script that auto-runs would file round 3's results under round 4 the
   * first time you looked at an old round. Set it only if detection breaks.
   */
  const ROUND_ID_OVERRIDE = null;

  /** How long to wait for htmx to swap the results in before giving up. */
  const RESULTS_WAIT_MS = 15000;

  /** Every page-shape assumption in one place. Verified 2026-09-09. */
  const SELECTORS = {
    songCard: '[id^="spotify:track:"]',       // card id is "spotify:track:<id>"
    trackLink: 'a[href*="open.spotify.com/track/"]',
    cardText: 'p.card-text',                  // [0] artist, [1] album
    submitter: 'h6.fw-semibold',              // the rank block names the submitter
    totalPoints: 'h3',
    votesBox: 'votes-',                       // id prefix: "votes-<trackid>"
    voteRow: ':scope > .row',
    voter: 'b',
    points: 'h6',
    comment: '.ws-pre-wrap',
    struck: 'h3 s',                           // pre-penalty total, struck through
    badge: '.badge',                          // carries "Did not vote"
    roundTitle: 'h5.card-title',              // the theme, e.g. "Cover Songs"
    roundLabel: 'span, p'                     // one of these reads "ROUND 4"
  };

  /**
   * Music League zeroes a player's song if they did not vote that round. The
   * page shows it as "<s>2</s> 0" with a "Did not vote" badge on the submitter.
   *
   * We extract the votes AS CAST, because that is what the Votes tab is for and
   * what our own analytics derive from. It means our total for a penalised song
   * will not match Music League's standings. That divergence is real, not a
   * scraping error, so it is reported as an advisory rather than swallowed.
   */
  const PENALTY_BADGE = 'did not vote';

  // ---------------------------------------------------------------------------

  /** Sheets pastes are tab-separated, so a tab or newline inside a comment
   *  would silently shift every column after it. */
  function clean(s) {
    return String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
  }

  function text(el) {
    return el ? clean(el.textContent) : '';
  }

  /** The total actually awarded: the h3 minus any struck-through pre-penalty value. */
  function effectiveTotal(card) {
    const h3 = card.querySelector(SELECTORS.totalPoints);
    if (!h3) return NaN;
    const clone = h3.cloneNode(true);
    clone.querySelectorAll('s').forEach(function (el) { el.parentNode.removeChild(el); });
    return Number(clean(clone.textContent));
  }

  /** Was this submitter penalised for not voting? */
  function penalisedFor(card) {
    const badges = card.querySelectorAll(SELECTORS.badge);
    for (let i = 0; i < badges.length; i++) {
      if (text(badges[i]).toLowerCase().indexOf(PENALTY_BADGE) !== -1) return true;
    }
    return false;
  }

  /**
   * Which round is this page? Read from the header, never assumed.
   *
   *   <span class="card-text text-body-tertiary">ROUND 4</span>
   *   <h5 class="card-title">Cover Songs</h5>
   *
   * Music League's numbering is what players see, so R04 here means round 4
   * there. That keeps the Rounds tab legible to everyone else in the league.
   */
  function roundInfo(doc) {
    const title = doc.querySelector(SELECTORS.roundTitle);
    const scope = title && title.parentNode ? title.parentNode : doc;
    let number = null;

    const candidates = scope.querySelectorAll(SELECTORS.roundLabel);
    for (let i = 0; i < candidates.length; i++) {
      const m = /^ROUND\s+(\d+)$/i.exec(text(candidates[i]));
      if (m) { number = Number(m[1]); break; }
    }

    const padded = number === null ? null : (number < 10 ? 'R0' + number : 'R' + number);
    return {
      number: number,
      theme: text(title),
      roundId: ROUND_ID_OVERRIDE || padded
    };
  }

  /**
   * Reads the results page. Returns one object per song, each with its votes.
   * Pure: takes a document, touches nothing, so it can be tested off a fixture.
   */
  function extractResults(doc) {
    const songs = [];

    doc.querySelectorAll(SELECTORS.songCard).forEach(function (card, i) {
      const trackId = card.id.replace(/^spotify:track:/, '');
      const link = card.querySelector(SELECTORS.trackLink);
      const col = link ? link.closest('.col') : null;
      const paras = col ? col.querySelectorAll(SELECTORS.cardText) : [];

      const votes = [];
      const box = doc.getElementById(SELECTORS.votesBox + trackId);
      if (box) {
        box.querySelectorAll(SELECTORS.voteRow).forEach(function (row) {
          const who = row.querySelector(SELECTORS.voter);
          const pts = row.querySelector(SELECTORS.points);
          if (!who || !pts) return;   // spacer rows
          votes.push({
            voter: text(who),
            points: Number(text(pts)),
            comment: text(row.querySelector(SELECTORS.comment))
          });
        });
      }

      songs.push({
        position: i + 1,
        track_id: trackId,
        title: text(link),
        artist: paras.length ? text(paras[0]) : '',
        album: paras.length > 1 ? text(paras[1]) : '',
        submitter: text(card.querySelector(SELECTORS.submitter)),
        total_points: effectiveTotal(card),
        points_before_penalty: card.querySelector(SELECTORS.struck)
          ? Number(text(card.querySelector(SELECTORS.struck))) : null,
        penalised: penalisedFor(card),
        votes: votes
      });
    });

    return songs;
  }

  function toTsv(rows) {
    return rows.map(function (r) { return r.join('\t'); }).join('\n');
  }

  function submissionsTsv(songs, roundId) {
    // Fourth column is did_not_vote: Music League zeroes the song of anyone who
    // did not vote, and the scoring layer needs that stated, not inferred --
    // voting all zeros is voting.
    return toTsv(songs.map(function (s) {
      return [roundId, s.track_id, s.submitter, s.penalised ? 'TRUE' : 'FALSE'];
    }));
  }

  /**
   * Everyone who took part in this round: submitters plus voters, deduped.
   *
   * Exists because Players is keyed on names that must match Music League
   * character for character — "Zoë Müller", "tcarter4471" — and retyping
   * those by hand is the single most likely way to break the whole sheet.
   *
   * It is the round's roster, NOT the league's: anyone who sat this one out
   * does not appear. Add them when they next play.
   */
  function playersTsv(songs) {
    const names = [];
    function note(n) { if (n && names.indexOf(n) === -1) names.push(n); }
    songs.forEach(function (s) {
      note(s.submitter);
      s.votes.forEach(function (v) { note(v.voter); });
    });
    names.sort(function (a, b) { return a.localeCompare(b); });
    return toTsv(names.map(function (n) { return [n, 'TRUE']; }));
  }

  /**
   * The Tracks tab, as far as this page can fill it.
   *
   * artist_ids / genres / release_year / spotify_popularity are left blank:
   * they come from Spotify, and only GenreStats would use them. Everything
   * downstream works without them.
   */
  function tracksTsv(songs, roundId) {
    return toTsv(songs.map(function (s) {
      return [roundId, s.position, s.track_id, s.title, s.artist, '', '', '', ''];
    }));
  }

  function votesTsv(songs, roundId) {
    const rows = [];
    songs.forEach(function (s) {
      s.votes.forEach(function (v) {
        // Trailing title is for human eyes only -- the join is on track_id.
        rows.push([roundId, s.track_id, v.voter, v.points, v.comment, s.title]);
      });
    });
    return toTsv(rows);
  }

  /**
   * Does the page agree with itself? Each card prints its own total, so summing
   * the vote rows and comparing catches a selector that is quietly missing rows
   * — which would otherwise look like a plausible, wrong leaderboard.
   */
  function check(songs) {
    const problems = [];
    const advisories = [];
    if (!songs.length) problems.push('No song cards found at all. Wrong page, or the markup changed.');

    songs.forEach(function (s) {
      if (!s.track_id) problems.push('A card has no track id.');
      if (!s.submitter) problems.push(s.track_id + ': no submitter found.');

      const summed = s.votes.reduce(function (a, v) { return a + v.points; }, 0);
      if (s.penalised) {
        // Expect the votes to reconcile with the PRE-penalty figure.
        const before = s.points_before_penalty;
        if (before !== null && summed !== before) {
          problems.push(s.track_id + ': votes sum to ' + summed +
            ' but the struck-through total is ' + before + '.');
        } else {
          advisories.push(s.submitter + ' did not vote, so Music League zeroed "' + s.title +
            '" (' + summed + ' -> 0). We keep the ' + summed +
            ' as cast, so our total will differ from the official standings.');
        }
      } else if (isFinite(s.total_points) && summed !== s.total_points) {
        problems.push(s.track_id + ': votes sum to ' + summed +
          ' but the page says ' + s.total_points + '.');
      }

      s.votes.forEach(function (v) {
        if (!v.voter) problems.push(s.track_id + ': a vote row has no voter.');
        if (!isFinite(v.points)) problems.push(s.track_id + ': ' + v.voter + ' has unreadable points.');
      });
    });

    return { problems: problems, advisories: advisories };
  }

  /** For an unknown page. Prints shape, extracts nothing, sends nothing. */
  function discover(doc) {
    doc = doc || document;
    const ids = {};
    doc.querySelectorAll('[id]').forEach(function (el) {
      const key = el.id.replace(/[0-9a-f]{8,}/g, '<ID>').replace(/[A-Za-z0-9]{22}/g, '<SPOTIFY>');
      ids[key] = (ids[key] || 0) + 1;
    });
    console.log('id patterns on this page:', ids);
    console.log('spotify track links:',
      doc.querySelectorAll('a[href*="open.spotify.com/track/"]').length);
    console.log('embedded JSON blobs:',
      doc.querySelectorAll('script[type="application/json"]').length);
    console.log('__NEXT_DATA__:', typeof window !== 'undefined' && !!window.__NEXT_DATA__);
    return ids;
  }

  // ---------------------------------------------------------------------------

  /** Sends the round to the endpoint. The only path that touches the network. */
  function post(payload) {
    return fetch(ENDPOINT, {
      method: 'POST',
      // Apps Script web apps reject preflighted requests, so send as text/plain.
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload)
    }).then(function (r) { return r.text(); });
  }

  function payloadFor(round) {
    return {
      token: TOKEN,
      roundId: round.info.roundId,
      theme: round.info.theme,
      tracks: round.songs.map(function (s) {
        return { track_id: s.track_id, position: s.position, title: s.title, artist: s.artist };
      }),
      submissions: round.songs.map(function (s) {
        return { track_id: s.track_id, submitter: s.submitter, did_not_vote: s.penalised };
      }),
      votes: round.songs.reduce(function (rows, s) {
        s.votes.forEach(function (v) {
          rows.push({ track_id: s.track_id, voter: v.voter, points: v.points,
            comment: v.comment, title: s.title });
        });
        return rows;
      }, [])
    };
  }

  function buildRound(doc) {
    const songs = extractResults(doc);
    const info = roundInfo(doc);
    return {
      info: info,
      songs: songs,
      checked: check(songs),
      playersTSV: playersTsv(songs),
      tracksTSV: tracksTsv(songs, info.roundId),
      submissionsTSV: submissionsTsv(songs, info.roundId),
      votesTSV: votesTsv(songs, info.roundId)
    };
  }

  function printTsv(round) {
    console.log('\n=== PLAYERS — paste into the Players tab, cell A2 ===\n');
    console.log(round.playersTSV);
    console.log('\n=== TRACKS — paste into the Tracks tab, cell A2 ===\n');
    console.log(round.tracksTSV);
    console.log('\n=== SUBMISSIONS — paste into the Submissions tab, cell A2 ===\n');
    console.log(round.submissionsTSV);
    console.log('\n=== VOTES — paste into the Votes tab, cell A2 ===\n');
    console.log(round.votesTSV);
    console.log('\nClipboard, one at a time:');
    console.log('  copy(ML.playersTSV)');
    console.log('  copy(ML.tracksTSV)');
    console.log('  copy(ML.submissionsTSV)');
    console.log('  copy(ML.votesTSV)');
  }

  function run(doc) {
    const round = buildRound(doc);
    window.ML = {
      round: round.info, songs: round.songs,
      playersTSV: round.playersTSV, tracksTSV: round.tracksTSV,
      submissionsTSV: round.submissionsTSV, votesTSV: round.votesTSV,
      problems: round.checked.problems, advisories: round.checked.advisories,
      discover: discover
    };

    if (!round.info.roundId) {
      console.warn('[ML->Sheet] could not read the round number from this page. ' +
        'Set ROUND_ID_OVERRIDE and re-run.');
      return;
    }

    const voteCount = round.songs.reduce(function (a, s) { return a + s.votes.length; }, 0);
    console.log('[ML->Sheet] ' + round.info.roundId + ' "' + round.info.theme + '" — ' +
      round.songs.length + ' songs, ' + voteCount + ' votes');

    if (round.checked.problems.length) {
      console.warn('PROBLEMS (' + round.checked.problems.length + ') — nothing sent or printed:');
      round.checked.problems.forEach(function (p) { console.warn('  ' + p); });
      return;
    }
    round.checked.advisories.forEach(function (a) { console.warn('[ML->Sheet] ' + a); });

    if (!ENDPOINT || !TOKEN) { printTsv(round); return; }

    post(payloadFor(round)).then(function (t) {
      console.log('[ML->Sheet] sent:', t);
    }).catch(function (e) {
      console.error('[ML->Sheet] send failed; printing for copy-paste instead:', e);
      printTsv(round);
    });
  }

  // -------------------------------------------------------------------------

  if (typeof document === 'undefined') return;

  console.log('[ML->Sheet] active');

  // discover() has to work on a page this script cannot read -- that is the
  // whole point of it -- so expose it before any extraction is attempted.
  window.ML = window.ML || { discover: discover };

  if (document.querySelector(SELECTORS.songCard)) {
    run(document);   // already rendered: a console paste, or a fixture in a test
  } else {
    // htmx swaps the results in after load, so wait for them rather than
    // concluding there is nothing here.
    let done = false;
    const finish = function (found) {
      if (done) return;
      done = true;
      observer.disconnect();
      if (found) run(document);
      else console.log('[ML->Sheet] no round results on this page.');
    };
    const observer = new MutationObserver(function () {
      if (document.querySelector(SELECTORS.songCard)) finish(true);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(function () { finish(!!document.querySelector(SELECTORS.songCard)); }, RESULTS_WAIT_MS);
  }
})();
