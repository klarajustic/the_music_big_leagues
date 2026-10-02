# Music League Tracker — project context

Personal side project. Google Apps Script backend bound to a Google Sheet,
extending a Music League league with a who-submitted-what guessing game and a
combined leaderboard.

Assume repo-level context only; global conventions come from the usual
`~/.claude/` layer.

---

## The one hard constraint

**Music League has no public API, no CSV export, and no way to write votes
back.** Voting stays in Music League permanently. Everything else — guessing,
analytics, announcements — lives here.

Do not propose moving voting into this system. Do not propose a Music League
integration. Both have been checked; neither exists.

"Permanently" has exactly one recorded exception, and it is not an invitation:
**Deferred → Ranked-choice voting, tier 3** is the case for owning voting
ourselves. It is written down so the trade is evaluated rather than rediscovered
every few months. It is not approved, and tiers 1 and 2 deliberately sit in
front of it. Nothing else reopens this.

---

## Stack, and why

| Concern | Choice | Why not the obvious alternative |
|---|---|---|
| Backend | Google Apps Script | Free, zero ops, built-in cron via time triggers, native Sheets/Forms access. A Next.js + Supabase version was designed and rejected: the deploy pipeline is more work than the app. |
| Database | The bound Sheet, one tab per table | It doubles as the dashboard. No ORM, no migrations, and the owner can hand-fix a bad row. |
| Guess capture | Auto-generated Google Form | No auth, no app install, works on phones. |
| YouTube Music playlists | Local Python + `ytmusicapi` | Data API v3 search has no songs filter and returns no duration — the two signals the matcher lives on. See "YouTube Music is a separate runtime". |
| Notifications | **None.** Announcing is manual | Slack was built and then removed — DEPT's workspace forbids app installs, incoming webhooks included, and there is no personal-workspace fallback. See "No notification layer" below. |

**Deliberately not chosen:** a hosted service, a Slack app with interactive
modals, a browser extension. Each is a real improvement and each is gated
behind actual observed friction, not speculation. See "Deferred" below.

### YouTube Music is a separate runtime

`tools/yt_playlist.py` generates a YouTube Music playlist per round so people
can listen ad-free on a service they already pay for. Spotify stays the source
of truth for submissions, track ids and all matching; this is an additional
output, never a replacement.

**It is Python, it has its own dependency, and it is run by hand.** It is not
pushed to Apps Script and cannot be — clasp only walks `src/`. Nothing in
`tools/` has ever reached the Apps Script project.

Three decisions, all taken knowingly:

- **`ytmusicapi`, an unofficial API.** It is reverse-engineered from YouTube
  Music's internal endpoints, authenticates with browser cookies, can break
  without notice, and sits outside YouTube's ToS. Accepted for a personal
  project because the official alternative is worse at the only thing that
  matters here: Data API v3's `search.list` has no songs filter and returns no
  duration, so the matcher would lose its most discriminating signal and gain
  a 100-searches-a-day quota. If `ytmusicapi` breaks, the fallback is not
  Data API v3 — it is doing nothing, because the playlist is a nice-to-have.
- **A personal Google account owns the playlists, never the DEPT one.** The
  auth file is browser cookies; storing work-account cookies on disk is a bad
  idea whatever the policy says. It also sidesteps the managed-account YouTube
  wall entirely (see the task entry).
- **Playlists are unlisted.** Shared by link. Ad-free comes from each
  listener's own Premium subscription, not from who owns the playlist.

The matching scorer is lifted from Matt Weiss's `hitster_yt` with attribution
in the file. Do not retune its weights casually: every constant encodes a bug
that project already hit, and `test/yt_playlist_test.py` pins the known cases.

### Spotify playlist ingest — RESOLVED by routing around it

**Probed 2026-09-08 with client credentials, playlist `6N6cCy60FSQNTm1kzZPRXU`
(owner "ML Spotify"):**

| Call | Result |
|---|---|
| token | 200 |
| `GET /playlists/{id}` (metadata) | 200 |
| `GET /playlists/{id}/items` | **401 "Valid user authentication required"** |
| `GET /playlists/{id}/tracks` (old) | 403, removed |
| `GET /tracks/{id}` | **200** — `duration_ms`, `album.release_date` intact |
| `GET /artists/{id}` | 200 |
| `GET /artists?ids=` (batch) | 403, removed |

So the ownership rule is real: **playlist contents are unreachable and no
rework of that call will change it.** Client credentials has no user, so it can
never be the owner. But **single-object lookups still work**, which is what
makes the way out cheap — ids from anywhere can still be enriched.

Both consumers are routed around it, differently:

- **`tools/yt_playlist.py` takes a list of track ids** rather than a playlist
  URL, and calls `GET /tracks/{id}` per id for title, artists and duration_ms.
  Unblocked, no Spotify OAuth needed. It rejects a pasted playlist URL with an
  explanation, because a playlist id is also 22 characters and would otherwise
  be mined into a track id that 404s later.
- **The Tracks tab is filled from the Music League page** via the Task 4
  bookmarklet, which sidesteps Spotify ownership entirely. See Task 4.

`fetchPlaylistTracks_` is kept and still wired into `newRoundFromPlaylist_`,
but it now translates the 401/403 into `PLAYLIST_UNREADABLE_` — an explanation
of the ownership rule rather than a raw HTTP error that reads like a broken
credential. Do not "fix" it by adding scopes or changing the URL; the call is
correct and the answer is no.

### The did-not-vote penalty — MODELLED

Music League zeroes a player's own song if they did not vote that round. The
results page renders it as `<s>2</s> 0` with a "Did not vote" badge.

