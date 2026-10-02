/**
 * Analytics — everything derived. Safe to re-run at any time; it always
 * rebuilds from Votes / Submissions / Guesses / Tracks.
 */

function recomputeAll() {
  guard_('Recompute analytics', function () { recomputeAll_(); });
}

function recomputeAll_() {
  const data = loadAll_();
  const results = computeRoundResults_(data);
  const guessScores = computeGuessScores_(data);

  writeRoundResults_(results);
  writeGuessScores_(guessScores);
  const leaderboard = computeLeaderboard_(data, results, guessScores);
  writeLeaderboard_(leaderboard);
  // FanMatrix and GenreStats are deliberately all-time — see the season note
  // above computeAwards_.
  writeFanMatrix_(computeFanMatrix_(data));
  writeGenreStats_(computeGenreStats_(data, results));
  writeAwards_(computeAwards_(data, results, guessScores));

  toast_('Analytics rebuilt.');
}

function loadAll_() {
  const votes = readTable_(SHEETS.VOTES).map(function (v) {
    return {
      round_id: String(v.round_id), track_id: String(v.track_id),
      voter: String(v.voter).trim(), points: Number(v.points) || 0, comment: v.comment
    };
  });
  const submissions = readTable_(SHEETS.SUBMISSIONS).map(function (s) {
    return {
      round_id: String(s.round_id), track_id: String(s.track_id),
      submitter: String(s.submitter).trim(), did_not_vote: truthy_(s.did_not_vote)
    };
  });
  const guesses = readTable_(SHEETS.GUESSES).map(function (g) {
    return {
      round_id: String(g.round_id), track_id: String(g.track_id),
      guesser: String(g.guesser).trim(), guessed: String(g.guessed).trim()
    };
  });
  const tracks = readTable_(SHEETS.TRACKS).map(function (t) {
    return {
      round_id: String(t.round_id), track_id: String(t.track_id), position: Number(t.position),
      title: t.title, artist: t.artist, genres: String(t.genres || ''),
      release_year: t.release_year
    };
  });
  const rounds = readTable_(SHEETS.ROUNDS).map(function (r) {
    return { round_id: String(r.round_id), season: r.season };
  });
  return { votes: votes, submissions: submissions, guesses: guesses, tracks: tracks, rounds: rounds };
}

function key_(roundId, trackId) { return roundId + '|' + trackId; }

// ---------------------------------------------------------------------------
// Seasons
// ---------------------------------------------------------------------------

/**
 * round_id -> season number, from the Rounds tab. A round with a blank season,
 * or no Rounds row at all, is DEFAULT_SEASON — so a sheet that predates this
 * column keeps working untouched.
 */
/** Sheets hand back TRUE, "TRUE", "true", 1 or "" depending on how it was typed. */
function truthy_(v) {
  if (v === true) return true;
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'true' || s === 'yes' || s === '1';
}

/**
 * Submissions penalised by Music League's did-not-vote rule, as {key: true}.
 *
 * Read from the recorded flag, never inferred from an absence in Votes:
 * someone who voted all zeros did vote, and Music League does not penalise
 * them. See "The did-not-vote penalty" in CLAUDE.md.
 */
function penalisedSet_(d) {
  const out = {};
  d.submissions.forEach(function (s) {
    if (s.did_not_vote) out[key_(s.round_id, s.track_id)] = true;
  });
  return out;
}

function seasonMap_(d) {
  const m = {};
  (d.rounds || []).forEach(function (r) {
    const n = Number(r.season);
    m[String(r.round_id)] = n > 0 ? n : DEFAULT_SEASON;
  });
  return m;
}

function seasonOf_(seasons, roundId) {
  return seasons[String(roundId)] || DEFAULT_SEASON;
}

/** Every season that has any data, latest first. */
function seasonsOf_(d) {
  const seasons = seasonMap_(d);
  const seen = {};
  function note(roundId) { seen[seasonOf_(seasons, roundId)] = true; }
  (d.rounds || []).forEach(function (r) { note(r.round_id); });
  d.tracks.forEach(function (t) { note(t.round_id); });
  d.submissions.forEach(function (s) { note(s.round_id); });
  d.votes.forEach(function (v) { note(v.round_id); });
  d.guesses.forEach(function (g) { note(g.round_id); });
  return Object.keys(seen).map(Number).sort(function (a, b) { return b - a; });
}

function latestSeason_(d) {
  const all = seasonsOf_(d);
  return all.length ? all[0] : DEFAULT_SEASON;
}

