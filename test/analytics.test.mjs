/**
 * analytics.test.mjs — the seven invariants from CLAUDE.md, checked against
 * the real src/Analytics.js.
 *
 * Apps Script has no module system, so there is nothing to import. Instead we
 * scan src/Analytics.js for its top-level declarations, keep the pure compute
 * functions, inject the constants from src/Config.js, and eval the lot in one
 * scope. Ugly, but it needs no build step and it tests the shipped file rather
 * than a copy of it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// ===========================================================================
// Loader: pull the pure functions out of the .js sources
// ===========================================================================

/** The functions that take plain data and return plain data. */
const PURE_FUNCTIONS = [
  'key_',
  'round2_',
  'stdev_',
  'computeRoundResults_',
  'computeGuessScores_',
  'computeLeaderboard_',
  'computeFanMatrix_',
  'computeGenreStats_',
  'computeAwards_',
  'computeSanityCheck_',
  'formatSanityCheck_',
  'truthy_',
  'penalisedSet_',
  'seasonMap_',
  'seasonOf_',
  'seasonsOf_',
  'latestSeason_',
  'filterSeason_',
  'seasonAwards_',
];

/** The Config.gs constants those functions close over. */
const CONSTANTS = ['WEIGHTS', 'GUESS_SCORING', 'GUESS_POINTS_CAP', 'NO_IDEA', 'DEFAULT_SEASON'];

/** Anything from these APIs in an extracted function means it isn't pure. */
const IMPURE_MARKERS = [
  'SpreadsheetApp', 'PropertiesService', 'CacheService', 'UrlFetchApp',
  'FormApp', 'ScriptApp', 'Logger', 'Utilities',
  'readTable_', 'writeTable_', 'sheet_', 'ss_', 'toast_',
];

function skipStringAt(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  throw new Error('unterminated string literal at offset ' + i);
}

/** Advances past a comment if one starts at i, otherwise returns -1. */
function skipCommentAt(src, i) {
  if (src[i] !== '/') return -1;
  if (src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end === -1 ? src.length : end + 1;
  }
  if (src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end === -1 ? src.length : end + 2;
  }
  return -1;
}

/** Index just past the `}` that closes the block opening at openIdx. */
function blockEnd(src, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < src.length) {
    const skipped = skipCommentAt(src, i);
    if (skipped !== -1) { i = skipped; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipStringAt(src, i); continue; }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  throw new Error('unbalanced braces from offset ' + openIdx);
}

/** Index just past the `;` that ends the statement starting at start. */
function statementEnd(src, start) {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const skipped = skipCommentAt(src, i);
    if (skipped !== -1) { i = skipped; continue; }
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipStringAt(src, i); continue; }
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return i + 1;
    i += 1;
  }
  throw new Error('unterminated statement from offset ' + start);
}

/**
 * Collects top-level `function name() {}` and `const NAME = ...;` declarations.
 * Comment- and string-aware; the sources contain no regex literals or template
 * literals, so it doesn't try to handle those.
 */