**The principle: we extend Music League, we do not contradict it.** This
leaderboard already measures three things the official standings do not, and
that is the point of it. But a table that disagrees with the official result on
the one number both systems compute would lose trust in all its other numbers
— nobody audits a leaderboard, they just stop believing it.

**Recorded, not inferred.** `Submissions` carries a `did_not_vote` column,
populated by the bookmarklet from the badge. It is never derived from an
absence of vote rows, because **voting all zeros is voting** — Music League
does not penalise that, and the two cases are indistinguishable from the Votes
tab alone. `penalisedSet_()` reads the flag and nothing else.

**Votes stay as cast.** They are facts about who liked what. The scoring
penalty is applied on top, at the leaderboard, not by deleting data.

Where the line falls:

| Table | Penalty applied? | Why |
|---|---|---|
| `Votes` | no | what people actually did |
| `RoundResults` | no | **descriptive** — the song really did get those points from those voters |
| `FanMatrix` | no | descriptive, and about the *voter's* taste, which the submitter's conduct does not change |
| `GenreStats` | no | descriptive, derived from RoundResults |
| `Awards` | no | descriptive, derived from RoundResults |
| `Leaderboard` | **yes** | **competitive** — this is the table that has to agree with Music League |

**Both the song and the pop components are zeroed, not just song.** Music
League only zeroes points, so mirroring it exactly would zero `song` and leave
`pop`. Rejected: `pop` is part of how well a *submission* did, so keeping it
lets a non-voter climb the standings on a song officially worth nothing — the
same contradiction at 0.2 weight instead of 0.4. The penalty means "your
submission does not compete this round", and that is coherent; "your
submission half-competes" is not.

`guess_points` are untouched. The penalty is about the song, not about whether
they played the guessing game.

**The consequence that actually matters:** a penalised submission leaves the
round's **denominator** as well as its numerator. Leave it in the denominator
and every remaining player's share is computed against points nobody can win,
so the round quietly sums to less than 100 and invariant 2 breaks.
`computeSanityCheck_` knows about this too: a round only counts as scoring if a
**non-penalised** song got votes.

A penalised player still appears on the Leaderboard with `rounds_played`
counted and zeros across the board. They played; they just scored nothing.

`validateIngest()` flags the contradiction: a submitter marked `did_not_vote`
who nonetheless has vote rows in that round.

### Two other things the migration broke here

- **Artist `genres` is deprecated and may be empty — UNCONFIRMED, and it
  decides whether GenreStats has a source at all.** The February 2026
  changelog does *not* remove the field, but the Artist reference now marks it
  **Deprecated**, and a probe of Rick Astley returned `genres: null` where the
  schema promises `[]`. One artist is not evidence. Run
  `python3 tools/spotify_probe.py --genres`, which checks five canonical
  heavily-tagged artists (Radiohead, Metallica, Daft Punk, Miles Davis,
  Beyoncé). If all five come back empty, the field is dead in practice:
  `fetchArtistGenres_` becomes 20-40 requests per round that return nothing,
  `GenreStats` collapses to a single `(untagged)` row, and the choice is
  between dropping the feature and finding another tagger. Options are in
  Deferred; nothing is built.
- **Track `popularity` is gone from the API.** The `spotify_popularity` column
  is written empty now. Nothing is lost: `loadAll_` read `t.popularity` while
  the header says `spotify_popularity`, so it was always `undefined` and never
  reached analytics. The column is kept rather than dropped because removing a
  raw-table column needs a manual step (see Gotchas). **`popularity_points` on
  the Leaderboard is unrelated** — that is distinct-voter breadth, computed
  from Votes, and is untouched.
- **Development Mode apps now require the app owner to hold an active Spotify
  Premium subscription**, and dev mode allows at most five allowlisted users.
  If the probe 403s on *everything* including single lookups, this is the cause
  and no endpoint work will help. Third account-level wall after Slack and
  managed-account YouTube — check the Developer Dashboard first.

Not used here, so not a problem: `/search` (limit max dropped 50 -> 10),
`/users/{id}/playlists`, `/browse/*`, `/artists/{id}/top-tracks`, and the album
fields that were removed. `album.release_date` survives, so `release_year` is
safe.

### No notification layer

There is no outbound messaging of any kind. `Slack.js` existed and was deleted;
the webhook approach is dead because **DEPT's workspace does not permit app
installs**, which includes incoming webhooks, and there's no personal workspace
to fall back to. This is an access constraint, not a cost/benefit call, so it
does not get revisited by finding a cheaper implementation.

What that means in practice:

- Announcing a round is manual. The operator copies `form_url` from the Rounds
  tab and posts it wherever the league actually talks.
- Sharing standings is manual: share the Sheet.
- `hourlyTick()` still locks the form and imports guesses on the deadline. It
  tells nobody. Nobody is nudged beforehand either — `nudgeMissingGuessers_`
  was deleted with the rest.

Don't reintroduce a notification path, or prose implying one exists, without
an actual channel to send to.

---

## Where things stand (2 Oct 2026)

**Working, in production.** Four completed rounds are ingested. The Tampermonkey
userscript (`tools/bookmarklet.js`) runs on every `app.musicleague.com` page,
reads a completed round off the results page, and POSTs it to the deployed web
app, which writes Players-adjacent raw tables and creates the Rounds row. No
console, no clipboard, no menu clicks.