/** The same {votes, submissions, guesses, tracks, rounds} shape, one season of it. */
function filterSeason_(d, season) {
  const seasons = seasonMap_(d);
  function keep(row) { return seasonOf_(seasons, row.round_id) === season; }
  return {
    votes: d.votes.filter(keep),
    submissions: d.submissions.filter(keep),
    guesses: d.guesses.filter(keep),
    tracks: d.tracks.filter(keep),
    rounds: (d.rounds || []).filter(keep)
  };
}

// ---------------------------------------------------------------------------
// Per-song results
// ---------------------------------------------------------------------------

function computeRoundResults_(d) {
  const submitterOf = {};
  d.submissions.forEach(function (s) { submitterOf[key_(s.round_id, s.track_id)] = s.submitter; });

  const trackOf = {};
  d.tracks.forEach(function (t) { trackOf[key_(t.round_id, t.track_id)] = t; });

  // Who voted at all in each round — needed so we can count a 0 as a real 0.
  const roundVoters = {};
  d.votes.forEach(function (v) {
    if (!roundVoters[v.round_id]) roundVoters[v.round_id] = {};
    roundVoters[v.round_id][v.voter] = true;
  });

  const byTrack = {};
  d.votes.forEach(function (v) {
    const k = key_(v.round_id, v.track_id);
    if (!byTrack[k]) byTrack[k] = {};
    byTrack[k][v.voter] = (byTrack[k][v.voter] || 0) + v.points;
  });

  const out = [];
  Object.keys(byTrack).forEach(function (k) {
    const parts = k.split('|');
    const roundId = parts[0];
    const trackId = parts[1];
    const submitter = submitterOf[k] || '';
    const t = trackOf[k] || {};

    const pointsByVoter = byTrack[k];
    const electorate = Object.keys(roundVoters[roundId] || {}).filter(function (name) {
      return name !== submitter; // you can't vote for yourself
    });

    let total = 0;
    let voters = 0;
    const vector = [];
    electorate.forEach(function (name) {
      const p = pointsByVoter[name] || 0;
      total += p;
      if (p > 0) voters++;
      vector.push(p);
    });

    out.push({
      round_id: roundId,
      track_id: trackId,
      position: t.position || 0,
      title: t.title || trackId,
      artist: t.artist || '',
      submitter: submitter,
      total_points: total,
      voters: voters,
      avg_per_voter: voters ? round2_(total / voters) : 0,
      spread: round2_(stdev_(vector)),
      genres: t.genres || ''
    });
  });

  out.sort(function (a, b) {
    if (a.round_id !== b.round_id) return a.round_id < b.round_id ? -1 : 1;
    return b.total_points - a.total_points;
  });
  return out;
}

function writeRoundResults_(results) {
  writeTable_(SHEETS.ROUND_RESULTS, results.map(function (r) {
    return [r.round_id, r.position, r.title, r.artist, r.submitter,
      r.total_points, r.voters, r.avg_per_voter, r.spread, r.genres];
  }));
}

// ---------------------------------------------------------------------------
// Guess scoring
// ---------------------------------------------------------------------------

function computeGuessScores_(d) {
  const submitterOf = {};
  d.submissions.forEach(function (s) { submitterOf[key_(s.round_id, s.track_id)] = s.submitter; });

  // Only score guesses on tracks whose submitter is known (i.e. after reveal),
  // and never score someone guessing their own song.
  const scored = d.guesses.filter(function (g) {
    const actual = submitterOf[key_(g.round_id, g.track_id)];
    return actual && actual !== g.guesser && g.guessed !== NO_IDEA;
  });

  // Difficulty per track: what share of eligible guessers got it right?
  const perTrack = {};
  scored.forEach(function (g) {
    const k = key_(g.round_id, g.track_id);
    if (!perTrack[k]) perTrack[k] = { n: 0, correct: 0 };
    perTrack[k].n++;
    if (g.guessed === submitterOf[k]) perTrack[k].correct++;
  });

  const perGuesser = {};
  scored.forEach(function (g) {
    const gk = g.round_id + '|' + g.guesser;
    if (!perGuesser[gk]) perGuesser[gk] = { round_id: g.round_id, guesser: g.guesser, eligible: 0, correct: 0, points: 0 };
    const row = perGuesser[gk];
    row.eligible++;

    if (g.guessed === submitterOf[key_(g.round_id, g.track_id)]) {
      row.correct++;
      if (GUESS_SCORING === 'flat') {
        row.points += 1;
      } else {
        const stats = perTrack[key_(g.round_id, g.track_id)];
        const frac = stats.correct / stats.n;
        row.points += Math.min(GUESS_POINTS_CAP, 1 / Math.max(frac, 1 / GUESS_POINTS_CAP));
      }
    }
  });

  const out = Object.keys(perGuesser).map(function (k) {
    const r = perGuesser[k];
    return {
      round_id: r.round_id, guesser: r.guesser, eligible: r.eligible, correct: r.correct,
      hit_rate: r.eligible ? round2_(r.correct / r.eligible) : 0,
      guess_points: round2_(r.points)
    };
  });
  out.sort(function (a, b) {
    if (a.round_id !== b.round_id) return a.round_id < b.round_id ? -1 : 1;
    return b.guess_points - a.guess_points;
  });
  return out;
}