function scanTopLevel(src) {
  const functions = new Map();
  const consts = new Map();
  let depth = 0;
  let i = 0;

  while (i < src.length) {
    const skipped = skipCommentAt(src, i);
    if (skipped !== -1) { i = skipped; continue; }

    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipStringAt(src, i); continue; }
    if (c === '{' || c === '(' || c === '[') { depth += 1; i += 1; continue; }
    if (c === '}' || c === ')' || c === ']') { depth -= 1; i += 1; continue; }

    const atWordStart = i === 0 || !/[A-Za-z0-9_$.]/.test(src[i - 1]);
    if (depth === 0 && atWordStart) {
      const rest = src.slice(i);
      const fn = /^function\s+([A-Za-z0-9_$]+)\s*\(/.exec(rest);
      if (fn) {
        const end = blockEnd(src, src.indexOf('{', i));
        functions.set(fn[1], src.slice(i, end));
        i = end;
        continue;
      }
      const cn = /^const\s+([A-Za-z0-9_$]+)\s*=/.exec(rest);
      if (cn) {
        const end = statementEnd(src, i);
        consts.set(cn[1], src.slice(i, end));
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return { functions, consts };
}

/**
 * Returns the pure analytics functions plus the constants they use.
 * `overrides` replaces a Config constant (used to exercise GUESS_SCORING).
 */
function loadAnalytics(overrides = {}) {
  const analytics = scanTopLevel(readFileSync(join(ROOT, 'src/Analytics.js'), 'utf8'));
  const config = scanTopLevel(readFileSync(join(ROOT, 'src/Config.js'), 'utf8'));

  const parts = ["'use strict';"];

  for (const name of CONSTANTS) {
    if (Object.hasOwn(overrides, name)) {
      parts.push('const ' + name + ' = ' + JSON.stringify(overrides[name]) + ';');
      continue;
    }
    const decl = config.consts.get(name);
    if (!decl) throw new Error('src/Config.js no longer declares const ' + name);
    parts.push(decl);
  }

  for (const name of PURE_FUNCTIONS) {
    const decl = analytics.functions.get(name);
    if (!decl) throw new Error('src/Analytics.js no longer declares function ' + name);
    const impure = IMPURE_MARKERS.filter((m) => new RegExp('\\b' + m + '\\b').test(decl));
    if (impure.length) {
      throw new Error(name + ' is no longer pure — it references ' + impure.join(', '));
    }
    parts.push(decl);
  }

  parts.push('return { ' + PURE_FUNCTIONS.concat(CONSTANTS).join(', ') + ' };');
  // eslint-disable-next-line no-new-func
  return new Function(parts.join('\n\n'))();
}

const A = loadAnalytics();
const NO_IDEA = A.NO_IDEA;
const WEIGHTS = A.WEIGHTS;
const DEFAULT_SEASON = A.DEFAULT_SEASON;

// What a round is worth, derived so retuning WEIGHTS doesn't need a test edit.
const FULL_ROUND = (WEIGHTS.song + WEIGHTS.pop + WEIGHTS.guess) * 100;
const NO_GUESS_ROUND = (WEIGHTS.song + WEIGHTS.pop) * 100;
const GUESS_ONLY_ROUND = WEIGHTS.guess * 100;

/** The whole derived-table chain, exactly as recomputeAll() orders it. */
function recompute(data, api = A) {
  const results = api.computeRoundResults_(data);
  const guessScores = api.computeGuessScores_(data);
  const leaderboard = api.computeLeaderboard_(data, results, guessScores);
  const fans = api.computeFanMatrix_(data);
  const genres = api.computeGenreStats_(data, results);
  const awards = api.computeAwards_(data, results, guessScores);
  return { results, guessScores, leaderboard, fans, genres, awards };
}

// ===========================================================================
// Fixture generator
// ===========================================================================

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds a synthetic league in the exact shape loadAll_() hands to analytics:
 * {votes, submissions, guesses, tracks}, already string/number coerced.
 *
 * Everything is driven by a seeded PRNG, so a failure is reproducible from the
 * options alone. Options taking a per-round array: submissionsPerPlayer,
 * guessParticipation, abstainRate.
 */
function makeLeague(options = {}) {
  const o = {
    players: 4,               // count, or an array of names
    rounds: 2,                // ignored when `seasons` is given
    seasons: null,            // e.g. [2, 3] = season 1 has 2 rounds, season 2 has 3
    submissionsPerPlayer: 1,
    pointsPool: 5,            // points each voter distributes per round
    maxPerSong: 3,
    voterParticipation: 1,    // fraction of players who vote
    guessParticipation: 1,    // fraction of players who fill in the form
    abstainRate: 0,           // fraction of guesses answered "No idea"
    guessAccuracy: 0.5,       // chance a non-abstained guess is right
    untaggedEvery: 0,         // every Nth track gets no genres (0 = never)
    seed: 1,
    ...options,
  };

  const rand = mulberry32(o.seed);
  const pick = (xs) => xs[Math.floor(rand() * xs.length)];
  const shuffled = (xs) => {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const perRound = (v, i) => (Array.isArray(v) ? v[i] : v);

  const names = Array.isArray(o.players)
    ? o.players.slice()
    : Array.from({ length: o.players }, (_, i) => 'P' + String(i + 1).padStart(2, '0'));
  if (names.length < 3) throw new Error('makeLeague needs at least 3 players');

  const GENRE_POOL = ['indie rock', 'synthpop', 'jazz', 'hip hop', 'indie rock; jazz'];

  // round_id stays globally sequential across seasons, matching production.
  const roundsPerSeason = Array.isArray(o.seasons) ? o.seasons : [o.rounds];
  const seasonByRound = [];
  roundsPerSeason.forEach((count, i) => {
    for (let n = 0; n < count; n += 1) seasonByRound.push(i + 1);
  });

  const tracks = [];
  const submissions = [];
  const votes = [];
  const guesses = [];
  const roundRows = [];

  for (let r = 0; r < seasonByRound.length; r += 1) {
    const roundId = 'R' + String(r + 1).padStart(2, '0');
    roundRows.push({ round_id: roundId, season: seasonByRound[r] });
    const subsPer = perRound(o.submissionsPerPlayer, r);
    const roundTracks = [];
    const submitterOf = {};
    let position = 0;

    for (const name of names) {
      for (let k = 0; k < subsPer; k += 1) {
        position += 1;
        const trackId = roundId + 'T' + String(position).padStart(2, '0');
        const untagged = o.untaggedEvery > 0 && position % o.untaggedEvery === 0;
        const track = {
          round_id: roundId,
          track_id: trackId,
          position,
          title: 'Song ' + position,
          artist: 'Artist ' + position,
          genres: untagged ? '' : GENRE_POOL[position % GENRE_POOL.length],
          release_year: '2020',
          popularity: 40 + (position % 40),
        };
        tracks.push(track);
        roundTracks.push(track);
        submissions.push({ round_id: roundId, track_id: trackId, submitter: name,
          did_not_vote: false });
        submitterOf[trackId] = name;
      }
    }

    // --- voting: each voter spends their whole pool on other people's songs
    const voterCount = Math.max(2, Math.round(names.length * o.voterParticipation));
    const voters = shuffled(names).slice(0, voterCount);
    // Music League zeroes the song of anyone who did not vote. The results
    // page states it explicitly, so the fixture records it rather than
    // leaving it to be inferred.
    const votedThisRound = new Set(voters);
    for (const row of submissions) {
      if (row.round_id === roundId) row.did_not_vote = !votedThisRound.has(row.submitter);
    }
    for (const voter of voters) {
      const eligible = roundTracks.filter((t) => submitterOf[t.track_id] !== voter);
      if (!eligible.length) continue;
      const given = new Map();
      let remaining = o.pointsPool;
      while (remaining > 0) {
        const t = pick(eligible);
        const amount = Math.min(remaining, 1 + Math.floor(rand() * o.maxPerSong));
        given.set(t.track_id, (given.get(t.track_id) || 0) + amount);
        remaining -= amount;
      }
      for (const [trackId, points] of given) {
        votes.push({ round_id: roundId, track_id: trackId, voter, points, comment: '' });
      }
    }

    // --- guessing
    const guessFraction = perRound(o.guessParticipation, r);
    const abstain = perRound(o.abstainRate, r);
    const guesserCount = Math.round(names.length * guessFraction);
    const guessers = shuffled(names).slice(0, guesserCount);
    for (const guesser of guessers) {
      for (const t of roundTracks) {
        const actual = submitterOf[t.track_id];
        let guessed;
        if (actual === guesser) {
          // The form shows you your own song too, and people do answer it.
          guessed = rand() < 0.5 ? guesser : pick(names.filter((n) => n !== guesser));
        } else if (rand() < abstain) {
          guessed = NO_IDEA;
        } else if (rand() < o.guessAccuracy) {
          guessed = actual;
        } else {
          guessed = pick(names.filter((n) => n !== actual));
        }
        guesses.push({ round_id: roundId, track_id: t.track_id, guesser, guessed });
      }
    }
  }

  return { votes, submissions, guesses, tracks, rounds: roundRows };
}

/** The matrix the invariants are checked across. */
const FIXTURES = [
  { name: '4 players, 2 rounds, 1 submission each', opts: { players: 4, rounds: 2, seed: 11 } },
  { name: '3 players, 1 round (smallest league)', opts: { players: 3, rounds: 1, seed: 22 } },
  { name: '10 players, 3 rounds, 30% abstention', opts: { players: 10, rounds: 3, abstainRate: 0.3, seed: 33 } },
  { name: '6 players, 2 rounds, 2 submissions per player', opts: { players: 6, rounds: 2, submissionsPerPlayer: 2, seed: 44 } },
  { name: '8 players, 2 rounds, 1 then 3 submissions per player', opts: { players: 8, rounds: 2, submissionsPerPlayer: [1, 3], seed: 55 } },
  { name: '7 players, 2 rounds, 90% abstention, partial turnout', opts: { players: 7, rounds: 2, abstainRate: 0.9, guessParticipation: 0.6, voterParticipation: 0.8, guessAccuracy: 0.4, seed: 66 } },
  { name: '5 players, 4 rounds, big pool, untagged tracks', opts: { players: 5, rounds: 4, pointsPool: 12, maxPerSong: 5, untaggedEvery: 3, seed: 77 } },
  { name: '12 players, 2 rounds, near-perfect guessing', opts: { players: 12, rounds: 2, guessAccuracy: 0.95, seed: 88 } },
  { name: '6 players, 2 seasons of 2 rounds', opts: { players: 6, seasons: [2, 2], guessAccuracy: 0.8, seed: 99 } },
  { name: '9 players, 3 uneven seasons, mixed abstention', opts: { players: 9, seasons: [1, 3, 2], abstainRate: [0, 0.2, 0.5, 0, 0.4, 0.1], guessAccuracy: 0.7, seed: 111 } },
  { name: '8 players, 2 rounds, a third never vote (penalties)', opts: { players: 8, rounds: 2, voterParticipation: 0.6, guessAccuracy: 0.8, seed: 222 } },
];

// ===========================================================================
// Independent re-derivations (deliberately not reusing production code)
// ===========================================================================

const k = (roundId, trackId) => roundId + '|' + trackId;
const r2 = (n) => Math.round(n * 100) / 100;

function popStdev(xs) {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
}

function submitterMap(d) {
  const m = {};
  for (const s of d.submissions) m[k(s.round_id, s.track_id)] = s.submitter;
  return m;
}

function roundIdsOf(d) {
  return [...new Set(d.tracks.map((t) => t.round_id))].sort();
}

/** round_id -> season, derived straight from the fixture's Rounds rows. */
function seasonsOfFixture(d) {
  const m = {};
  for (const r of d.rounds || []) m[r.round_id] = Number(r.season) || DEFAULT_SEASON;
  return m;
}

function seasonList(d) {
  const m = seasonsOfFixture(d);
  return [...new Set(roundIdsOf(d).map((r) => m[r] || DEFAULT_SEASON))].sort((a, b) => b - a);
}

function roundIdsInSeason(d, season) {
  const m = seasonsOfFixture(d);
  return roundIdsOf(d).filter((r) => (m[r] || DEFAULT_SEASON) === season);
}

/** Voters per round, in first-appearance order — same order the source uses. */
function roundVotersOf(d) {
  const m = {};
  for (const v of d.votes) {
    if (!m[v.round_id]) m[v.round_id] = [];
    if (!m[v.round_id].includes(v.voter)) m[v.round_id].push(v.voter);
  }
  return m;
}

/**
 * Per-song expectations. `includeSubmitter` exists only so a test can prove
 * that excluding the submitter actually changes the answer.
 */
function expectedPerTrack(d, includeSubmitter = false) {
  const submitterOf = submitterMap(d);
  const roundVoters = roundVotersOf(d);

  const byTrack = new Map();
  for (const v of d.votes) {
    const key = k(v.round_id, v.track_id);
    if (!byTrack.has(key)) byTrack.set(key, new Map());
    const m = byTrack.get(key);
    m.set(v.voter, (m.get(v.voter) || 0) + v.points);
  }

  const out = new Map();
  for (const [key, pointsByVoter] of byTrack) {
    const [roundId, trackId] = key.split('|');
    const submitter = submitterOf[key] || '';
    const electorate = (roundVoters[roundId] || [])
      .filter((name) => includeSubmitter || name !== submitter);
    const vector = electorate.map((name) => pointsByVoter.get(name) || 0);
    const total = vector.reduce((a, b) => a + b, 0);
    const voters = vector.filter((p) => p > 0).length;
    out.set(key, {
      round_id: roundId,
      track_id: trackId,
      submitter,
      electorate,
      total_points: total,
      voters,
      avg_per_voter: voters ? r2(total / voters) : 0,
      spread: r2(popStdev(vector)),
    });
  }
  return out;
}

/** Guesses that should be scored at all: known submitter, not self, not "No idea". */
function scoredGuesses(d) {
  const submitterOf = submitterMap(d);
  return d.guesses.filter((g) => {
    const actual = submitterOf[k(g.round_id, g.track_id)];
    return Boolean(actual) && actual !== g.guesser && g.guessed !== NO_IDEA;
  });
}

function penalisedKeys(d) {
  return new Set((d.submissions || []).filter((s) => s.did_not_vote)
    .map((s) => k(s.round_id, s.track_id)));
}

function roundHasVotes(d, roundId) {
  const submitterOf = submitterMap(d);
  const penalised = penalisedKeys(d);
  return d.votes.some(
    (v) => v.round_id === roundId
      && v.points > 0
      && submitterOf[k(v.round_id, v.track_id)] !== v.voter
      && !penalised.has(k(v.round_id, v.track_id)),
  );
}

/**
 * What sum(Leaderboard.combined) should be, worked out from the raw tables:
 * song + pop only pay out if the round scored, guess only if somebody was
 * right. Deliberately not calling computeSanityCheck_ — that's what's on trial.
 */
function expectedLeaderboardTotal(d, season) {
  const ids = season === undefined ? roundIdsOf(d) : roundIdsInSeason(d, season);
  return ids.reduce((total, r) => {
    const scoring = roundHasVotes(d, r) ? (WEIGHTS.song + WEIGHTS.pop) * 100 : 0;
    const guessing = roundHasCorrectGuess(d, r) ? WEIGHTS.guess * 100 : 0;
    return total + scoring + guessing;
  }, 0);
}

function roundHasCorrectGuess(d, roundId) {
  const submitterOf = submitterMap(d);
  return scoredGuesses(d).some(
    (g) => g.round_id === roundId && g.guessed === submitterOf[k(g.round_id, g.track_id)],
  );
}

// ===========================================================================
// Fixture sanity — if these fail, every invariant below is meaningless
// ===========================================================================

test('fixture generator produces well-formed leagues', () => {
  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const submitterOf = submitterMap(d);
    const trackKeys = new Set(d.tracks.map((t) => k(t.round_id, t.track_id)));

    assert.ok(d.tracks.length > 0, f.name + ': no tracks');
    assert.ok(d.votes.length > 0, f.name + ': no votes');
    assert.deepEqual(
      d.rounds.map((r) => r.round_id),
      roundIdsOf(d),
      f.name + ': Rounds rows do not match the rounds that have tracks',
    );
    for (const r of d.rounds) assert.ok(r.season >= 1, f.name + ': bad season');
    for (const v of d.votes) {
      assert.ok(trackKeys.has(k(v.round_id, v.track_id)), f.name + ': vote on unknown track');
      assert.notEqual(submitterOf[k(v.round_id, v.track_id)], v.voter, f.name + ': self-vote leaked into fixture');
      assert.ok(v.points > 0, f.name + ': zero-point vote row');
    }
    for (const s of d.submissions) {
      assert.ok(trackKeys.has(k(s.round_id, s.track_id)), f.name + ': submission of unknown track');
    }
  }
});

test('fixture matrix exercises the dimensions it claims to', () => {
  const seen = { multiSub: false, abstain: false, selfGuess: false, untagged: false, noGuesses: false };
  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const submitterOf = submitterMap(d);
    const perRoundPerPlayer = {};
    for (const s of d.submissions) {
      const key = s.round_id + '|' + s.submitter;
      perRoundPerPlayer[key] = (perRoundPerPlayer[key] || 0) + 1;
      if (perRoundPerPlayer[key] > 1) seen.multiSub = true;
    }
    if (d.guesses.some((g) => g.guessed === NO_IDEA)) seen.abstain = true;
    if (d.guesses.some((g) => submitterOf[k(g.round_id, g.track_id)] === g.guesser)) seen.selfGuess = true;
    if (d.tracks.some((t) => t.genres === '')) seen.untagged = true;
  }
  seen.noGuesses = makeLeague({ players: 5, rounds: 1, guessParticipation: 0, seed: 5 }).guesses.length === 0;

  assert.deepEqual(seen, { multiSub: true, abstain: true, selfGuess: true, untagged: true, noGuesses: true });

  const seasonCounts = new Set(FIXTURES.map((f) => seasonList(makeLeague(f.opts)).length));
  assert.ok(seasonCounts.has(1), 'no single-season fixture');
  assert.ok([...seasonCounts].some((n) => n > 1), 'no multi-season fixture');
  assert.ok(seasonCounts.has(3), 'no three-season fixture');

  const counts = new Set(FIXTURES.map((f) => (Array.isArray(f.opts.players) ? f.opts.players.length : f.opts.players)));
  assert.ok(counts.size >= 5, 'player count should vary across fixtures, saw ' + [...counts].join(','));
});

// ===========================================================================
// Invariant 1
// ===========================================================================

test('invariant 1: RoundResults total_points per round == Votes points per round', () => {
  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const results = A.computeRoundResults_(d);

    const fromVotes = {};
    for (const v of d.votes) fromVotes[v.round_id] = (fromVotes[v.round_id] || 0) + v.points;

    const fromResults = {};
    for (const r of results) fromResults[r.round_id] = (fromResults[r.round_id] || 0) + r.total_points;

    assert.deepEqual(fromResults, fromVotes, f.name);
  }
});

// ===========================================================================
// Invariant 2
// ===========================================================================

test('invariant 2: sum(Leaderboard.combined) == 100 x rounds played', () => {
  let checked = 0;

  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const rounds = roundIdsOf(d);

    // The identity only holds when all three components exist in every round:
    // a round with no correct guesses contributes WEIGHTS.guess x 100 less.
    // Rounds like that are invariant 6's job.
    const complete = rounds.every((r) => roundHasVotes(d, r) && roundHasCorrectGuess(d, r));
    if (!complete) continue;
    checked += 1;

    const { leaderboard } = recompute(d);

    // Per season now: each season's rows are worth 100 per round in it.
    for (const season of seasonList(d)) {
      const rows = leaderboard.filter((p) => p.season === season);
      const total = rows.reduce((a, p) => a + p.combined, 0);
      const want = 100 * roundIdsInSeason(d, season).length;
      // combined is rounded to 2dp per player, so allow half a cent each.
      assert.ok(
        Math.abs(total - want) <= rows.length * 0.005 + 1e-9,
        f.name + ' season ' + season + ': expected ' + want + ', got ' + total.toFixed(4),
      );
    }

    // And the whole table still reconciles across seasons.
    const grand = leaderboard.reduce((a, p) => a + p.combined, 0);
    assert.ok(
      Math.abs(grand - 100 * rounds.length) <= leaderboard.length * 0.005 + 1e-9,
      f.name + ': grand total ' + grand.toFixed(4),
    );
  }

  assert.ok(checked >= 5, 'only ' + checked + ' fixtures had all three components in every round');
});