The web app is deployed with `ANYONE_ANONYMOUS` access — **DEPT permits this**,
confirmed by an anonymous POST reaching `doPost` and returning our own JSON.
That is the first of four permission walls that did not block us. The `/exec`
URL and `INGEST_TOKEN` live in the owner's Script properties and the local
userscript only; **neither belongs in this repo**.

**Not working yet: the guessing game.** It needs `Tracks` rows for a round that
is still *open*, and nothing creates those. Two possible routes, both blocked on
the same thing — a round being in the voting window:

- **Mode A** (preferred): read the track ids off the voting page. Unverified —
  no round has been in voting at any point during development. Round 8 was
  still accepting submissions as of 2 Oct 2026.
- **`--tracks-tsv`** (built, untested against a live round): copy the Music
  League round playlist into an owned Spotify account, then
  `python3 tools/yt_playlist.py --playlist <url> --tracks-tsv --round R08`.
  Works without `ytmusicapi`.

**Owner away until roughly 12 Oct 2026.** Nothing is scheduled, no triggers are
installed, and nothing degrades while idle. Pick up at Task 4 Mode A when a
round next reaches voting; that capture window closes at the reveal.

---

## Repo layout

```
.
├── .clasp.json              # scriptId, rootDir: "src" — GITIGNORED
├── .clasp.json.example      # copy it, paste your own scriptId
├── .env.example             # Spotify credentials for the tools/ scripts
├── .claspignore
├── jsconfig.json            # Apps Script type hints for the editor
├── package.json
├── CLAUDE.md
├── README.md                # end-user setup guide — keep in sync
├── src/                     # everything here is pushed to Apps Script
│   ├── appsscript.json      # manifest: timezone, OAuth scopes, webapp config
│   ├── Config.js            # SHEETS, HEADERS, WEIGHTS, property helpers
│   ├── Setup.js             # onOpen menu, tab scaffolding, triggers
│   ├── Spotify.js           # client-credentials auth, playlist + artist fetch
│   ├── Rounds.js            # round creation, form generation, guess import
│   ├── Ingest.js            # doPost endpoint, mapPayload_, validation
│   └── Analytics.js         # all derived tables (pure functions) + sanityCheck
├── .gitignore               # node_modules, the ytmusicapi cookie file, caches
├── tools/                   # operator-run, NEVER pushed to Apps Script
│   ├── bookmarklet.js       # scrapes ML results page, POSTs to doPost
│   ├── yt_playlist.py       # Spotify playlist -> YouTube Music playlist
│   └── yt-overrides.json    # manual match corrections (committed, see below)
└── test/
    ├── analytics.test.mjs   # the seven invariants, against the real src files
    ├── runtime.test.mjs     # withLock_ / guard_ / warnIfLarge_ against stubs
    ├── bookmarklet.test.mjs # Mode B scraper, evalled in jsdom against the fixture
    ├── page-results.html    # FIXTURE: real results page, "Cover Songs", 9 Sep 2026
    └── yt_playlist_test.py  # the lifted scorer's known cases
```

`test/page-results.html` is **redacted** and must stay that way: the repo is
public, and the original carried eleven colleagues' real names, their vote
comments and their Music League user ids. Names, comments and ids are all
synthetic. The substitutions deliberately preserve what the tests exercise —
two names with diacritics, three lowercase handles, one handle with digits,
and apostrophes in the comments — so re-redacting after a fresh capture means
keeping those shapes, not just scrubbing the text.

`test/page-results.html` is the Task 4 Mode B fixture. **Keep it** — it is the
only record of Music League's results markup, and it is what turns a redesign
into a failing test instead of a mystery. `jsdom` is a devDependency solely to
run the scraper against it.

`tools/yt-overrides.json` is **committed**, unlike hitster_yt's equivalent: a
deck is one person's, but a round is shared and permanent, so the correction
belongs in the repo alongside it. The cookie file and the search cache are
gitignored.

### Source files are `.js`, not `.gs`

**This is deliberate — do not rename them.** clasp stores Apps Script's `.gs`
server files as `.js` locally and converts on push and pull automatically.
That is clasp's default behaviour, not something this repo configures —
`.clasp.json` says nothing about extensions. Working in `.js` means normal
editor tooling, linting and type hints all apply. The files still land in the
Apps Script editor as `.gs`.

Which name a doc should use depends on what the reader is looking at:

- **Repo-facing text** — this file, code comments, the repo layout, the clasp
  workflow, anything about editing or pushing source — says `src/*.js`, because
  that is the file you open. A `.gs` reference here is a mistake; fix it.
- **User-facing setup text** — the parts of `README.md` walking someone through
  the Apps Script editor — says `.gs`, because that is what the editor shows
  them. `Config.gs` and `Rounds.gs` in README.md are **correct as written**.
  Leave them alone.

So the two docs disagree on purpose. Before "fixing" a `.gs` reference, check
which side of that line it falls on.

File header comments name the module with no extension at all (`* Config — all
tunable settings live here.`). The filename is already in the editor tab and
the repo tree, so repeating it just creates somewhere for the two to drift
apart. Don't add an extension back.

### Workflow

```bash
npm install                       # clasp + Apps Script type definitions
npx clasp login
npx clasp clone <scriptId> --rootDir ./src   # first time only
npm run push                      # or: npm run watch
npm test                          # the Apps Script analytics + runtime helpers
npm run test:py                   # the YouTube matcher's scorer
```

`npm run test:py` needs no dependencies — `unittest` only, and the scorer is
pure. Running `tools/yt_playlist.py` itself needs `pip install ytmusicapi`.

`rootDir: src` is what keeps `tools/`, `test/` and the repo config out of the
Apps Script project. clasp also skips anything starting with `.`, so
`.clasp.json` itself is never pushed.