function writeGuessScores_(rows) {
  writeTable_(SHEETS.GUESS_SCORES, rows.map(function (r) {
    return [r.round_id, r.guesser, r.eligible, r.correct, r.hit_rate, r.guess_points];
  }));
}

// ---------------------------------------------------------------------------
// Combined leaderboard
// ---------------------------------------------------------------------------

/**
 * Each of the three components is converted to a share of that round's total
 * before being weighted, so a round with 6 players and one with 10 count the
 * same. combined is an index (x100), not a point count.
 *
 * One row per (season, player): a cumulative table is unwinnable by round 15,
 * which is the whole reason seasons exist. Per-round normalisation is
 * unchanged — only the aggregation key gained a season.
 */
function computeLeaderboard_(d, results, guessScores) {
  const seasons = seasonMap_(d);
  const penalised = penalisedSet_(d);
  const rounds = {};
  results.forEach(function (r) {
    if (!rounds[r.round_id]) rounds[r.round_id] = { points: 0, voters: 0, guess: 0, players: {} };
    if (r.submitter) rounds[r.round_id].players[r.submitter] = true;
    // A penalised song leaves the denominator as well as the numerator, so
    // the remaining songs' shares still add up to WEIGHTS.song x 100.
    if (penalised[key_(r.round_id, r.track_id)]) return;
    rounds[r.round_id].points += r.total_points;
    rounds[r.round_id].voters += r.voters;
  });
  guessScores.forEach(function (g) {
    if (!rounds[g.round_id]) rounds[g.round_id] = { points: 0, voters: 0, guess: 0, players: {} };
    rounds[g.round_id].guess += g.guess_points;
    rounds[g.round_id].players[g.guesser] = true;
  });

  const players = {};
  function ensure_(season, name) {
    const k = season + '|' + name;
    if (!players[k]) {
      players[k] = { season: season, player: name, song_points: 0, popularity_points: 0, guess_points: 0, combined: 0, rounds: {} };
    }
    return players[k];
  }

  // Everyone who submitted played the round, even if their song drew no votes
  // at all. computeRoundResults_ only emits rows for tracks that received
  // votes, so without this they vanish from the table rather than showing 0.
  d.submissions.forEach(function (s) {
    if (!s.submitter) return;
    ensure_(seasonOf_(seasons, s.round_id), s.submitter).rounds[s.round_id] = true;
  });

  results.forEach(function (r) {
    if (!r.submitter) return;
    const p = ensure_(seasonOf_(seasons, r.round_id), r.submitter);
    p.rounds[r.round_id] = true;   // they still played the round
    if (penalised[key_(r.round_id, r.track_id)]) return;
    const tot = rounds[r.round_id];
    p.song_points += r.total_points;
    p.popularity_points += r.voters;
    if (tot.points > 0) p.combined += WEIGHTS.song * (r.total_points / tot.points) * 100;
    if (tot.voters > 0) p.combined += WEIGHTS.pop * (r.voters / tot.voters) * 100;
  });

  guessScores.forEach(function (g) {
    const p = ensure_(seasonOf_(seasons, g.round_id), g.guesser);
    const tot = rounds[g.round_id];
    p.guess_points += g.guess_points;
    p.rounds[g.round_id] = true;
    if (tot.guess > 0) p.combined += WEIGHTS.guess * (g.guess_points / tot.guess) * 100;
  });

  const out = Object.keys(players).map(function (n) {
    const p = players[n];
    return {
      season: p.season,
      player: p.player,
      song_points: round2_(p.song_points),
      popularity_points: p.popularity_points,
      guess_points: round2_(p.guess_points),
      combined: round2_(p.combined),
      rounds_played: Object.keys(p.rounds).length
    };
  });
  // Latest season first, then the standings within it.
  out.sort(function (a, b) {
    if (a.season !== b.season) return b.season - a.season;
    return b.combined - a.combined;
  });
  return out;
}

