# Music League Tracker

Turns a Google Sheet into the database and dashboard for your Music League:
auto-generates a weekly "who submitted what" guessing form from the round
playlist, scores the guesses after the reveal, and computes a combined
leaderboard plus a pile of social stats.

No hosting, no deploy pipeline, no database. Apps Script runs free on Google's
infrastructure and has built-in cron.

```
Spotify playlist ──> Tracks tab ──> Google Form ──> Guesses tab
                                                         │
Music League reveal ──> Submissions + Votes tabs ────────┤
                                                         ▼
                                    RoundResults · GuessScores · Leaderboard
                                    FanMatrix · GenreStats · Awards
```

## Two honest limitations

**Voting stays in Music League.** There's no API to write votes back, so you
can't move that. What you *can* consolidate is everything around it: the
guessing game and all the analytics. The Sheet is where the stats live.

**There's no notification layer.** Nothing gets announced automatically. This
started as a Slack integration and it was removed — DEPT's workspace doesn't
allow app installs, incoming webhooks included, and there's no personal
workspace to fall back on. So announcing a round means copying the form link
out of the Rounds tab and posting it wherever your league already talks, and
sharing the standings means sharing the Sheet. Two copy-pastes a week.

The hourly trigger still closes the form and imports guesses on the deadline —
it just doesn't tell anyone it did.

---

## Setup (about 20 minutes, once)

### 1. Create the script

1. New Google Sheet. Name it whatever.
2. **Extensions → Apps Script**.
3. Delete the default `Code.gs`. Add a file per source file in `src/`
   (`Config`, `Setup`, `Spotify`, `Rounds`, `Ingest`, `Analytics`) and
   paste the contents in. The Apps Script editor names them `.gs`; the repo
   keeps them as `.js` because that's what clasp expects locally. Same code.

   Only `src/` goes to Apps Script. `tools/` and `test/` stay on your machine —
   clasp never even looks at them.

   If you'd rather not copy-paste: `npm install && npx clasp login && npx clasp
   clone <scriptId> --rootDir ./src && npm run push`.
4. Click the gear (**Project Settings**) → tick *Show "appsscript.json"* →
   open it and paste in the manifest from `appsscript.json`. Change the
   timezone if you're not in Zagreb.
5. Reload the Sheet. A **🎵 Music League** menu appears.
6. Run menu item **1. Create/repair tabs**. Approve the permissions prompt
   (it's your own script, the scary "unverified app" screen is expected —
   click *Advanced → Go to…*).
7. Fill in the **Players** tab: exact names as they appear in Music League,
   and `TRUE` for anyone currently playing.

> Names must match Music League **exactly**. This is the single most common
> cause of broken stats. Menu item 5 checks for it.

### 2. Spotify credentials

1. Go to the Spotify Developer Dashboard, **Create app**. Any name, any
   redirect URI (unused — we use the Client Credentials flow, so no user login).
2. Copy the Client ID and Client Secret.
3. In Apps Script: **Project Settings → Script properties → Add**:
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`

### 3. Triggers

Run menu item **Install daily triggers**. An hourly job now locks the guess
form and imports the responses the moment voting closes. That's the entire
automation — it runs silently, so put the deadline somewhere people will see
it when you announce the round.

### 4. Optional: the push endpoint

Only if you want to skip pasting results. **Deploy → New deployment → Web
app**, execute as *me*, access *Anyone*. Copy the `/exec` URL. Add a script
property `INGEST_TOKEN` with any random string. Then follow the instructions in
`bookmarklet.js`.

---

## The weekly ritual

Once set up, your job is about three minutes a week.

| When | What you do |
|---|---|
| Round opens for voting | Menu **2. New round from playlist…** — paste the theme, the Spotify playlist link, and the voting deadline. **Currently broken, see below.** Then **3. Create guess form**, and post the link it gives you wherever your league talks. Optionally run the YouTube Music tool below and share that link too. |
| Deadline passes | Nothing. The hourly trigger locks the form and imports guesses. |
| Reveal drops | Paste results into **Submissions** and **Votes** (or run the bookmarklet). Then **5. Validate**, **6. Recompute analytics**, and share the Sheet. |

### Heads up: "New round from playlist" is broken

Spotify changed its API in February 2026 so that a playlist's contents are only
returned to the account that **owns** the playlist. Music League owns the round
playlists, so the Sheet can no longer read the track list out of them — the
menu item now stops with an explanation instead of pretending otherwise. It is
not your credentials and it is not the URL.