Note that `clasp push` **replaces the entire remote project** — the Apps Script
API has no per-file or atomic operations. Never hand-edit in the web editor
without pulling first, or the edit is gone on the next push.

If the source files aren't in the repo yet, ask the owner for them before
regenerating — a working, hand-tested version exists. The spec below is
complete enough to rebuild from, but rebuilding would discard tested code.

---

## Data model

Raw tables (written by ingest, never by analytics):

| Tab | Columns |
|---|---|
| `Players` | name, active |
| `Rounds` | round_id, week, theme, playlist_url, form_url, form_id, votes_close_at, status, season |
| `Tracks` | round_id, position, track_id, title, artist, artist_ids, genres, release_year, spotify_popularity |
| `Submissions` | round_id, track_id, submitter, did_not_vote |
| `Votes` | round_id, track_id, voter, points, comment, title |
| `Guesses` | round_id, track_id, guesser, guessed, timestamp |

`Votes.title` is denormalised from `Tracks` purely so the tab is legible —
96 rows of 22-character ids tell a human nothing. **Nothing reads it back**:
every join is on `track_id`, so a stale title is cosmetic, never a scoring bug.
It is appended last rather than placed next to `track_id` because inserting a
column mid-table would mis-key every existing row until the next full ingest
(see Gotchas).

Derived tables (fully rebuilt by `recomputeAll()`, never hand-edited):
`RoundResults`, `GuessScores`, `Leaderboard`, `FanMatrix`, `GenreStats`,
`Awards`, plus `_RawIngest` as a debug log.

`round_id` is `R01`, `R02`, … `track_id` is the Spotify track ID and is the
join key everywhere. `status` ∈ `open` | `locked` | `scored`.

`season` is a number, appended to `Rounds` rather than inserted so existing
sheets stay aligned. Blank or missing means season 1, so nothing needs
backfilling. `round_id` and `week` stay globally sequential across seasons —
`round_id` is the join key, so restarting it would be a migration. New rounds
join the highest season already in the tab; to start season 2, type `2` into
the season cell of its first round.

Player names are the join key for people, and must match Music League
**exactly**. This is the number one source of silent breakage. `validateIngest()`
exists to catch it; don't remove it.

---

## Scoring specs

These are settled decisions with reasons. Change them only if asked.

**Electorate.** For a given song, the electorate is everyone who appears in
that round's `Votes` rows, minus the submitter (you can't vote for your own).
A voter absent from a song is a real zero, not a missing value — this matters
for `spread`.

**Per-song metrics.** `total_points` (sum), `voters` (distinct voters with
points > 0), `avg_per_voter` (total ÷ voters), `spread` (population standard
deviation across the full electorate including zeros — the divisiveness
metric).

**Guess scoring.** Self-guesses excluded from numerator and denominator.
`No idea` excluded, so abstaining is free. Default mode is inverse frequency:

```
frac = correct_guesses_on_this_track / eligible_guessers_on_this_track
points_for_a_correct_guess = min(5, 1 / frac)
```

So cracking the one song nobody else got is worth 5×  a gimme. `GUESS_SCORING
= 'flat'` switches to 1 point per correct.

**Combined leaderboard.** Each component is normalised to a *share of that
round's total* before weighting, so rounds with different player counts and
point pools stay comparable. `combined` is an index, not a point count.

```
WEIGHTS = { song: 0.6, pop: 0.2, guess: 0.2 }
```

They must sum to 1. `combined` is a share of 100 per round, so any other total
silently breaks invariant 2 and `sanityCheck` with it. Tests derive the
per-round values from `WEIGHTS` rather than hardcoding 100 and 60, so a
retune does not need a test edit.

`pop` is low on purpose: it correlates strongly with `song` (the same song
usually wins both), so equal weighting double-counts one result. 0.2 lets
breadth break ties without dominating.