// ===========================================================================
// sanityCheck() — the generalisation of invariant 2
// ===========================================================================

test('sanityCheck agrees with the raw tables, season by season', () => {
  let sawIncompleteRound = false;
  let sawMultiSeason = false;

  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const { leaderboard } = recompute(d);
    const seasons = seasonList(d);
    if (seasons.length > 1) sawMultiSeason = true;

    for (const season of seasons) {
      const check = A.computeSanityCheck_(d, leaderboard, season);
      const label = f.name + ' season ' + season;

      assert.equal(check.season, season, label + ': season');
      assert.equal(check.expected, r2(expectedLeaderboardTotal(d, season)), label + ': expected total');
      assert.equal(check.rounds.length, roundIdsInSeason(d, season).length, label + ': round count');
      assert.equal(
        check.players,
        leaderboard.filter((p) => p.season === season).length,
        label + ': player count is scoped to the season',
      );
      assert.ok(check.ok, label + ': reported FAIL on a clean league — ' + JSON.stringify(check));

      for (const r of check.rounds) {
        assert.equal(r.scoring, roundHasVotes(d, r.round_id), label + ' ' + r.round_id + ': scoring');
        assert.equal(r.correct_guesses > 0, roundHasCorrectGuess(d, r.round_id), label + ' ' + r.round_id + ': guesses');
        assert.ok([0, GUESS_ONLY_ROUND, NO_GUESS_ROUND, FULL_ROUND].includes(r.expected),
          label + ' ' + r.round_id + ': odd expected ' + r.expected);
        if (r.expected !== 100) sawIncompleteRound = true;
      }
    }

    // No season argument means the latest season.
    assert.deepEqual(
      A.computeSanityCheck_(d, leaderboard),
      A.computeSanityCheck_(d, leaderboard, seasons[0]),
      f.name + ': default season is not the latest',
    );
  }

  assert.ok(sawIncompleteRound, 'no fixture exercised a round worth less than 100');
  assert.ok(sawMultiSeason, 'no fixture exercised more than one season');
});