Until the Music League scraper lands, fill the **Tracks** tab by hand: one row
per song with `round_id`, `position` and the Spotify `track_id`. Everything
downstream — the guess form, the analytics — reads that tab and works normally.

### Pasting results manually

Two tabs, and the column order matches what you'll be copying:

**Submissions** — one row per song. `did_not_vote` is `TRUE` only for someone
Music League penalised for not voting that round (their song shows a struck-out
score and a "Did not vote" badge on the results page). Voting all zeros is
still voting, so that stays `FALSE`:
```
R04   4gzpq5DPGxSnKTe4SA8HAU   Alex Rivera    FALSE
```

A `TRUE` here means the song scores 0 on the Leaderboard, matching Music
League's standings. RoundResults still shows the points it really got — that
table describes what happened, the Leaderboard scores it.

**Votes** — one row per person per song they gave points to. You can skip the
zeros; the analytics treat a missing vote as a zero, and correctly exclude the
submitter from their own song's electorate. The last column is the song title,
there so the tab is readable — nothing computes from it:
```
R04   4gzpq5DPGxSnKTe4SA8HAU   Bojan   3   banger   Respect
```

The "electorate" for spread is whoever appears at least once in that round's
Votes rows. Since everyone distributes their whole pool somewhere, that
resolves itself naturally — but if someone voted all zeros deliberately, add
one zero row for them or they'll be treated as absent rather than unimpressed.

`track_id` is the Spotify track ID, already sitting in your **Tracks** tab from
step 2 — so in practice you paste names and points next to a VLOOKUP, or let
the bookmarklet do it.

---

## What gets computed

**RoundResults** — per song: total points, distinct voters, average per voter,
and *spread* (standard deviation across the electorate, including the zeros).
Spread is the divisiveness metric: a 12-point song that two people loved looks
very different from a 12-point song everyone mildly liked.

**GuessScores** — per person per round. Self-guesses are excluded, and "No
idea" doesn't count against you. By default scoring is **inverse frequency**:
a correct guess is worth `1 / (share of people who got it right)`, capped at 5.
Getting the one song nobody else cracked is worth five times a gimme. Switch
`GUESS_SCORING` to `'flat'` in `Config.gs` for one point per correct guess.

**Leaderboard** — the combined table, **one block per season**, latest first.
Each of the three components is normalised to a *share of that round's total*
before weighting, so rounds with different player counts stay comparable.
`combined` is an index, not a point count.

Seasons exist because a leaderboard that never resets is unwinnable by round 15
and people stop trying. Every new round joins the highest season already in the
Rounds tab; to start a new one, type the next number into the `season` cell of
its first round. Blank means season 1, so an existing sheet needs no changes.
When you share standings, say which season you're quoting — the tab holds them
all.

Default weights in `Config.gs`:

```js
const WEIGHTS = { song: 0.6, pop: 0.2, guess: 0.2 };
```

Useful self-check: because every component is a share, each round contributes
100 to the `combined` column — or 80 if nobody guessed a single song right that
round, since the guess component then has nothing to divide up. Menu item
**Sanity-check leaderboard** works that expected total out from your raw tables
and shows the per-round breakdown, so you don't have to do the arithmetic. If it
reports a shortfall, something didn't ingest.

Popularity is deliberately weighted low because it correlates strongly with
song points — the same song tends to win both, and summing them double-counts.
0.2 lets breadth break ties without dominating.

**FanMatrix** — directed affinity, **all-time, not per season**. `share` is the
fraction of all points a voter handed out that went to one particular person,
restricted to rounds where both took part.

Why this one doesn't reset: nobody wins it, and it only gets interesting as the
sample grows. One season is roughly 40 points per voter, which is mostly noise;
several seasons is a real picture of whose taste somebody likes. `GenreStats` is
all-time for the same reason. The per-season cut of both lives in **Awards**,
which does reset. Normalising matters: raw point totals just crown whoever showed
up to the most rounds.

**GenreStats** — average points per submission by genre. Caveat: Spotify puts
genres on the *artist*, not the track, and the tags are coarse and occasionally
unhinged. Always read `submissions` alongside `avg_points` — one lucky pick
shouldn't crown a genre. If you want better tags, swap in Last.fm's top tags or
MusicBrainz; the only thing to change is the enrichment step in `Rounds.gs`.

**Awards** — per season: highest scoring song, most broadly liked, most
divisive, faint praise, best detective, most recognisable taste, best deceiver,
biggest fan, most unrequited love. Most of these need a few rounds of data
before they mean anything.