`guess` was 0.4 and is now **0.2** (owner's call, Oct 2026). At parity a player
who picked indifferently but read the room well finished above one whose songs
everybody liked, and this is a music competition first. `song` absorbed the
difference rather than `pop`, to keep the double-counting argument above intact.
A round with no guesses is therefore worth **80**, not 60.

**Seasons.** `Leaderboard` and `Awards` are grouped by season; `FanMatrix` and
`GenreStats` are all-time. The split is deliberate:

- The leaderboard resets because a cumulative index is **unwinnable by round
  15**, and an unwinnable table kills participation. That's a competitive
  argument, not a statistical one.
- Nobody wins the fan matrix or the genre table, and their entire value is
  sample size. One season of 8 rounds is ~40 points per voter — noise. Four
  seasons is a real picture of whose taste somebody actually likes. Resetting
  them would pin them in the noisy regime forever, which is the opposite of
  what they're for.

Both tabs already carry their own n (`shared_rounds`, `submissions`), so a thin
sample is visible rather than hidden.

The two fandom awards are the seam: they live in the per-season `Awards` table,
so `computeAwards_` builds a **season-scoped** fan matrix for them rather than
reusing the all-time `FanMatrix` tab. Every row in `Awards` means "this season".
Don't wire the all-time matrix back in for convenience.

`sanityCheck()` is per season too — the leaderboard is, so its round
expectations have to be.

**Fan matrix.** `share` = points voter A gave submitter B ÷ total points A
distributed, restricted to rounds where both participated. Raw point totals
must not be used as the headline number — they just crown whoever showed up to
the most rounds.

---

## Invariants (these are your tests)

Verified by hand against a synthetic 4-player, 2-round fixture. Formalise them:

1. `sum(RoundResults.total_points)` per round == `sum(Votes.points)` per round,
   excluding any vote a submitter cast for their own song. Music League does not
   permit self-voting, so such a row means something upstream is wrong;
   `validateIngest()` reports it rather than letting the electorate rule drop
   the points silently.
2. `sum(Leaderboard.combined)` == 100 per round that had at least one correct
   guess, plus `(song + pop) × 100` = 60 for a round that had none — the guess
   component is skipped when nothing scored it. Allow `players × 0.005`: every
   `combined` is rounded to 2dp before it lands in the sheet, so the total is
   near a multiple of 100, not exactly one. `sanityCheck()` computes this
   expected total from the raw tables and reports the per-round breakdown; run
   it instead of eyeballing the number.
3. No submitter appears in their own song's electorate.
4. No `GuessScores` row counts a self-guess or a `No idea`.
5. `recomputeAll()` is idempotent — running it twice produces identical
   derived tables.
6. A round with zero guesses still produces valid `RoundResults` and a
   `Leaderboard` (guess component simply contributes 0).
7. Inverse-frequency points for a track guessed correctly by 1 of 4 eligible
   guessers == 4.0; by 4 of 4 == 1.0; by 1 of 20 == 5.0 (cap).

---

## Task queue

### 1. Scaffold and push — DONE
Set up the repo layout above, `.clasp.json`, and confirm `clasp push` lands
all `src/` files as `.gs` in the Apps Script editor. Verify the `🎵 Music League` menu appears on Sheet reload and
that "Create/repair tabs" produces every tab with correct headers.

### 2. Build the test harness — DONE
`test/analytics.test.mjs` using `node:test`. The analytics functions are pure
(they take a `{votes, submissions, guesses, tracks}` object, return arrays) but
Apps Script has no module system, so load them by reading `src/Analytics.js`,
extracting the pure functions, and `eval`ing them with the constants from
`Config.js` injected. Ugly but it needs no build step, and a build step for a
seven-file Apps Script project isn't worth it.

Write a fixture generator (`makeLeague({players, rounds, ...})`) so invariants
can be checked across player counts, abstention rates, and rounds with
multiple submissions per player.

Acceptance: all seven invariants above pass; `npm test` is green.

### 3. Harden the write paths — DONE
- Every `Sheet` mutation goes through `withLock_` (`Config.js`). It is
  **re-entrant on purpose**: `getScriptLock()` returns a fresh Lock each call,
  so a nested `tryLock` would deadlock an execution against itself, and
  `ingestResults_` nests three deep (itself → `writeTable_` → `setRoundStatus_`).
  Don't replace it with a bare `getScriptLock()`.
- Every menu entry runs inside `guard_(label, fn)`, which alerts on a throw and
  falls back to `Logger` where there is no UI. It stays silent for `Cancelled.`
  so backing out of a prompt isn't reported as a failure.
- `importGuesses_` and `ingestResults_` call `warnIfLarge_` before writing;
  past `ROW_WARN_THRESHOLD` (5000) it toasts rather than silently crawling.
- Long network calls stay *outside* the lock: the Spotify fetches in
  `newRoundFromPlaylist_` and the Forms read in `importGuesses_` run first.

### 4. Implement the Music League scraper — NOW LOAD-BEARING, TWO MODES

This was optional convenience. Since the February 2026 Spotify migration killed
playlist reads, **it is the only route to a round's track list**, so the Tracks
tab depends on it.

It needs a human in the loop and it now needs that human **twice**, at two
different points in a round's life:

**Mode A — round open (NEW).** Runs on the **voting page**, while songs are
still anonymous, and yields the round's Spotify track ids. This is what fills
the Tracks tab and therefore what the guess form is generated from.

- Payload: `{roundId, tracks: [{track_id, position}]}`.
- Ids only is enough. `GET /tracks/{id}` still works under client credentials,
  so title, artist and release year can be enriched server-side exactly as
  before — only the *source of the id list* has changed.
- **Still unverified as of 2 Oct 2026**, and the reason is scheduling, not
  difficulty: no round has been in the voting window during any working
  session. The probe to run the moment one is, pasted into the console on the
  voting page:

  ```js
  (() => { const $ = s => document.querySelectorAll(s); console.log({
    url: location.pathname,
    trackLinks: $('a[href*="open.spotify.com/track/"]').length,
    trackIdAttrs: $('[id^="spotify:track:"]').length,
    spotifyIframes: $('iframe[src*="spotify"]').length,
  }); })()
  ```

  Any of the first two above zero means Mode A is buildable. Iframes only means
  the ids are inside embed URLs. All zero means Music League hides track
  identity until the reveal and Mode A is genuinely dead.

  `ML.discover()` is exposed on every page, including ones the scraper cannot
  read, precisely so it is usable here.

- **Flag, unverified:** does the voting page actually expose Spotify track ids?
  Very likely yes, because the page has to render playable songs and Music
  League embeds Spotify to do it; the anonymity is about the *submitter*, not
  the track. But it is unverified, and if the ids turn out to be Music
  League's own opaque identifiers with no Spotify mapping, this mode is dead
  and the fallback is manual id entry into the Tracks tab.
- **Scheduling constraint:** the voting page only exists *while a round is
  open*. The discover run has to happen during a live round and cannot be done
  retroactively — so it is gated on a round being open, not just on someone
  having time.

**Mode B — reveal. DONE, console-only.** Runs on the results page and prints
Submissions and Votes as paste-ready TSV. **No endpoint, no token, no
deployment** — the `doPost` path still exists but needs a web app that is not
deployed, and this needs nothing. Tested against `test/page-results.html`
("Cover Songs", captured 2026-09-09) by `test/bookmarklet.test.mjs`, which
evals the shipping file inside jsdom.

Measured on that fixture: 11 songs, 52 vote rows, comments intact.

Every page-shape assumption is in one `SELECTORS` object so a redesign is a
five-minute fix. The scraper self-checks by summing each song's vote rows
against the total the card prints — a selector quietly missing rows shows up
as a warning rather than a plausible, wrong leaderboard.

Run `discover` on **both** pages and save both payloads redacted as fixtures, so
a redesign of either shows up as a failing test rather than a mystery.
`mapPayload_()` in `Ingest.js` gains a tracks branch alongside the existing
submissions/votes one.

Do **not** write a speculative scraper against a guessed DOM. If the JSON path
does not pan out, the DOM fallback is: walk the cards, pull `track_id` from the
`spotify.com/track/<id>` href.

Constraint: the manual paste path must keep working unchanged. With Spotify
playlist ingest gone it is now the *only* fallback, so it matters more than it
did, not less.

### 5. Season support — DONE
`season` on `Rounds`; `Leaderboard` and `Awards` grouped by it and sorted
latest-first; `FanMatrix` and `GenreStats` deliberately left all-time (see
**Seasons** under Scoring specs). `sanityCheck()` defaults to the latest
season. The schema change migrates itself on the next recompute — see
the `writeTable_` gotcha below for why, and for the one table it doesn't cover.

Not built, and not needed yet: a "Start new season" menu item. Bumping a season
is one cell in the Rounds tab, which is in keeping with the sheet being the
database.

### 8. Last.fm enrichment — obscurity and genre in one integration

**The problem.** Awards about genre or how underground a submission is have no
data behind them. Spotify removed track `popularity` AND artist `popularity`
in February 2026, and artist `genres` is deprecated and arriving empty. Tracks
ingested from the Music League results page carry no genre or year at all.

**Why not Spotify play counts:** the Web API has never exposed them. The counts
in the Spotify client are rendered from data they do not publish. Not a
migration casualty, simply never available.

**Why not YouTube view counts as the primary signal:** they are obtainable and
cheap — `videos.list?part=statistics` costs **1 unit** and takes **50 ids per
call**, so the whole league is 3 calls, and only an API key is needed rather
than the OAuth rejected in Task 6. But a view count measures *an upload*, not a
song: an official video, a lyric video and three fan re-uploads split the same
track's views. Keep it as a cross-check, since `yt_playlist.py` already
computes the video ids.

**Use Last.fm.** One free API key, no OAuth, one call per track:

- `track.getInfo` -> `listeners` and `playcount`, for the **song**, not an
  upload. That is the obscurity signal.
- `track.getTopTags` -> genre tags **per track**, which is strictly better than
  what Spotify ever offered here: Spotify only ever tagged the *artist*, which
  is the caveat `GenreStats` has carried since day one.

So one integration fixes both, and supersedes the "replacement genre source"
entry in Deferred.

**Shape of the work.**
- `Tracks` gains `listeners` and `tags` (append, never insert — see Gotchas).
- Enrichment is a seam in `Rounds.js`, same place the Spotify call used to sit.
  It can also run locally over existing rounds to backfill all 7.
- **Cache per track.** A league replays artists constantly and tags never
  change; caching turns a per-round cost into a one-off. This matters more
  than the choice of source.
- Tags are noisy and need a weight cutoff before `GenreStats` is worth reading.

**Awards it unlocks**, none of which are buildable today: Crate digger (lowest
average listeners across their submissions), Populist (highest), Deep cut (the
most obscure song that still scored well), Genre loyalist and Magpie (narrowest
and widest genre spread).

### 7. Guess form for a live round — BLOCKED on Task 4 Mode A

Everything downstream exists and is tested. `hourlyTick` creates the form by
itself for any round that is `open` and has `Tracks`, then mails the link via
`notify_` (`NOTIFY_EMAIL` script property). `createGuessForm_` survives a
missing deadline. The only missing input is the track list for an open round.

To run it manually once a round is in voting: fill `Tracks`, add a `Rounds` row
with status `open`, install triggers, and the form appears within the hour —
or immediately via menu **3. Create guess form**.

### 6. YouTube Music playlist per round — BUILT, needs tuning

`tools/yt_playlist.py` is written and its scorer is tested. What remains is
tuning `REVIEW_THRESHOLD` against a real round, which needs a live playlist:

```bash
pip install ytmusicapi
export SPOTIFY_CLIENT_ID=... SPOTIFY_CLIENT_SECRET=...
python3 tools/yt_playlist.py <spotify-playlist-url>              # dry run
python3 tools/yt_playlist.py <spotify-playlist-url> --publish    # create it
```

Dry run is the default and needs **no YouTube credentials at all** — search is
unauthenticated, only publishing is not. So the threshold can be tuned before
anything is authorised or created.

The script refuses to publish if any track scores below the threshold. That is
deliberate and should stay: ten tracks is thirty seconds of human attention,
and one wrong song degrades the round for everyone listening. The escape hatch
is `tools/yt-overrides.json`, not a `--force` flag. A track genuinely absent
from YouTube Music gets `{"omit": true}`, which is reported in the output and
written into the playlist description rather than passed over quietly.

Expected quality: hitster_yt measures ~0.6–1% unusable matches on **English**
decks, so roughly one bad match every 10–15 rounds at ten tracks each. It
degrades with diacritics and does not transfer to non-Latin script at all, so
an international league will do worse. Tune with real rounds, not assumptions.

**Do not move this into Apps Script.** The findings that put it in `tools/`:

- **A playlist needs a YouTube channel, and DEPT's Workspace may not permit
  one.** YouTube is an "additional Google service" that admins routinely
  disable, and channel creation on managed accounts is often blocked. The
  Apps Script runs as the DEPT account, so `playlists.insert` could fail with
  no workaround — the identical wall that killed Slack. A local script running
  as a personal account never meets it.
- **It would need `https://www.googleapis.com/auth/youtube` in
  `appsscript.json`, a sensitive scope.** Workspace admins can block
  third-party access to sensitive scopes, so adding one risks breaking the
  authorization that currently works for everything else.
- **Seeing YouTube quota at all requires a standard Cloud project**, and
  switching to one forces re-enabling every advanced service and
  re-authorization by every user.
- **Quota, if anyone still wants the API version.** `search.list` costs 100
  units against a 10,000/day default — about 100 searches a day. A ten-track
  round is ~1,550–2,550 units, so a round fits, but backfilling old rounds and
  ordinary development iteration do not. `playlistItems.insert` at 50 units is
  *not* the expensive call; search is.
- Apps Script *can* do the OAuth — there is a built-in YouTube advanced
  service and this is one operator, not per-user. Viability was never the
  problem. Match quality and the permissions surface were.

---

## Deferred — do not build unless asked

- **Slack app with slash command + modal.** Nicer UX for guessing, and still
  the right shape if Slack ever becomes available.
  **Blocked on workspace permissions, not on effort** — DEPT's workspace does
  not allow app installs, so there is nothing to install this into and no
  amount of engineering changes that. Treat it as unavailable rather than
  expensive; the same block is why `Slack.js` was deleted rather than left
  dormant.
  If that ever changes, the original engineering objections still stand and
  are what makes it a real project rather than an afternoon: Slack's 3-second
  ack requirement (Apps Script cold starts are slower) and request-signature
  verification (needs raw body access, which `doPost` makes awkward). The
  correct solution is a Cloudflare Worker in front, which reintroduces the ops
  burden this stack exists to avoid.
- **Bijection guessing mode** (each guesser assigns every player exactly once).
  More strategic, needs partial-permutation scoring, and can't be expressed in
  a Google Form — so it's coupled to the Slack modal, and therefore blocked on
  the same workspace permissions.
- **Theme-fit voting** (1–5 per song on brief adherence). Cheap: one extra Form
  question per track. Unlocks a "best song that ignored the brief" award.
- **Migration to a hosted app.** Only if the league outgrows Sheets, which at
  ~10 players × 50 rounds it will not. Note this is a *smaller* thing than
  ranked-choice tier 3 below: moving where the analytics run, not taking over
  submission and voting.

### A replacement genre source — SUPERSEDED by Task 8

Task 8 (Last.fm) covers this and the obscurity signal in one integration. The
comparison below is kept because the reasoning still stands; the conclusion is
that Last.fm wins on both counts.

#### Original comparison

Gated on `python3 tools/spotify_probe.py --genres`. If artist genres still come
back populated, none of this is needed. Nothing here is built.

`GenreStats` is the only consumer, and its caveat already says Spotify's tags
are coarse and occasionally unhinged — so a replacement is an upgrade, not
merely a restoration. The enrichment step in `Rounds.js` is the single seam.

- **Last.fm top tags.** Free API key, no OAuth, `artist.getTopTags` and
  `track.getTopTags`. Crowd-sourced, so tags are richer and more current than
  Spotify's, and available **per track** rather than only per artist — which
  fixes the caveat this repo has carried since day one. Cost: tags are noisy
  and need a weight cutoff, and it is another key to hold. One request per
  track, same shape as the per-artist loop that already exists.
- **MusicBrainz.** No key at all, but genre coverage is thin next to Last.fm
  and the 1 req/s limit means ~20 seconds a round of pure waiting, inside a
  6-minute budget shared with everything else. `hitster_yt` uses MusicBrainz
  for release years and its README documents the rate limit as the dominant
  cost of a whole import, which is the same trap here.
- **Drop GenreStats.** Honest option. It is the least-used derived table, its
  own docs warn against reading it too hard, and one lucky pick crowning a
  genre has always been its weakness. Deleting a feature nobody consults beats
  a second API dependency to keep it alive.

Whichever wins, cache per artist or per track. A league reuses artists heavily,
so a cache turns a per-round cost into a one-off — and that matters more than
the choice of source.

### Ranked-choice voting — raised by Matt Weiss

**The critique, and why it's fair.** Music League's point pool confounds
breadth with intensity. Spending 5 points on one song and 1 point on each of
five songs produce the same aggregate footprint but mean opposite things, and a
song two people loved lands on the same total as a song everyone mildly liked.
A ranking is ordinal: it records what you preferred, not how many chips you
were willing to spend saying so.

This repo already concedes the point three times over. `voters` and
`avg_per_voter` are separate columns because `total_points` can't tell those
cases apart. `spread` exists to surface divisiveness. `WEIGHTS.pop` is pinned
at 0.2 because breadth and depth correlate and summing them double-counts.
Three workarounds for one flaw is good evidence the flaw is real.

It cuts the other way too, though: those workarounds are built, tested and
understood, so most of what ranked choice would buy has already been bought.
What's left is the part the metrics genuinely cannot reach — **would ranked
choice pick a different winner?** Tier 1 answers exactly that and builds
almost nothing, which is why it comes first.

**Tier 1 — shadow ranked ballot.** Add a ranking question to the guess form
we already generate: players rank the round's songs, we tabulate a parallel
leaderboard and diff it against the official one. No rebuild, reuses the form
infrastructure and `importGuesses_`'s existing plumbing.

- *Cost:* more form friction every round, on top of the guessing questions —
  and form friction is the one cost here that nothing else absorbs.
- *Limit:* changes nothing about how Music League scores anything. It's a
  measurement, not a fix.
- **Do this one first if the topic comes up again.** It's the cheap
  experiment, and its result decides whether tiers 2 and 3 are worth
  discussing at all. If the two orderings agree round after round, the whole
  question is settled for the price of one form field.

**Tier 2 — ranked-choice tabulation.** Score the tier-1 ballots properly.

- **Borda count, not IRV.** We want a full ordering of every song. IRV is
  built to elect a single winner and throws away preference information to get
  there, which is precisely the information we're collecting.
- Reach for **Condorcet/Schulze** only if pairwise consistency turns out to
  matter in practice — don't start there.
- **Keep it as a separate leaderboard. Do not fold it into `combined` as a
  fourth component.** `combined` is a share-normalised index; every component
  in it is a fraction of a round total. An ordinal method has no share to
  contribute, so mixing one in produces a number with no clean
  interpretation. Two tables that can disagree is the honest presentation.

**Tier 3 — replace Music League entirely.** Own submission, playlist
generation, voting and the reveal. The only path to *genuine* ranked-choice
voting, since tiers 1 and 2 are both shadow measurements running alongside
Music League's actual scoring.

- *Cost:* Spotify OAuth per player (not the Client Credentials flow this repo
  uses — that's why the current Spotify integration is read-only and needs no
  user login), playlist writes, deadline enforcement, and the reveal mechanic,
  which is the part people actually turn up for.
- *Cost:* convincing everyone to leave a tool that already works. This is the
  real blocker and it isn't an engineering one.
- *Cost:* weeks, not days.
- *Consequence:* the scraping seam (Task 4, `tools/bookmarklet.js` and
  `mapPayload_`) becomes dead code. Don't sink effort into hardening it if
  tier 3 is seriously on the table.

---

## Gotchas

- **`writeTable_` rewrites the header row from `HEADERS` on every write.**
  Editing `HEADERS` therefore migrates every derived table the next time
  `recomputeAll()` runs — no "run Create/repair tabs first" step, and no
  chance of a new column landing underneath a stale header. That is the
  intended behaviour, but it means an edit to `HEADERS` reshapes live tabs
  without anyone asking. Two things follow:
  - **Append** columns to *raw* tables rather than inserting them. Existing
    data rows keep their column positions while the header moves, so an
    inserted column silently misaligns every row already in the sheet. This is
    why `season` is last in `Rounds` and first in `Leaderboard` — the latter is
    derived and fully rewritten, so order is free there.
  - `Rounds` is the one table `writeTable_` never touches: it's written with
    `appendRow` and `setValue`. Its header still needs **Create/repair tabs**
    after a schema change. Nothing else does.
- **Removing a column from a raw table is NOT self-migrating. It needs a manual
  step.** Adding is safe; removing is not the mirror image of it. Neither
  `setupSheets` nor `writeTable_` clears anything to the *right* of the new
  header — they write exactly `head.length` cells — so the dropped column's
  data survives, and so does whatever header text was above it.

  Worked example, the `slack_handle` removal that prompted this note. `Players`
  went from `[name, slack_handle, active]` to `[name, active]`. Run
  Create/repair tabs on an existing sheet and row 1 becomes
  `name | active | active` — column C keeps its old `active` header, column B
  still holds handles, and `readTable_`'s last-key-wins mapping happens to
  land on the correct column C. It works, by luck, and it looks broken.

  So when you drop a column: **delete the column in the tab by hand first,
  then run Create/repair tabs.** For `Players`, delete the `slack_handle`
  column; the sheet is then already correct and the repair is a no-op. Don't
  rely on the accident above — it only held because the orphaned header
  happened to duplicate a real one.
- **Spotify genres live on the artist object, not the track**, and they're
  coarse. `GenreStats` always reports `submissions` alongside `avg_points`
  because one lucky pick otherwise crowns a genre. If better tags are wanted,
  swap the enrichment call in `Rounds.js` for Last.fm top tags or MusicBrainz —
  it's an isolated function.
- **Don't build on Spotify's `/audio-features` or `/audio-analysis`.** Both
  were restricted for new apps in late 2024. Same for `/recommendations` and
  `/artists/{id}/related-artists`.
- Spotify tokens are cached in `CacheService` with a 120s safety margin; the
  client-credentials flow needs no user login and works on public playlists.
- `UrlFetchApp` is capped around 20k calls/day on a consumer account. Nowhere
  near it, but batch artist lookups stay at 50 ids per call.
- Playlist items can be `null` (local files, region-locked tracks). The fetch
  loop already skips them; keep that.
- Apps Script V8 handles modern syntax, but the existing code avoids `?.` and
  `??` for consistency. Match the surrounding style rather than mixing.
- Form question titles are the mapping key back to a track: the `T<position>.`
  prefix is parsed in `importGuesses_`. Don't reformat titles without updating
  both sides.
- `importGuesses_` keeps only the latest response per player, so people can
  change their minds. Don't add `setLimitOneResponsePerUser(true)`.
- The first-run OAuth screen shows an "unverified app" warning. Expected for a
  personal script; document it, don't try to fix it.