function writeLeaderboard_(rows) {
  writeTable_(SHEETS.LEADERBOARD, rows.map(function (r) {
    return [r.season, r.player, r.song_points, r.popularity_points, r.guess_points, r.combined, r.rounds_played];
  }));
}

// ---------------------------------------------------------------------------
// Who is whose biggest fan
// ---------------------------------------------------------------------------

/**
 * Raw points given is misleading — whoever votes in the most rounds looks
 * like everyone's biggest fan. So we normalise by the total points that voter
 * handed out in the rounds where both people took part.
 */
function computeFanMatrix_(d) {
  const submitterOf = {};
  d.submissions.forEach(function (s) { submitterOf[key_(s.round_id, s.track_id)] = s.submitter; });

  const submittedIn = {}; // player -> {round: true}
  d.submissions.forEach(function (s) {
    if (!submittedIn[s.submitter]) submittedIn[s.submitter] = {};
    submittedIn[s.submitter][s.round_id] = true;
  });

  const votedIn = {};
  const votedTotalByRound = {}; // voter|round -> total points distributed
  d.votes.forEach(function (v) {
    if (!votedIn[v.voter]) votedIn[v.voter] = {};
    votedIn[v.voter][v.round_id] = true;
    const k = v.voter + '|' + v.round_id;
    votedTotalByRound[k] = (votedTotalByRound[k] || 0) + Math.max(0, v.points);
  });

  const pairs = {};
  d.votes.forEach(function (v) {
    const submitter = submitterOf[key_(v.round_id, v.track_id)];
    if (!submitter || submitter === v.voter) return;
    const pk = v.voter + '→' + submitter;
    if (!pairs[pk]) pairs[pk] = { voter: v.voter, submitter: submitter, points: 0 };
    pairs[pk].points += v.points;
  });

  const out = Object.keys(pairs).map(function (pk) {
    const p = pairs[pk];
    const shared = Object.keys(votedIn[p.voter] || {}).filter(function (r) {
      return (submittedIn[p.submitter] || {})[r];
    });
    let denom = 0;
    shared.forEach(function (r) { denom += votedTotalByRound[p.voter + '|' + r] || 0; });
    return {
      voter: p.voter,
      submitter: p.submitter,
      points_given: round2_(p.points),
      share: denom > 0 ? round2_(p.points / denom) : 0,
      shared_rounds: shared.length
    };
  });
  // Grouped by voter so the tab reads as "who does this person vote for",
  // then biggest first within each voter. Nothing downstream may depend on
  // this order -- computeAwards_ picks its winners by value, not position.
  out.sort(function (a, b) {
    if (a.voter !== b.voter) return a.voter.localeCompare(b.voter);
    return b.points_given - a.points_given;
  });
  return out;
}

function writeFanMatrix_(rows) {
  writeTable_(SHEETS.FAN_MATRIX, rows.map(function (r) {
    return [r.voter, r.submitter, r.points_given, r.share, r.shared_rounds];
  }));
}

// ---------------------------------------------------------------------------
// Genres
// ---------------------------------------------------------------------------

function computeGenreStats_(d, results) {
  const byGenre = {};
  results.forEach(function (r) {
    const genres = String(r.genres || '').split(';')
      .map(function (g) { return g.trim(); })
      .filter(String);
    if (!genres.length) genres.push('(untagged)');
    genres.forEach(function (g) {
      if (!byGenre[g]) byGenre[g] = { genre: g, submissions: 0, total: 0, voters: 0 };
      byGenre[g].submissions++;
      byGenre[g].total += r.total_points;
      byGenre[g].voters += r.voters;
    });
  });

  const out = Object.keys(byGenre).map(function (g) {
    const s = byGenre[g];
    return {
      genre: s.genre,
      submissions: s.submissions,
      total_points: round2_(s.total),
      avg_points: round2_(s.total / s.submissions),
      avg_voters: round2_(s.voters / s.submissions)
    };
  });
  // Sort by average, but n matters — one lucky pick shouldn't crown a genre.
  out.sort(function (a, b) { return b.avg_points - a.avg_points; });
  return out;
}

function writeGenreStats_(rows) {
  writeTable_(SHEETS.GENRE_STATS, rows.map(function (r) {
    return [r.genre, r.submissions, r.total_points, r.avg_points, r.avg_voters];
  }));
}

// ---------------------------------------------------------------------------
// Awards
// ---------------------------------------------------------------------------