test('sanityCheck ignores rounds and players from other seasons', () => {
  const d = makeLeague({ players: 6, seasons: [3, 1], guessAccuracy: 0.9, seed: 606 });
  const { leaderboard } = recompute(d);

  const s1 = A.computeSanityCheck_(d, leaderboard, 1);
  const s2 = A.computeSanityCheck_(d, leaderboard, 2);

  assert.equal(s1.expected, 300, 'season 1 has three rounds');
  assert.equal(s2.expected, 100, 'season 2 has one');
  assert.deepEqual(s1.rounds.map((r) => r.round_id), ['R01', 'R02', 'R03']);
  assert.deepEqual(s2.rounds.map((r) => r.round_id), ['R04']);
  assert.ok(s1.ok && s2.ok);

  // A player's season-1 standing must not leak into the season-2 total.
  const s2Rows = leaderboard.filter((p) => p.season === 2);
  assert.equal(s2.players, s2Rows.length);
  assert.ok(s2Rows.length > 0 && s2Rows.length < leaderboard.length);
});

test('sanityCheck catches a Votes row whose track never got a Submissions row', () => {
  const d = makeLeague({ players: 6, rounds: 2, guessAccuracy: 0.9, seed: 303 });
  const clean = A.computeSanityCheck_(d, recompute(d).leaderboard);
  assert.ok(clean.ok, 'control league should pass');
  assert.equal(clean.expected, 200);

  // Drop one submission. Its votes still count toward the round total but now
  // credit nobody, so the leaderboard comes up short — exactly the "something
  // didn't ingest" case this check exists for.
  const broken = structuredClone(d);
  const dropped = broken.submissions.shift();
  assert.ok(broken.votes.some((v) => v.track_id === dropped.track_id), 'dropped track had no votes; pick another');

  const check = A.computeSanityCheck_(broken, recompute(broken).leaderboard);
  assert.equal(check.ok, false, 'should have failed: ' + JSON.stringify(check));
  assert.ok(check.delta < 0, 'should be short, not over — delta ' + check.delta);
  assert.equal(check.expected, 200, 'raw tables still imply two full rounds');

  const text = A.formatSanityCheck_(check);
  assert.match(text, /^Leaderboard sanity check, season 1: FAIL/);
  assert.match(text, /Validate ingested results/);
});