"Biggest fan" and "Most unrequited love" are worked out from that season's
votes only, so every row in this table means "this season". **They will not
agree with the FanMatrix tab, and that's deliberate** — FanMatrix is all-time,
Awards is the season cut, so the same pair of people can top one and not the
other. Neither is broken.

---

## Optional: a YouTube Music playlist per round

For anyone who pays for YouTube Music rather than Spotify. `tools/yt_playlist.py`
takes the round's Spotify **track ids**, finds each one on YouTube Music, and
creates an unlisted playlist you can share. Spotify stays the source of truth —
this is an extra output, nothing else changes.

It takes ids rather than a playlist link for the reason above: Spotify stopped
handing playlist contents to non-owners. Copy the `track_id` column out of the
**Tracks** tab. Paste a playlist URL and it will tell you why that won't work.

This is **a separate thing from the Sheet**: Python, run from your own machine,
never uploaded to Apps Script.

```bash
pip install ytmusicapi
export SPOTIFY_CLIENT_ID=...  SPOTIFY_CLIENT_SECRET=...   # same app as step 2

# ids straight from the Tracks tab -- bare ids, URLs or spotify:track: URIs
python3 tools/yt_playlist.py 4gzpq5DP... 1301Wley...             # dry run
python3 tools/yt_playlist.py --ids-file round03.txt              # from a file
pbpaste | python3 tools/yt_playlist.py --title "R03" --publish   # from stdin
```

`--publish` needs a `--title`; a dry run doesn't.

**Start with the dry run** — it's the default, and it needs no YouTube login at
all. It prints what it matched and how confident it is, so you can see the
quality before authorising anything.

To publish you need a one-time YouTube login. **Use a personal Google account,
not a work one** — the auth file is browser cookies, and a work account may not
be allowed to own a YouTube channel anyway:

```bash
ytmusicapi browser                        # paste headers from music.youtube.com
mv browser.json tools/.ytmusic-auth.json  # gitignored; it's a credential
```

### When it can't find a song

Spotify → YouTube matching is genuinely fuzzy: live cuts, covers, lyric videos,
sped-up edits. The script scores every candidate on title, artist and duration,
and **refuses to publish anything if even one track looks doubtful** — it prints
the candidates instead. A playlist with one wrong song in it is worse than no
playlist, and ten tracks takes half a minute to eyeball.

To resolve one, put the video id in `tools/yt-overrides.json`:

```json
{
  "4gzpq5DPGxSnKTe4SA8HAU": { "video_id": "dQw4w9WgXcQ", "note": "live version" },
  "1301WleyT98MSxVHPZCA6M": { "omit": true, "note": "not on YouTube Music" }
}
```

Corrections are permanent and survive re-runs. `omit` drops a track that
genuinely isn't there — it gets called out in the output and noted in the
playlist description rather than quietly disappearing.

One caveat worth setting expectations on: ad-free playback comes from each
listener's own Premium subscription. Creating the playlist doesn't grant it.

---

## Why there's no Slack integration

There used to be one, posting the form link and the standings through an
incoming webhook. It's gone, and it isn't coming back on this workspace:
**DEPT's Slack doesn't allow app installs**, and an incoming webhook counts as
one. There's no personal-workspace fallback either. This is a permissions wall,
not a backlog item — no amount of rework gets past it.

If you ever run this somewhere with an unrestricted workspace, the nice version
is a proper Slack app: a slash command opening a modal with a dropdown per
song, and a Block Kit leaderboard. Worth knowing before starting that, it's a
real project rather than an afternoon — Slack wants a response within **3
seconds** and Apps Script cold starts are slower, so you'd need to ack
immediately and work asynchronously, which Apps Script handles badly; and
request-signature verification needs raw-body access, which `doPost` makes
awkward. The usual fix for both is a small Cloudflare Worker in front, which
puts back exactly the ops burden this stack exists to avoid.

---

## Tuning ideas once it's running

- **Bijection mode**: force each guesser to assign every player exactly once.
  Harder, more strategic, and you'd score partial permutations. A Google Form
  can't express the constraint, so it needs a custom UI — which, with Slack
  unavailable, means building one from scratch. Parked for that reason.
- **Theme-fit voting**: a second Form question per song, 1–5 on how well it fit
  the theme. Cheap to add, and "best song that ignored the brief" is a great
  award.
- **A "start new season" button**: right now you bump a season by typing the
  next number into the `season` cell of the Rounds tab. That's one cell a
  couple of times a year, so a menu item for it hasn't earned its place.