/**
 * Awards are per season, so every row in the table means the same thing.
 *
 * That includes the two fandom awards, which run off a season-scoped fan
 * matrix computed here rather than the all-time FanMatrix tab. Mixing an
 * all-time number into a per-season table is the kind of quiet inconsistency
 * that makes people stop trusting the stats.
 *
 * FanMatrix and GenreStats themselves stay all-time on purpose: nobody wins
 * them, and their whole value is sample size. A season of 8 rounds is ~40
 * points per voter, which is noise; four seasons is a real picture of whose
 * taste somebody actually likes. The leaderboard resets because a cumulative
 * index kills participation, and that argument doesn't transfer to them.
 */
function computeAwards_(d, results, guessScores) {
  const seasons = seasonMap_(d);
  const out = [];

  seasonsOf_(d).forEach(function (season) {
    const sd = filterSeason_(d, season);
    const sr = results.filter(function (r) { return seasonOf_(seasons, r.round_id) === season; });
    const sg = guessScores.filter(function (g) { return seasonOf_(seasons, g.round_id) === season; });
    seasonAwards_(sd, sr, sg, computeFanMatrix_(sd)).forEach(function (a) {
      out.push([season].concat(a));
    });
  });

  return out;
}

/** The awards for one season's worth of already-filtered data. */
function seasonAwards_(d, results, guessScores, fans) {
  const awards = [];

  const scoredSongs = results.filter(function (r) { return r.submitter; });

  if (scoredSongs.length) {
    const best = scoredSongs.slice().sort(function (a, b) { return b.total_points - a.total_points; })[0];
    awards.push(['Highest scoring song', best.submitter, best.title + ' — ' + best.artist + ' (' + best.round_id + ')', best.total_points]);

    const widest = scoredSongs.slice().sort(function (a, b) { return b.voters - a.voters || b.total_points - a.total_points; })[0];
    awards.push(['Most broadly liked song', widest.submitter, widest.title + ' (' + widest.voters + ' voters)', widest.voters]);

    const divisive = scoredSongs.filter(function (r) { return r.voters >= 2; })
      .sort(function (a, b) { return b.spread - a.spread; })[0];
    if (divisive) {
      awards.push(['Most divisive song', divisive.submitter, divisive.title + ' (stdev ' + divisive.spread + ')', divisive.spread]);
    }

    const sleeper = scoredSongs.filter(function (r) { return r.voters >= 3; })
      .sort(function (a, b) { return a.avg_per_voter - b.avg_per_voter; })[0];
    if (sleeper) {
      awards.push(['Faint praise award', sleeper.submitter, sleeper.title + ' — liked by ' + sleeper.voters + ', avg ' + sleeper.avg_per_voter, sleeper.avg_per_voter]);
    }
  }

  // Best guesser overall
  const guessTotals = {};
  guessScores.forEach(function (g) {
    if (!guessTotals[g.guesser]) guessTotals[g.guesser] = { correct: 0, eligible: 0, points: 0 };
    guessTotals[g.guesser].correct += g.correct;
    guessTotals[g.guesser].eligible += g.eligible;
    guessTotals[g.guesser].points += g.guess_points;
  });
  const guessers = Object.keys(guessTotals).sort(function (a, b) { return guessTotals[b].points - guessTotals[a].points; });
  if (guessers.length) {
    const g = guessTotals[guessers[0]];
    awards.push(['Best detective', guessers[0], g.correct + '/' + g.eligible + ' correct', round2_(g.points)]);
  }

  // How often is each person's own song correctly identified?
  const submitterOf = {};
  d.submissions.forEach(function (s) { submitterOf[key_(s.round_id, s.track_id)] = s.submitter; });
  const identified = {};
  d.guesses.forEach(function (gs) {
    const actual = submitterOf[key_(gs.round_id, gs.track_id)];
    if (!actual || actual === gs.guesser || gs.guessed === NO_IDEA) return;
    if (!identified[actual]) identified[actual] = { n: 0, hit: 0 };
    identified[actual].n++;
    if (gs.guessed === actual) identified[actual].hit++;
  });
  const identNames = Object.keys(identified).filter(function (n) { return identified[n].n >= 5; });
  if (identNames.length) {
    const rates = identNames.map(function (n) {
      return { name: n, rate: identified[n].hit / identified[n].n, n: identified[n].n };
    }).sort(function (a, b) { return b.rate - a.rate; });
    const mostKnown = rates[0];
    const deceiver = rates[rates.length - 1];
    awards.push(['Most recognisable taste', mostKnown.name, 'identified ' + Math.round(mostKnown.rate * 100) + '% of the time (n=' + mostKnown.n + ')', round2_(mostKnown.rate)]);
    awards.push(['Best deceiver', deceiver.name, 'identified only ' + Math.round(deceiver.rate * 100) + '% of the time (n=' + deceiver.n + ')', round2_(deceiver.rate)]);
  }

  // Fandom
  const solid = fans.filter(function (f) { return f.shared_rounds >= 2; });
  if (solid.length) {
    // By value, not by position: the FanMatrix tab is sorted for reading.
    const top = solid.reduce(function (best, f) { return f.share > best.share ? f : best; });
    awards.push(['Biggest fan', top.voter, 'gives ' + Math.round(top.share * 100) + '% of their points to ' + top.submitter, round2_(top.share)]);

    const lookup = {};
    solid.forEach(function (f) { lookup[f.voter + '→' + f.submitter] = f.share; });
    let worst = null;
    solid.forEach(function (f) {
      const back = lookup[f.submitter + '→' + f.voter] || 0;
      const gap = f.share - back;
      if (!worst || gap > worst.gap) worst = { from: f.voter, to: f.submitter, gap: gap, share: f.share, back: back };
    });
    if (worst && worst.gap > 0) {
      awards.push(['Most unrequited love', worst.from,
        'gives ' + Math.round(worst.share * 100) + '% to ' + worst.to + ', gets ' + Math.round(worst.back * 100) + '% back',
        round2_(worst.gap)]);
    }
  }

  // -------------------------------------------------------------------------
  // Awards about behaviour rather than results. All of these come from Votes
  // alone, deliberately: anything about genre or obscurity needs a signal
  // Spotify removed in February 2026. See Deferred in CLAUDE.md.
  // -------------------------------------------------------------------------

  const MIN_ROUNDS_FOR_PATTERN = 3;

  // Rank each round's songs so we can talk about winners and also-rans.
  const byRound = {};
  results.forEach(function (r) {
    if (!byRound[r.round_id]) byRound[r.round_id] = [];
    byRound[r.round_id].push(r);
  });
  const winnerOf = {};
  const bottomHalf = {};
  const roundTotal = {};
  Object.keys(byRound).forEach(function (rid) {
    const rows = byRound[rid].slice().sort(function (a, b) { return b.total_points - a.total_points; });
    if (rows.length) winnerOf[rid] = rows[0].track_id;
    rows.slice(Math.ceil(rows.length / 2)).forEach(function (r) {
      bottomHalf[key_(rid, r.track_id)] = true;
    });
    roundTotal[rid] = rows.reduce(function (a, r) { return a + r.total_points; }, 0);
  });

  const votedIn = {};
  const backedWinner = {};
  const pointsLow = {};
  const pointsAll = {};
  const comments = {};
  d.votes.forEach(function (v) {
    if (!votedIn[v.voter]) votedIn[v.voter] = {};
    votedIn[v.voter][v.round_id] = true;
    pointsAll[v.voter] = (pointsAll[v.voter] || 0) + v.points;
    if (bottomHalf[key_(v.round_id, v.track_id)]) {
      pointsLow[v.voter] = (pointsLow[v.voter] || 0) + v.points;
    }
    if (v.points > 0 && winnerOf[v.round_id] === v.track_id) {
      if (!backedWinner[v.voter]) backedWinner[v.voter] = {};
      backedWinner[v.voter][v.round_id] = true;
    }
    if (String(v.comment || '').trim()) comments[v.voter] = (comments[v.voter] || 0) + 1;
  });

  const regulars = Object.keys(votedIn).filter(function (n) {
    return Object.keys(votedIn[n]).length >= MIN_ROUNDS_FOR_PATTERN;
  });

  if (regulars.length) {
    const king = regulars.map(function (n) {
      const played = Object.keys(votedIn[n]).length;
      const hits = Object.keys(backedWinner[n] || {}).length;
      return { name: n, hits: hits, played: played, rate: hits / played };
    }).sort(function (a, b) { return b.rate - a.rate; })[0];
    if (king.hits) {
      awards.push(['Kingmaker', king.name,
        'gave points to the winning song in ' + king.hits + ' of ' + king.played + ' rounds',
        round2_(king.rate)]);
    }

    const contrarian = regulars.map(function (n) {
      return { name: n, share: (pointsLow[n] || 0) / (pointsAll[n] || 1) };
    }).sort(function (a, b) { return b.share - a.share; })[0];
    if (contrarian.share > 0) {
      awards.push(['Contrarian', contrarian.name,
        Math.round(contrarian.share * 100) + '% of their points went to songs that finished in the bottom half',
        round2_(contrarian.share)]);
    }
  }

  // Taste twins: both directions strong, so it is mutual rather than one-sided.
  const shareOf = {};
  fans.forEach(function (f) { shareOf[f.voter + '\u2192' + f.submitter] = f; });
  let twins = null;
  fans.forEach(function (f) {
    if (f.voter >= f.submitter) return;   // consider each pair once
    const back = shareOf[f.submitter + '\u2192' + f.voter];
    if (!back || f.shared_rounds < 2 || back.shared_rounds < 2) return;
    const mutual = Math.min(f.share, back.share);
    if (!twins || mutual > twins.mutual) {
      twins = { a: f.voter, b: f.submitter, mutual: mutual };
    }
  });
  if (twins && twins.mutual > 0) {
    awards.push(['Taste twins', twins.a + ' and ' + twins.b,
      'each give the other at least ' + Math.round(twins.mutual * 100) + '% of their points',
      round2_(twins.mutual)]);
  }

  // Round-to-round shape: who is metronomic, and who had one enormous night.
  const sharesBy = {};
  results.forEach(function (r) {
    if (!r.submitter || !roundTotal[r.round_id]) return;
    if (!sharesBy[r.submitter]) sharesBy[r.submitter] = [];
    sharesBy[r.submitter].push(r.total_points / roundTotal[r.round_id]);
  });
  const veterans = Object.keys(sharesBy).filter(function (n) {
    return sharesBy[n].length >= MIN_ROUNDS_FOR_PATTERN;
  });
  if (veterans.length) {
    const steady = veterans.map(function (n) {
      return { name: n, sd: stdev_(sharesBy[n]) };
    }).sort(function (a, b) { return a.sd - b.sd; })[0];
    awards.push(['Most consistent', steady.name,
      'scores roughly the same share every round', round2_(steady.sd)]);

    const spiky = veterans.map(function (n) {
      const xs = sharesBy[n];
      const mean = xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
      return { name: n, ratio: mean > 0 ? Math.max.apply(null, xs) / mean : 0 };
    }).sort(function (a, b) { return b.ratio - a.ratio; })[0];
    if (spiky.ratio > 1) {
      awards.push(['One hit wonder', spiky.name,
        'their best round was ' + round2_(spiky.ratio) + 'x their own average',
        round2_(spiky.ratio)]);
    }
  }

  const talkers = Object.keys(comments);
  if (talkers.length) {
    const loudest = talkers.sort(function (a, b) { return comments[b] - comments[a]; })[0];
    awards.push(['Chatterbox', loudest,
      comments[loudest] + ' comments left on other people\'s songs', comments[loudest]]);
  }

  return awards;
}