test('sanityCheck does not count a self-vote as a scoring round', () => {
  const d = {
    tracks: [
      { round_id: 'R01', track_id: 'T1', position: 1, title: 'One', artist: 'X', genres: '' },
      { round_id: 'R02', track_id: 'T2', position: 1, title: 'Two', artist: 'Y', genres: '' },
    ],
    submissions: [
      { round_id: 'R01', track_id: 'T1', submitter: 'A' },
      { round_id: 'R02', track_id: 'T2', submitter: 'A' },
    ],
    votes: [
      { round_id: 'R01', track_id: 'T1', voter: 'B', points: 3, comment: '' },
      { round_id: 'R02', track_id: 'T2', voter: 'A', points: 3, comment: '' }, // self-vote only
    ],
    guesses: [],
  };

  const check = A.computeSanityCheck_(d, recompute(d).leaderboard);
  assert.deepEqual(
    check.rounds.map((r) => [r.round_id, r.scoring, r.expected]),
    [['R01', true, NO_GUESS_ROUND], ['R02', false, 0]],
  );
  assert.equal(check.expected, NO_GUESS_ROUND);
  assert.ok(check.ok, 'R02 contributes nothing, so the total still reconciles');
});

test('sanityCheck tolerance is exactly players x 0.005', () => {
  const d = makeLeague({ players: 4, rounds: 1, guessAccuracy: 0.9, seed: 404 });
  assert.equal(A.computeSanityCheck_(d, recompute(d).leaderboard).expected, 100);

  const board = (total) => [
    { combined: total - 30 }, { combined: 10 }, { combined: 10 }, { combined: 10 },
  ];
  assert.equal(A.computeSanityCheck_(d, board(100)).tolerance, 0.02);
  assert.equal(A.computeSanityCheck_(d, board(100)).ok, true, 'exact');
  assert.equal(A.computeSanityCheck_(d, board(100.02)).ok, true, 'at the tolerance');
  assert.equal(A.computeSanityCheck_(d, board(99.98)).ok, true, 'at the tolerance, short');
  assert.equal(A.computeSanityCheck_(d, board(100.03)).ok, false, 'past the tolerance');
  assert.equal(A.computeSanityCheck_(d, board(99.97)).ok, false, 'past the tolerance, short');
});

test('formatSanityCheck_ renders a line per round', () => {
  const d = makeLeague({ players: 5, rounds: 2, guessParticipation: [1, 0], guessAccuracy: 0.9, seed: 505 });
  const text = A.formatSanityCheck_(A.computeSanityCheck_(d, recompute(d).leaderboard));

  assert.match(text, /^Leaderboard sanity check, season 1: PASS/);
  assert.match(text, new RegExp('R01: expected ' + FULL_ROUND + ' \\(votes, \\d+ correct guesses\\)'));
  assert.match(text, new RegExp('R02: expected ' + NO_GUESS_ROUND + ' \\(votes, no correct guesses\\)'));
  assert.match(text, new RegExp('Expected ' + (FULL_ROUND + NO_GUESS_ROUND).toFixed(2) + ', found'));
});

// ===========================================================================
// The did-not-vote penalty
// ===========================================================================

/**
 * Hand-built so every number is checkable by eye.
 *
 *   A submitted T1 and DID NOT VOTE      -> penalised
 *   B submitted T2 and voted             -> normal
 *   C submitted T3 and voted ALL ZEROS   -> voted, so NOT penalised
 *
 * The last one is the whole reason the flag is recorded rather than inferred
 * from an absence of points.
 */
function penaltyFixture() {
  const track = (id) => ({ round_id: 'R01', track_id: id, position: 1, title: id, artist: 'X', genres: '' });
  return {
    tracks: [track('T1'), track('T2'), track('T3')],
    submissions: [
      { round_id: 'R01', track_id: 'T1', submitter: 'A', did_not_vote: true },
      { round_id: 'R01', track_id: 'T2', submitter: 'B', did_not_vote: false },
      { round_id: 'R01', track_id: 'T3', submitter: 'C', did_not_vote: false },
    ],
    votes: [
      { round_id: 'R01', track_id: 'T1', voter: 'B', points: 3, comment: '' },
      { round_id: 'R01', track_id: 'T3', voter: 'B', points: 2, comment: '' },
      { round_id: 'R01', track_id: 'T1', voter: 'C', points: 0, comment: '' },
      { round_id: 'R01', track_id: 'T2', voter: 'C', points: 0, comment: '' },
    ],
    guesses: [],
    rounds: [{ round_id: 'R01', season: 1 }],
  };
}

test('the behaviour awards appear and name the right person', () => {
  // Four songs a round so "bottom half" is two of them, not one.
  // Every round finishes a > b > c > d.
  //   A only ever funds the winner        -> Kingmaker
  //   C spends everything on c and d      -> Contrarian
  //   A is the only one who leaves notes  -> Chatterbox
  const d = { tracks: [], submissions: [], votes: [], guesses: [], rounds: [] };
  const who = { a: 'P', b: 'Q', c: 'R', d: 'S' };

  for (const rid of ['R01', 'R02', 'R03']) {
    d.rounds.push({ round_id: rid, season: 1 });
    for (const t of ['a', 'b', 'c', 'd']) {
      const id = rid + t;
      d.tracks.push({ round_id: rid, track_id: id, position: 1, title: id, artist: 'X', genres: '' });
      d.submissions.push({ round_id: rid, track_id: id, submitter: who[t], did_not_vote: false });
    }
    d.votes.push({ round_id: rid, track_id: rid + 'a', voter: 'A', points: 6, comment: 'love this' });
    d.votes.push({ round_id: rid, track_id: rid + 'b', voter: 'B', points: 4, comment: '' });
    d.votes.push({ round_id: rid, track_id: rid + 'c', voter: 'C', points: 3, comment: '' });
    d.votes.push({ round_id: rid, track_id: rid + 'd', voter: 'C', points: 2, comment: '' });
  }

  const byName = {};
  for (const a of recompute(d).awards) byName[a[1]] = a;

  assert.equal(byName['Kingmaker'][2], 'A');
  assert.match(byName['Kingmaker'][3], /3 of 3 rounds/);

  assert.equal(byName['Contrarian'][2], 'C');
  assert.match(byName['Contrarian'][3], /100% of their points/);

  assert.equal(byName['Chatterbox'][2], 'A');
  assert.equal(byName['Chatterbox'][4], 3, 'blank comments must not count');
});

test('behaviour awards stay quiet until there is enough data', () => {
  // One round is not a pattern. Nothing that claims a habit should appear.
  const d = penaltyFixture();
  const names = recompute(d).awards.map((a) => a[1]);
  for (const n of ['Kingmaker', 'Contrarian', 'Most consistent', 'One hit wonder']) {
    assert.ok(!names.includes(n), n + ' fired on a single round');
  }
});

test('a penalised song scores 0 on the leaderboard but keeps its real result', () => {
  const d = penaltyFixture();
  const { results, leaderboard } = recompute(d);

  // RoundResults is descriptive: the song really did get 3 points.
  const t1 = results.find((r) => r.track_id === 'T1');
  assert.equal(t1.total_points, 3, 'RoundResults must not hide the real result');
  assert.equal(t1.voters, 1);

  // The Leaderboard is competitive: it contributes nothing.
  const a = leaderboard.find((p) => p.player === 'A');
  assert.ok(a, 'a penalised player must still appear on the leaderboard');
  assert.equal(a.song_points, 0, 'song points are zeroed');
  assert.equal(a.popularity_points, 0, 'breadth is zeroed with it');
  assert.equal(a.combined, 0);
  assert.equal(a.rounds_played, 1, 'they still played the round');
});

test('a submitter whose song got no votes still appears, on 0', () => {
  // Found on real round-4 data: marimar submitted, voted, and the song drew
  // nothing. computeRoundResults_ emits no row for a track with no votes, so
  // the submitter used to drop off the leaderboard entirely.
  const d = penaltyFixture();
  d.tracks.push({ round_id: 'R01', track_id: 'T4', position: 4, title: 'T4', artist: 'X', genres: '' });
  d.submissions.push({ round_id: 'R01', track_id: 'T4', submitter: 'D', did_not_vote: false });
  d.votes.push({ round_id: 'R01', track_id: 'T1', voter: 'D', points: 1, comment: '' });

  const { results, leaderboard } = recompute(d);
  assert.ok(!results.some((r) => r.track_id === 'T4'), 'no RoundResults row, as designed');

  const row = leaderboard.find((p) => p.player === 'D');
  assert.ok(row, 'submitter with an unvoted song vanished from the leaderboard');
  assert.equal(row.song_points, 0);
  assert.equal(row.popularity_points, 0);
  assert.equal(row.combined, 0);
  assert.equal(row.rounds_played, 1);
});

test('voting all zeros is not the same as not voting', () => {
  const d = penaltyFixture();
  const { leaderboard } = recompute(d);

  const c = leaderboard.find((p) => p.player === 'C');
  assert.equal(c.song_points, 2, 'C voted, so C is not penalised');
  assert.ok(c.combined > 0);
});

test('the round still adds up to 100 with a penalty in it', () => {
  // The penalised song has to leave the denominator too, or every remaining
  // share is computed against a total that includes points nobody can win.
  const d = penaltyFixture();
  const { leaderboard } = recompute(d);
  const total = leaderboard.reduce((a, p) => a + p.combined, 0);
  // No guesses in this fixture, so it is worth song+pop only.
  assert.ok(Math.abs(total - NO_GUESS_ROUND) < 1e-9,
    'expected ' + NO_GUESS_ROUND + ', got ' + total);

  const check = A.computeSanityCheck_(d, leaderboard);
  assert.ok(check.ok, JSON.stringify(check));
  assert.equal(check.expected, NO_GUESS_ROUND);
});

test('FanMatrix groups by voter, biggest first, and awards ignore that order', () => {
  const d = makeLeague({ players: 6, rounds: 3, guessAccuracy: 0.8, seed: 1313 });
  const { fans, awards } = recompute(d);

  for (let i = 1; i < fans.length; i += 1) {
    const prev = fans[i - 1];
    const row = fans[i];
    if (prev.voter === row.voter) {
      assert.ok(prev.points_given >= row.points_given,
        'within a voter, points should descend: ' + prev.voter);
    } else {
      assert.ok(prev.voter.localeCompare(row.voter) < 0, 'voters should be A to Z');
    }
  }

  // The award must name the strongest affinity, not whoever sorts first.
  const solid = fans.filter((f) => f.shared_rounds >= 2);
  const best = solid.reduce((a, f) => (f.share > a.share ? f : a));
  const row = awards.find((a) => a[1] === 'Biggest fan');
  assert.ok(row, 'Biggest fan award missing');
  assert.equal(row[2], best.voter);
  assert.notEqual(best.voter, solid[0].voter === best.voter ? null : solid[0].voter);
});

test('the penalty does not touch the fan matrix', () => {
  // B genuinely liked A's song. That is a fact about B's taste and it stands
  // whatever Music League did to A's score.
  const d = penaltyFixture();
  const { fans } = recompute(d);
  const bToA = fans.find((f) => f.voter === 'B' && f.submitter === 'A');
  assert.ok(bToA, 'B -> A affinity went missing');
  assert.equal(bToA.points_given, 3);
  assert.equal(bToA.share, 0.6); // 3 of the 5 points B handed out
});

test('penalties are read from the flag, never inferred', () => {
  const d = penaltyFixture();
  assert.deepEqual(Object.keys(A.penalisedSet_(d)), ['R01|T1']);

  // Same data, flag cleared: A now scores normally even though A still cast
  // no votes. The flag is the only input.
  const unflagged = structuredClone(d);
  unflagged.submissions[0].did_not_vote = false;
  const a = recompute(unflagged).leaderboard.find((p) => p.player === 'A');
  assert.ok(a.song_points > 0, 'clearing the flag must un-penalise');
});

test('truthy_ accepts what a spreadsheet actually stores', () => {
  for (const v of [true, 'TRUE', 'true', 'True', 'yes', '1', 1]) {
    assert.equal(A.truthy_(v), true, JSON.stringify(v));
  }
  for (const v of [false, 'FALSE', 'false', '', null, undefined, 0, 'no']) {
    assert.equal(A.truthy_(v), false, JSON.stringify(v));
  }
});

// ===========================================================================
// Seasons
// ===========================================================================

test('Leaderboard is one row per (season, player), latest season first', () => {
  const d = makeLeague({ players: 6, seasons: [2, 3], guessAccuracy: 0.8, seed: 707 });
  const { leaderboard } = recompute(d);

  const keys = leaderboard.map((p) => p.season + '|' + p.player);
  assert.equal(new Set(keys).size, keys.length, 'duplicate (season, player) row');

  const seasons = leaderboard.map((p) => p.season);
  assert.deepEqual(seasons, seasons.slice().sort((a, b) => b - a), 'not sorted latest season first');
  for (const season of new Set(seasons)) {
    const rows = leaderboard.filter((p) => p.season === season).map((p) => p.combined);
    assert.deepEqual(rows, rows.slice().sort((a, b) => b - a), 'season ' + season + ' not sorted by combined');
  }

  // rounds_played counts rounds inside the season, not the whole league.
  for (const p of leaderboard) {
    assert.ok(
      p.rounds_played <= roundIdsInSeason(d, p.season).length,
      p.player + ' played ' + p.rounds_played + ' rounds in a ' + roundIdsInSeason(d, p.season).length + '-round season',
    );
  }

  // Someone who played both seasons appears in both, separately.
  const twice = [...new Set(leaderboard.map((p) => p.player))]
    .filter((n) => leaderboard.filter((p) => p.player === n).length > 1);
  assert.ok(twice.length > 0, 'nobody carried across seasons, so this proves nothing');
});

test('Awards are per season and carry the season in column 1', () => {
  const d = makeLeague({ players: 6, seasons: [2, 2], guessAccuracy: 0.8, seed: 808 });
  const { awards } = recompute(d);

  assert.ok(awards.length > 0);
  assert.deepEqual([...new Set(awards.map((a) => a[0]))].sort(), [1, 2], 'both seasons should appear');

  // The same award title shows up once per season, not once overall.
  const byTitle = {};
  for (const [season, title] of awards) {
    byTitle[title] = byTitle[title] || [];
    byTitle[title].push(season);
  }
  assert.ok(byTitle['Highest scoring song'], 'no headline award');
  assert.deepEqual(byTitle['Highest scoring song'].sort(), [1, 2]);
  for (const [title, seasons] of Object.entries(byTitle)) {
    assert.equal(new Set(seasons).size, seasons.length, title + ' repeats within a season');
  }
});