function writeAwards_(rows) {
  writeTable_(SHEETS.AWARDS, rows);
}

// ---------------------------------------------------------------------------
// Leaderboard sanity check
// ---------------------------------------------------------------------------

/**
 * Works out what sum(Leaderboard.combined) ought to be straight from the raw
 * tables, and compares it against what is actually on the Leaderboard tab.
 *
 * Each round pays out 100, split across the three components by WEIGHTS — but
 * a component only pays out if something scored it. A round nobody voted in
 * pays no song or pop share; a round nobody guessed right pays no guess share,
 * which is the common case and the reason a perfectly healthy league often is
 * not a round multiple of 100.
 *
 * combined is rounded to 2dp per player on the way into the sheet, so the
 * total is allowed to drift half a cent per player.
 *
 * Scoped to one season — the Leaderboard is per season now, so the round
 * expectations have to be too. Defaults to the latest season.
 */
function computeSanityCheck_(d, leaderboard, season) {
  const target = season || latestSeason_(d);
  const sd = filterSeason_(d, target);
  const board = leaderboard.filter(function (p) {
    return (Number(p.season) || DEFAULT_SEASON) === target;
  });

  const submitterOf = {};
  sd.submissions.forEach(function (s) { submitterOf[key_(s.round_id, s.track_id)] = s.submitter; });
  const penalised = penalisedSet_(sd);

  const rounds = {};
  function ensureRound_(roundId) {
    if (!rounds[roundId]) rounds[roundId] = { round_id: roundId, scoring: false, correct_guesses: 0 };
    return rounds[roundId];
  }

  sd.tracks.forEach(function (t) { ensureRound_(t.round_id); });

  sd.votes.forEach(function (v) {
    const r = ensureRound_(v.round_id);
    // A submitter's vote on their own song is dropped by the electorate rule,
    // and a penalised song pays out nothing, so neither can make a round
    // scoring on its own.
    if (v.points > 0
        && submitterOf[key_(v.round_id, v.track_id)] !== v.voter
        && !penalised[key_(v.round_id, v.track_id)]) r.scoring = true;
  });

  sd.guesses.forEach(function (g) {
    const actual = submitterOf[key_(g.round_id, g.track_id)];
    if (!actual || actual === g.guesser || g.guessed === NO_IDEA) return;
    if (g.guessed === actual) ensureRound_(g.round_id).correct_guesses++;
  });

  const breakdown = Object.keys(rounds).sort().map(function (id) {
    const r = rounds[id];
    const song = r.scoring ? WEIGHTS.song * 100 : 0;
    const pop = r.scoring ? WEIGHTS.pop * 100 : 0;
    const guess = r.correct_guesses > 0 ? WEIGHTS.guess * 100 : 0;
    return {
      round_id: r.round_id,
      scoring: r.scoring,
      correct_guesses: r.correct_guesses,
      expected: round2_(song + pop + guess)
    };
  });

  const expected = breakdown.reduce(function (a, r) { return a + r.expected; }, 0);
  const actual = board.reduce(function (a, p) { return a + (Number(p.combined) || 0); }, 0);
  const tolerance = board.length * 0.005;

  return {
    season: target,
    ok: Math.abs(actual - expected) <= tolerance + 1e-9,
    expected: round2_(expected),
    actual: round2_(actual),
    delta: round2_(actual - expected),
    tolerance: tolerance,
    players: board.length,
    rounds: breakdown
  };
}