test('FanMatrix and GenreStats are all-time; Leaderboard and Awards are not', () => {
  // Identical raw data, split into seasons two different ways. Anything
  // season-scoped must react; anything all-time must not.
  const base = makeLeague({ players: 6, rounds: 4, guessAccuracy: 0.8, seed: 909 });
  const oneSeason = { ...base, rounds: base.rounds.map((r) => ({ ...r, season: 1 })) };
  const split = { ...base, rounds: base.rounds.map((r, i) => ({ ...r, season: i < 2 ? 1 : 2 })) };

  const a = recompute(oneSeason);
  const b = recompute(split);

  assert.deepEqual(b.fans, a.fans, 'FanMatrix must not reset on a season boundary');
  assert.deepEqual(b.genres, a.genres, 'GenreStats must not reset on a season boundary');
  assert.deepEqual(b.results, a.results, 'RoundResults is per round, seasons are irrelevant');
  assert.deepEqual(b.guessScores, a.guessScores, 'GuessScores is per round too');

  assert.notDeepEqual(b.leaderboard, a.leaderboard, 'Leaderboard must reset');
  assert.notDeepEqual(b.awards, a.awards, 'Awards must reset');

  // The point of keeping FanMatrix all-time: the sample keeps growing.
  const widest = Math.max(...b.fans.map((f) => f.shared_rounds));
  assert.equal(widest, 4, 'affinity should still be measured across all four rounds');
});

test('data with no Rounds table at all is one season', () => {
  const d = makeLeague({ players: 5, rounds: 2, guessAccuracy: 0.8, seed: 1010 });
  delete d.rounds; // a sheet that predates the season column

  assert.deepEqual(A.seasonsOf_(d), [DEFAULT_SEASON]);
  assert.equal(A.latestSeason_(d), DEFAULT_SEASON);

  const { leaderboard, awards } = recompute(d);
  assert.ok(leaderboard.length > 0);
  assert.ok(leaderboard.every((p) => p.season === DEFAULT_SEASON));
  assert.ok(awards.every((a) => a[0] === DEFAULT_SEASON));

  const check = A.computeSanityCheck_(d, leaderboard);
  assert.equal(check.season, DEFAULT_SEASON);
  assert.ok(check.ok, JSON.stringify(check));
});

test('a blank or junk season cell falls back to season 1', () => {
  const d = makeLeague({ players: 5, rounds: 2, guessAccuracy: 0.8, seed: 1111 });
  d.rounds = [{ round_id: 'R01', season: '' }, { round_id: 'R02', season: 0 }];

  assert.deepEqual(A.seasonsOf_(d), [DEFAULT_SEASON]);
  const { leaderboard } = recompute(d);
  assert.ok(leaderboard.every((p) => p.season === DEFAULT_SEASON));
});

test('seasons read as numbers even when the sheet hands back strings', () => {
  const d = makeLeague({ players: 5, seasons: [1, 1], guessAccuracy: 0.8, seed: 1212 });
  const stringy = { ...d, rounds: d.rounds.map((r) => ({ ...r, season: String(r.season) })) };

  assert.deepEqual(A.seasonsOf_(stringy), [2, 1]);
  assert.deepEqual(recompute(stringy).leaderboard.map((p) => p.season).sort(), 
    recompute(d).leaderboard.map((p) => p.season).sort());
});

// ===========================================================================
// Invariant 3
// ===========================================================================

test('invariant 3: no submitter is in their own song\'s electorate', () => {
  let provedNonVacuous = false;

  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const results = A.computeRoundResults_(d);
    const expected = expectedPerTrack(d, false);
    const withSubmitter = expectedPerTrack(d, true);

    for (const r of results) {
      const key = k(r.round_id, r.track_id);
      const e = expected.get(key);
      assert.ok(e, f.name + ': unexpected result row ' + key);
      assert.ok(!e.electorate.includes(r.submitter), f.name + ': submitter in own electorate');
      assert.equal(r.total_points, e.total_points, f.name + ' ' + key + ' total_points');
      assert.equal(r.voters, e.voters, f.name + ' ' + key + ' voters');
      assert.ok(Math.abs(r.spread - e.spread) < 1e-9, f.name + ' ' + key + ' spread');
      assert.ok(Math.abs(r.avg_per_voter - e.avg_per_voter) < 1e-9, f.name + ' ' + key + ' avg_per_voter');

      // Guard against a vacuous pass: for at least one song, keeping the
      // submitter in the electorate would have produced a different spread.
      if (Math.abs(withSubmitter.get(key).spread - e.spread) > 1e-9) provedNonVacuous = true;
    }
  }

  assert.ok(provedNonVacuous, 'no fixture actually distinguished the two electorates');
});

test('invariant 3: a submitter voting for their own song is discarded', () => {
  // Hand-built: A submits T1 and illegally gives it 3 points. B gives it 2,
  // C gives it none. The electorate is {B, C}, so total is 2 and the spread
  // is the population stdev of [2, 0] = 1.
  const d = {
    tracks: [
      { round_id: 'R01', track_id: 'T1', position: 1, title: 'One', artist: 'X', genres: 'jazz' },
      { round_id: 'R01', track_id: 'T2', position: 2, title: 'Two', artist: 'Y', genres: 'jazz' },
    ],
    submissions: [
      { round_id: 'R01', track_id: 'T1', submitter: 'A' },
      { round_id: 'R01', track_id: 'T2', submitter: 'B' },
    ],
    votes: [
      { round_id: 'R01', track_id: 'T1', voter: 'A', points: 3, comment: '' }, // illegal
      { round_id: 'R01', track_id: 'T1', voter: 'B', points: 2, comment: '' },
      { round_id: 'R01', track_id: 'T2', voter: 'C', points: 4, comment: '' },
    ],
    guesses: [],
  };

  const t1 = A.computeRoundResults_(d).find((r) => r.track_id === 'T1');
  assert.equal(t1.total_points, 2, 'self-vote should not count');
  assert.equal(t1.voters, 1);
  assert.equal(t1.spread, 1, 'spread should be over the 2-person electorate [2, 0]');
});

// ===========================================================================
// Invariant 4
// ===========================================================================

test('invariant 4: GuessScores counts no self-guess and no "No idea"', () => {
  let sawSelfGuess = false;
  let sawAbstention = false;

  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const submitterOf = submitterMap(d);
    const scored = scoredGuesses(d);

    sawSelfGuess ||= d.guesses.some((g) => submitterOf[k(g.round_id, g.track_id)] === g.guesser);
    sawAbstention ||= d.guesses.some((g) => g.guessed === NO_IDEA);

    const expected = new Map();
    for (const g of scored) {
      const key = g.round_id + '|' + g.guesser;
      if (!expected.has(key)) expected.set(key, { eligible: 0, correct: 0 });
      const row = expected.get(key);
      row.eligible += 1;
      if (g.guessed === submitterOf[k(g.round_id, g.track_id)]) row.correct += 1;
    }

    const rows = A.computeGuessScores_(d);
    assert.equal(rows.length, expected.size, f.name + ': wrong number of GuessScores rows');

    for (const row of rows) {
      const e = expected.get(row.round_id + '|' + row.guesser);
      assert.ok(e, f.name + ': unexpected GuessScores row for ' + row.guesser);
      assert.equal(row.eligible, e.eligible, f.name + ': eligible for ' + row.guesser);
      assert.equal(row.correct, e.correct, f.name + ': correct for ' + row.guesser);
      assert.ok(row.correct <= row.eligible, f.name + ': correct exceeds eligible');
    }

    const totalEligible = rows.reduce((a, r) => a + r.eligible, 0);
    assert.equal(totalEligible, scored.length, f.name + ': total eligible != scorable guesses');
    assert.ok(totalEligible < d.guesses.length, f.name + ': nothing was excluded at all');
  }

  assert.ok(sawSelfGuess && sawAbstention, 'fixtures did not contain both self-guesses and abstentions');
});