/** Renders computeSanityCheck_'s result for ui.alert(). */
function formatSanityCheck_(check) {
  const lines = [];
  lines.push('Leaderboard sanity check, season ' + check.season + ': ' + (check.ok ? 'PASS' : 'FAIL'));
  lines.push('');
  lines.push('Expected ' + check.expected.toFixed(2) + ', found ' + check.actual.toFixed(2) +
    ' across ' + check.players + ' player(s).');
  lines.push('Off by ' + check.delta.toFixed(2) + ', tolerance +/-' + check.tolerance.toFixed(3) + '.');
  lines.push('');

  if (!check.rounds.length) {
    lines.push('No rounds in season ' + check.season + ' yet.');
  } else {
    check.rounds.forEach(function (r) {
      const why = [];
      why.push(r.scoring ? 'votes' : 'no votes');
      why.push(r.correct_guesses > 0 ? r.correct_guesses + ' correct guesses' : 'no correct guesses');
      lines.push(r.round_id + ': expected ' + r.expected + ' (' + why.join(', ') + ')');
    });
  }

  if (!check.ok) {
    lines.push('');
    if (check.delta < 0) {
      lines.push('Short by ' + Math.abs(check.delta).toFixed(2) + '. The usual cause is a Votes ' +
        'row whose track has no Submissions row: its points count toward the round total but ' +
        'credit nobody. Run "5. Validate ingested results".');
    } else {
      lines.push('Over by ' + check.delta.toFixed(2) + '. Check for duplicate Leaderboard rows.');
    }
    lines.push('If you have not run "6. Recompute analytics" since the last ingest, do that first.');
  }

  return lines.join('\n');
}

/**
 * Menu entry. Compares the Leaderboard tab against the raw tables.
 *
 * Leads with the latest season, then reports the earlier ones underneath — a
 * shortfall in a finished season is still worth knowing about, but it isn't
 * what you came to look at.
 */
function sanityCheck() {
  guard_('Sanity check', function () {
    const board = readTable_(SHEETS.LEADERBOARD);
    if (!board.length) {
      SpreadsheetApp.getUi().alert('Leaderboard is empty. Run "6. Recompute analytics" first.');
      return;
    }
    const data = loadAll_();
    const report = seasonsOf_(data).map(function (season) {
      return formatSanityCheck_(computeSanityCheck_(data, board, season));
    }).join('\n\n' + new Array(40).join('-') + '\n\n');
    SpreadsheetApp.getUi().alert(report);
  });
}

// ---------------------------------------------------------------------------

function round2_(n) {
  if (!isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function stdev_(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce(function (a, b) { return a + b; }, 0) / arr.length;
  const variance = arr.reduce(function (a, b) { return a + Math.pow(b - mean, 2); }, 0) / arr.length;
  return Math.sqrt(variance);
}