test('invariant 4: a guesser with only self-guesses and abstentions gets no row', () => {
  const d = {
    tracks: [
      { round_id: 'R01', track_id: 'T1', position: 1, title: 'One', artist: 'X', genres: '' },
      { round_id: 'R01', track_id: 'T2', position: 2, title: 'Two', artist: 'Y', genres: '' },
    ],
    submissions: [
      { round_id: 'R01', track_id: 'T1', submitter: 'A' },
      { round_id: 'R01', track_id: 'T2', submitter: 'B' },
    ],
    votes: [],
    guesses: [
      { round_id: 'R01', track_id: 'T1', guesser: 'A', guessed: 'A' },       // self
      { round_id: 'R01', track_id: 'T2', guesser: 'A', guessed: NO_IDEA },   // abstained
      { round_id: 'R01', track_id: 'T1', guesser: 'B', guessed: 'A' },       // real, correct
    ],
  };

  const rows = A.computeGuessScores_(d);
  assert.deepEqual(rows.map((r) => r.guesser), ['B']);
  assert.equal(rows[0].eligible, 1);
  assert.equal(rows[0].correct, 1);
});

// ===========================================================================
// Invariant 5
// ===========================================================================

test('invariant 5: recompute is idempotent and never mutates its input', () => {
  for (const f of FIXTURES) {
    const d = makeLeague(f.opts);
    const pristine = structuredClone(d);

    const first = recompute(d);
    assert.deepEqual(d, pristine, f.name + ': analytics mutated the raw tables');

    const second = recompute(d);
    assert.deepEqual(second, first, f.name + ': second run differed from the first');

    // And again from a freshly generated copy of the same league, which is
    // what recomputeAll() actually does: re-read the sheet, rebuild.
    const third = recompute(makeLeague(f.opts));
    assert.deepEqual(third, first, f.name + ': rebuilding from a fresh read differed');
  }
});

// ===========================================================================
// Invariant 6
// ===========================================================================

test('invariant 6: a league with zero guesses still scores', () => {
  const d = makeLeague({ players: 6, rounds: 2, guessParticipation: 0, seed: 101 });
  assert.equal(d.guesses.length, 0);

  const { results, guessScores, leaderboard, fans, genres, awards } = recompute(d);

  assert.equal(guessScores.length, 0);
  assert.ok(results.length > 0, 'RoundResults should still be produced');
  assert.ok(leaderboard.length > 0, 'Leaderboard should still be produced');

  for (const r of results) {
    for (const field of ['total_points', 'voters', 'avg_per_voter', 'spread']) {
      assert.ok(Number.isFinite(r[field]), 'RoundResults.' + field + ' is not finite');
    }
  }
  for (const p of leaderboard) {
    assert.equal(p.guess_points, 0);
    assert.ok(Number.isFinite(p.combined), 'combined is not finite');
    assert.ok(p.rounds_played > 0);
  }
  assert.ok(fans.length > 0 && genres.length > 0);
  assert.ok(Array.isArray(awards));

  // With the guess component contributing nothing, each round is worth
  // (song + pop) x 100 instead of 100.
  const perRound = (WEIGHTS.song + WEIGHTS.pop) * 100;
  const total = leaderboard.reduce((a, p) => a + p.combined, 0);
  assert.ok(
    Math.abs(total - perRound * 2) <= leaderboard.length * 0.005 + 1e-9,
    'expected ' + perRound * 2 + ', got ' + total.toFixed(4),
  );
});

test('invariant 6: one round with guesses and one without', () => {
  const d = makeLeague({ players: 6, rounds: 2, guessParticipation: [1, 0], guessAccuracy: 0.9, seed: 202 });
  assert.ok(d.guesses.every((g) => g.round_id === 'R01'));

  const { leaderboard } = recompute(d);
  const expected = 100 + (WEIGHTS.song + WEIGHTS.pop) * 100;
  const total = leaderboard.reduce((a, p) => a + p.combined, 0);
  assert.ok(
    Math.abs(total - expected) <= leaderboard.length * 0.005 + 1e-9,
    'expected ' + expected + ', got ' + total.toFixed(4),
  );
});

// ===========================================================================
// Invariant 7
// ===========================================================================

/** One track, one submitter, `eligible` guessers of whom `correct` are right. */
function difficultyFixture(eligible, correct) {
  const guessers = Array.from({ length: eligible }, (_, i) => 'G' + String(i + 1).padStart(2, '0'));
  return {
    tracks: [{ round_id: 'R01', track_id: 'T1', position: 1, title: 'One', artist: 'X', genres: '' }],
    submissions: [{ round_id: 'R01', track_id: 'T1', submitter: 'S' }],
    votes: [],
    guesses: guessers.map((g, i) => ({
      round_id: 'R01',
      track_id: 'T1',
      guesser: g,
      guessed: i < correct ? 'S' : 'Somebody Else',
    })),
  };
}

test('invariant 7: inverse-frequency points scale with difficulty', () => {
  const cases = [
    { eligible: 4, correct: 1, points: 4 },
    { eligible: 4, correct: 4, points: 1 },
    { eligible: 20, correct: 1, points: 5 }, // capped
    { eligible: 2, correct: 1, points: 2 },
    { eligible: 10, correct: 2, points: 5 }, // 1/0.2 == the cap exactly
  ];

  for (const c of cases) {
    const rows = A.computeGuessScores_(difficultyFixture(c.eligible, c.correct));
    assert.equal(rows.length, c.eligible, c.correct + '/' + c.eligible + ': row count');

    const winners = rows.filter((r) => r.correct === 1);
    const losers = rows.filter((r) => r.correct === 0);
    assert.equal(winners.length, c.correct);
    assert.equal(losers.length, c.eligible - c.correct);

    for (const w of winners) {
      assert.equal(w.eligible, 1);
      assert.equal(w.guess_points, c.points, c.correct + '/' + c.eligible + ' should be worth ' + c.points);
    }
    for (const l of losers) assert.equal(l.guess_points, 0);
  }
});

test('GUESS_SCORING = flat gives one point per correct guess', () => {
  const flat = loadAnalytics({ GUESS_SCORING: 'flat' });
  const rows = flat.computeGuessScores_(difficultyFixture(4, 1));
  const winner = rows.find((r) => r.correct === 1);
  assert.equal(winner.guess_points, 1, 'flat mode should ignore difficulty');
});
