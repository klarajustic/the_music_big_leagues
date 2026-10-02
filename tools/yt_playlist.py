#!/usr/bin/env python3
"""
yt_playlist.py — build a YouTube Music playlist for a round from a list of
Spotify track ids. An additional output: Spotify stays the source of truth for
submissions, track ids and all matching.

  python3 tools/yt_playlist.py 4gzpq5DP... 1301Wley...             # dry run
  python3 tools/yt_playlist.py --ids-file round03.txt              # from a file
  pbpaste | python3 tools/yt_playlist.py --title "R03" --publish   # from stdin

IT TAKES IDS, NOT A PLAYLIST URL, and that is deliberate. Since the February
2026 migration Spotify returns playlist contents only to the account that owns
the playlist, and Music League owns the round playlists — probed 2026-09-08,
401 "Valid user authentication required". Single-track lookups still work under
client credentials, so ids from anywhere (the Tracks tab, the Music League
page, a copy-paste) are enough: GET /tracks/{id} gives title, artists and
duration_ms, which is everything the matcher needs.

Ids may be bare, open.spotify.com URLs, or spotify:track: URIs — paste whatever
you have on hand.

OR, if you have copied the round playlist into your own Spotify account:

  python3 tools/yt_playlist.py --playlist https://open.spotify.com/playlist/...

That reads it directly with a one-time browser login, and the copy-the-URIs
step goes away. It only works for playlists YOU own — that is the February 2026
restriction itself, and no token type gets around it for someone else's
playlist. Client credentials still covers /tracks/{id}, so the ids path above
never triggers a login.

SETUP for --playlist, once: add this exact Redirect URI to your app in the
Spotify Developer Dashboard, or authorisation fails with INVALID_CLIENT:

  http://127.0.0.1:8888/callback

THIS IS A SEPARATE RUNTIME. Python, its own dependency, run by hand on the
operator's machine. It is not pushed to Apps Script and cannot be — clasp only
walks src/, and nothing in tools/ ever reaches the Apps Script project. Do not
try to move this into Apps Script; see the "YouTube Music playlists" task in
CLAUDE.md for the permissions findings that put it here.

WHY LOCAL, IN ONE LINE
  YouTube Data API v3 search has no songs filter and returns no duration, which
  are the two inputs the matcher depends on; ytmusicapi has both and no quota.

CREDENTIALS
  Spotify (always): SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in the
  environment — the same client-credentials app the Apps Script side uses.

  YouTube (only for --publish): a ytmusicapi auth file. A dry run needs no
  YouTube credentials at all, so you can tune against a real round before
  authenticating anything.

      pip install ytmusicapi
      ytmusicapi browser        # paste request headers from music.youtube.com
      mv browser.json tools/.ytmusic-auth.json

  Use a PERSONAL Google account, never the work one. The auth file is browser
  cookies; treat it as a credential. It is gitignored.
"""

import argparse
import base64
import http.server
import json
import os
import pathlib
import re
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser

# ---------------------------------------------------------------------------
# Tunables. Everything you would reach for while tuning lives here, so tuning
# never means editing logic.
# ---------------------------------------------------------------------------

REVIEW_THRESHOLD = 0.72        # below this a track is unresolved; --threshold overrides

W_TITLE = 0.34
W_ARTIST = 0.33
W_DURATION = 0.33

PENALTY_ARTIST_MISMATCH = 0.40  # no shared name token: a different artist is a different song
PENALTY_VARIANT = 0.25          # candidate advertises a variant the source title does not
PENALTY_VARIANT_EXACT = 0.05    # ...backed off when the runtime already matches to the second
PENALTY_USER_VIDEO = 0.05       # prefer catalogue songs over user uploads

# Duration delta (seconds) -> score. The single most discriminating signal.
DURATION_BUCKETS = ((2, 1.0), (5, 0.85), (15, 0.6))
DURATION_SCORE_FAR = 0.15
DURATION_SCORE_UNKNOWN = 0.5

VARIANTS = re.compile(
    r"\b(live|remix|remaster(ed)?|karaoke|instrumental|cover|tribute|acoustic|demo|"
    r"reprise|edit|mix|version|sped up|slowed|nightcore|8d|lofi)\b",
    re.I,
)

SEARCH_LIMIT = 12
YT_DELAY = 0.25                # ytmusicapi is unofficial; stay polite
PLAYLIST_PRIVACY = "UNLISTED"

CACHE_VERSION = 1
ROOT = pathlib.Path(__file__).resolve().parent
CACHE_DIR = ROOT / ".cache" / "yt-search"
TRACK_CACHE_DIR = ROOT / ".cache" / "spotify-track"
OVERRIDES_PATH = ROOT / "yt-overrides.json"
AUTH_PATH = pathlib.Path(os.environ.get("YTMUSIC_AUTH", ROOT / ".ytmusic-auth.json"))

# Spotify user OAuth, needed only to read your OWN playlists. Loopback with an
# explicit IP -- Spotify no longer accepts "localhost" as a redirect host.
SPOTIFY_USER_AUTH = pathlib.Path(
    os.environ.get("SPOTIFY_USER_AUTH", ROOT / ".spotify-user-auth.json"))
REDIRECT_URI = os.environ.get("SPOTIFY_REDIRECT_URI", "http://127.0.0.1:8888/callback")
SPOTIFY_SCOPES = "playlist-read-private playlist-read-collaborative"

# ---------------------------------------------------------------------------
# Scoring — lifted from Matt Weiss's hitster_yt (scripts/pipeline.py,
# score_candidate), which measured ~0.6-1% unusable matches over 616 English
# cards. The weights, the penalties and the three comments below are his
# findings, not ours; each one is a bug he hit and fixed. Reproduced with
# attribution. https://github.com/Matt-Weiss/hitster_yt
# ---------------------------------------------------------------------------


def _norm(s):
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", (s or "").lower()).split())


def clean_title(s):
    """Drop Spotify's trailing qualifier, e.g. "Temptation - Album Version".

    En and em dashes are folded to a hyphen first; the catalogue mixes them,
    and "White Wedding - Part 1" would otherwise slip through unqualified.
    """
    s = (s or "").replace("\u2013", "-").replace("\u2014", "-")
    return re.sub(r"\s+-\s+.*$", "", s).strip() or s


def _ratio(a, b):
    import difflib
    return difflib.SequenceMatcher(None, a, b).ratio()


def duration_score(cand_seconds, duration_ms):
    if not cand_seconds or not duration_ms:
        return DURATION_SCORE_UNKNOWN
    delta = abs(cand_seconds - duration_ms / 1000)
    for limit, score in DURATION_BUCKETS:
        if delta <= limit:
            return score
    return DURATION_SCORE_FAR


def score_candidate(cand, title, artists, duration_ms):
    """How likely a search result is the track we are looking for.

    Search rank alone is not enough: YouTube Music puts a 3:49 Detroit Rock
    City above the 3:36 album cut we want. Duration is what separates them.
    """
    cand_title = cand.get("title") or ""
    cand_artists = [a.get("name", "") for a in cand.get("artists") or []]

    # Compare against both the full and de-qualified title, taking the better.
    # Bracketed text is kept on purpose -- dropping it collides distinct songs,
    # since "S.O.S. (Sawed Off Shotgun)" and "S.O.S. (An Open Letter)" both
    # reduce to "s o s" and score a perfect match against the wrong track.
    title_sim = max(
        _ratio(_norm(title), _norm(cand_title)),
        _ratio(_norm(clean_title(title)), _norm(cand_title)),
    )

    want = _norm(artists[0]) if artists else ""
    got = _norm(" ".join(cand_artists))
    artist_sim = 1.0 if want and (want in got or got in want) else _ratio(want, got)
    # Character similarity is too forgiving between unrelated names: "bryan
    # adams" and "jason aldean" share enough letters to clear a ratio gate. Two
    # artists are the same act only if they share an actual name token.
    shared_token = bool(set(want.split()) & set(got.split())) if want and got else False

    dur = duration_score(cand.get("duration_seconds"), duration_ms)
    total = W_TITLE * title_sim + W_ARTIST * artist_sim + W_DURATION * dur

    if want and not shared_token:
        total -= PENALTY_ARTIST_MISMATCH

    # Penalise alternate versions the source title never mentions -- but only
    # lightly when the runtime already matches to the second. A remaster is the
    # same recording relabelled; Domino Dancing (2003 Remaster) is a one-second
    # match that the full penalty pushes below an unrelated 7:41 remix.
    src_markers = {m.group(0).lower() for m in VARIANTS.finditer(title or "")}
    cand_markers = {m.group(0).lower() for m in VARIANTS.finditer(cand_title)}
    if cand_markers - src_markers:
        total -= PENALTY_VARIANT_EXACT if dur == 1.0 else PENALTY_VARIANT

    if cand.get("resultType") == "video":
        total -= PENALTY_USER_VIDEO

    return round(total, 4)


# ---------------------------------------------------------------------------
# Spotify — source of truth
# ---------------------------------------------------------------------------


def _http_json(url, data=None, headers=None):
    req = urllib.request.Request(url, data=data, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(
            "HTTP %s from %s\n%s" % (e.code, url, e.read().decode(errors="replace")[:500])
        )
    except urllib.error.URLError as e:
        raise SystemExit("Could not reach %s: %s" % (url, e.reason))


def spotify_token():
    cid = os.environ.get("SPOTIFY_CLIENT_ID")
    secret = os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not secret:
        raise SystemExit(
            "Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in your environment.\n"
            "Same credentials as the Apps Script script properties."
        )
    auth = base64.b64encode(("%s:%s" % (cid, secret)).encode()).decode()
    body = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    return _http_json(
        "https://accounts.spotify.com/api/token",
        data=body,
        headers={
            "Authorization": "Basic " + auth,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )["access_token"]


def _token_request(payload):
    cid, secret = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not secret:
        raise SystemExit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.")
    auth = base64.b64encode(("%s:%s" % (cid, secret)).encode()).decode()
    return _http_json(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode(payload).encode(),
        headers={"Authorization": "Basic " + auth,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )


class _CallbackHandler(http.server.BaseHTTPRequestHandler):
    """Catches Spotify's redirect once, then the server stops."""

    query = None

    def do_GET(self):  # noqa: N802  (stdlib naming)
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != urllib.parse.urlparse(REDIRECT_URI).path:
            self.send_response(404)
            self.end_headers()
            return
        _CallbackHandler.query = urllib.parse.parse_qs(parsed.query)
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(b"<h2>Authorised.</h2><p>Close this tab and return to the terminal.</p>")

    def log_message(self, *_args):
        pass  # keep the console clean


def _authorise():
    """Authorisation-code flow against a loopback redirect. Runs once."""
    cid = os.environ.get("SPOTIFY_CLIENT_ID")
    if not cid:
        raise SystemExit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.")

    state = secrets.token_urlsafe(16)
    url = "https://accounts.spotify.com/authorize?" + urllib.parse.urlencode({
        "client_id": cid,
        "response_type": "code",
        "redirect_uri": REDIRECT_URI,
        "scope": SPOTIFY_SCOPES,
        "state": state,
    })

    parsed = urllib.parse.urlparse(REDIRECT_URI)
    try:
        server = http.server.HTTPServer((parsed.hostname, parsed.port or 80), _CallbackHandler)
    except OSError as e:
        raise SystemExit(
            "Could not listen on %s (%s).\n"
            "Either something else holds that port, or SPOTIFY_REDIRECT_URI is not a "
            "loopback address." % (REDIRECT_URI, e))

    print("Opening Spotify authorisation in your browser...")
    print("If it does not open, paste this in yourself:\n  %s\n" % url)
    webbrowser.open(url)

    _CallbackHandler.query = None
    while _CallbackHandler.query is None:
        server.handle_request()  # ignores favicon hits and stray paths
    server.server_close()

    q = _CallbackHandler.query
    if q.get("error"):
        raise SystemExit(
            "Spotify refused authorisation: %s\n"
            "If this is INVALID_CLIENT: Invalid redirect URI, add exactly\n  %s\n"
            "to your app's Redirect URIs in the Spotify Developer Dashboard."
            % (q["error"][0], REDIRECT_URI))
    if (q.get("state") or [None])[0] != state:
        raise SystemExit("State mismatch on the OAuth callback. Try again.")

    tok = _token_request({
        "grant_type": "authorization_code",
        "code": q["code"][0],
        "redirect_uri": REDIRECT_URI,
    })
    _save_user_token(tok)
    return tok["access_token"]


def _save_user_token(tok):
    blob = {
        "access_token": tok["access_token"],
        "expires_at": time.time() + int(tok.get("expires_in", 3600)) - 60,
    }
    if tok.get("refresh_token"):
        blob["refresh_token"] = tok["refresh_token"]
    else:  # a refresh response may omit it; keep the one already held
        try:
            blob["refresh_token"] = json.loads(SPOTIFY_USER_AUTH.read_text()).get("refresh_token")
        except (OSError, ValueError):
            pass
    SPOTIFY_USER_AUTH.write_text(json.dumps(blob, indent=2))
    try:
        SPOTIFY_USER_AUTH.chmod(0o600)  # it is a credential
    except OSError:
        pass


def spotify_user_token():
    """A token that acts as YOU. Only playlist reads need it.

    Client credentials cannot read playlists at all since February 2026 --
    not even your own, because it has no user to be the owner. Single-track
    lookups still work without it, so the ids path never triggers this.
    """
    try:
        blob = json.loads(SPOTIFY_USER_AUTH.read_text())
    except (OSError, ValueError):
        return _authorise()

    if blob.get("access_token") and blob.get("expires_at", 0) > time.time():
        return blob["access_token"]
    if blob.get("refresh_token"):
        try:
            tok = _token_request({"grant_type": "refresh_token",
                                  "refresh_token": blob["refresh_token"]})
        except SystemExit:
            return _authorise()  # revoked or expired refresh token
        _save_user_token(tok)
        return tok["access_token"]
    return _authorise()


PLAYLIST_ID = re.compile(r"playlist[/:]([A-Za-z0-9]+)")


def playlist_id_from_url(url):
    m = PLAYLIST_ID.search(url or "")
    if not m:
        raise SystemExit("Could not find a playlist id in: %s" % url)
    return m.group(1)


def spotify_playlist(url):
    """Your own playlist, read with a user token. Returns (name, [tracks]).

    Only works for playlists you own or collaborate on -- that is the whole
    February 2026 restriction, and no token type gets around it for someone
    else's playlist. Copy the round playlist into your account first.
    """
    pid = playlist_id_from_url(url)
    head = {"Authorization": "Bearer " + spotify_user_token()}

    meta = _http_json("https://api.spotify.com/v1/playlists/%s?fields=name,owner(display_name)"
                      % pid, headers=head)
    name = meta.get("name") or pid

    out, offset, total = [], 0, 1
    while offset < total:
        page = _http_json(
            "https://api.spotify.com/v1/playlists/%s/items?limit=50&offset=%d"
            "&fields=total,items(item(id,name,duration_ms,album(release_date),artists(name)))"
            % (pid, offset),
            headers=head,
        )
        total = page.get("total", 0)
        rows = page.get("items") or []
        if not rows and not out:
            raise SystemExit(
                "Spotify returned no items for '%s' (owner: %s).\n"
                "Since February 2026 only the playlist's OWNER can read its contents. "
                "Copy it into your own account and use the copy's URL."
                % (name, (meta.get("owner") or {}).get("display_name")))
        for row in rows:
            t = row.get("item") or {}
            if not t.get("id"):
                continue  # local files / unavailable tracks
            rec = {
                "spotify_id": t["id"],
                "title": t.get("name") or "",
                "artists": [a.get("name", "") for a in t.get("artists") or []],
                "duration_ms": t.get("duration_ms") or 0,
                "release_year": str((t.get("album") or {}).get("release_date") or "")[:4],
            }
            out.append(rec)
            # Warm the per-id cache so a later ids-based run costs nothing.
            TRACK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
            (TRACK_CACHE_DIR / ("%s.json" % rec["spotify_id"])).write_text(
                json.dumps(rec, indent=2))
        offset += 50
    return name, out


TRACK_ID = re.compile(r"([A-Za-z0-9]{22})")


def parse_track_id(raw):
    """Accepts a bare id, an open.spotify.com URL, or a spotify:track: URI."""
    raw = (raw or "").strip().strip(",")
    if not raw:
        return None

    # A playlist or album id is also 22 characters, so pasting a playlist URL
    # would otherwise be mined for a plausible-looking "track id" that 404s on
    # lookup. Given this script exists precisely because playlist URLs no
    # longer work, say so rather than failing three steps later.
    wrong = re.search(r"\b(playlist|album|artist|episode|show)[/:]", raw)
    if wrong:
        raise SystemExit(
            "That is a %s link, not a track id: %s\n"
            "This script takes TRACK ids -- Spotify stopped returning playlist "
            "contents to non-owners in February 2026. Ids come from the Tracks tab."
            % (wrong.group(1), raw)
        )

    m = TRACK_ID.search(raw.split("?")[0])
    if not m:
        raise SystemExit("Not a Spotify track id, URL or URI: %r" % raw)
    return m.group(1)


def collect_ids(args):
    """Ids from positional args, --ids-file, or stdin. Order is preserved."""
    raw = list(args.ids)
    if args.ids_file:
        raw += pathlib.Path(args.ids_file).read_text().split()
    if not raw and not sys.stdin.isatty():
        raw += sys.stdin.read().split()
    if not raw:
        raise SystemExit(
            "No track ids given.\n"
            "  python3 tools/yt_playlist.py <id> <id> ...\n"
            "  python3 tools/yt_playlist.py --ids-file round03.txt\n"
            "  pbpaste | python3 tools/yt_playlist.py --title 'R03'\n"
            "Ids come from the Tracks tab. A playlist URL will not work -- see the "
            "note at the top of this file."
        )
    seen, ids = set(), []
    for item in raw:
        tid = parse_track_id(item)
        if tid and tid not in seen:
            seen.add(tid)
            ids.append(tid)
    return ids


def spotify_tracks(ids):
    """Returns [{spotify_id, title, artists, duration_ms}], one lookup per id.

    GET /tracks (batch) was removed in February 2026, so this is one request
    each -- 19 calls for a 19-track round, which is nothing locally. Cached,
    because a track's title and duration never change, and that makes a
    re-run while tuning entirely offline.
    """
    head = None
    out = []
    for track_id in ids:
        cached = TRACK_CACHE_DIR / ("%s.json" % track_id)
        if cached.exists():
            try:
                out.append(json.loads(cached.read_text()))
                continue
            except (ValueError, OSError):
                pass

        if head is None:  # only authenticate if something is actually missing
            head = {"Authorization": "Bearer " + spotify_token()}
        t = _http_json("https://api.spotify.com/v1/tracks/%s" % track_id, headers=head)
        row = {
            "spotify_id": t.get("id") or track_id,
            "title": t.get("name") or "",
            "artists": [a.get("name", "") for a in t.get("artists") or []],
            "duration_ms": t.get("duration_ms") or 0,
            "release_year": str((t.get("album") or {}).get("release_date") or "")[:4],
        }
        TRACK_CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cached.write_text(json.dumps(row, indent=2))
        out.append(row)
    return out


# ---------------------------------------------------------------------------
# YouTube Music candidates
# ---------------------------------------------------------------------------


def _cache_path(spotify_id):
    return CACHE_DIR / ("%s.json" % spotify_id)


def _cache_read(spotify_id):
    p = _cache_path(spotify_id)
    if not p.exists():
        return None
    try:
        blob = json.loads(p.read_text())
    except (ValueError, OSError):
        return None
    return blob.get("candidates") if blob.get("version") == CACHE_VERSION else None


def _cache_write(spotify_id, query, candidates):
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    _cache_path(spotify_id).write_text(
        json.dumps({"version": CACHE_VERSION, "query": query, "candidates": candidates}, indent=2)
    )


def candidates_for(yt, track, refresh=False):
    """Raw search results for a track, cached.

    The cache holds the CANDIDATES, not the match. Scoring happens on read, so
    changing a weight or the threshold is a re-derivation over local files
    rather than another pass over YouTube — which is what makes tuning against
    a real round cheap. (hitster_yt learned the same lesson the other way
    round, having once cached a derived year it then could not re-derive.)

    Unlike hitster_yt we always run both the songs-filtered and the unfiltered
    search rather than widening only on a low score: it costs one extra request
    per track, and it keeps the cache independent of the threshold.
    """
    cached = None if refresh else _cache_read(track["spotify_id"])
    if cached is not None:
        return cached

    artist = track["artists"][0] if track["artists"] else ""
    query = ("%s %s" % (clean_title(track["title"]), artist)).strip()

    results = list(yt.search(query, filter="songs", limit=SEARCH_LIMIT) or [])
    time.sleep(YT_DELAY)
    # The songs filter only covers the music catalogue, and some tracks live
    # there only as an uploaded video.
    results += list(yt.search(query, limit=SEARCH_LIMIT) or [])
    time.sleep(YT_DELAY)

    seen, candidates = set(), []
    for c in results:
        vid = c.get("videoId")
        if not vid or vid in seen:
            continue
        seen.add(vid)
        candidates.append({
            "videoId": vid,
            "title": c.get("title"),
            "artists": [{"name": a.get("name")} for a in c.get("artists") or []],
            "duration_seconds": c.get("duration_seconds"),
            "duration": c.get("duration"),
            "resultType": c.get("resultType"),
        })

    _cache_write(track["spotify_id"], query, candidates)
    return candidates


def rank(track, candidates):
    scored = [(score_candidate(c, track["title"], track["artists"], track["duration_ms"]), c)
              for c in candidates]
    scored.sort(key=lambda p: p[0], reverse=True)
    return scored


# ---------------------------------------------------------------------------
# Overrides — a correction outlives a re-run, because a round does
# ---------------------------------------------------------------------------


def load_overrides():
    if not OVERRIDES_PATH.exists():
        return {}
    try:
        return json.loads(OVERRIDES_PATH.read_text())
    except ValueError as e:
        raise SystemExit("%s is not valid JSON: %s" % (OVERRIDES_PATH, e))


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------


def tracks_tsv(tracks, round_id):
    """The Tracks tab, tab-separated, ready to paste at A2.

    Columns match HEADERS.Tracks exactly. artist_ids, genres and
    spotify_popularity stay blank: popularity was removed from the Spotify API
    in February 2026, and genres are the open question in CLAUDE.md. Nothing
    downstream needs either -- the guess form is built from title and artist.
    """
    rows = []
    for i, t in enumerate(tracks, start=1):
        rows.append("\t".join([
            round_id,
            str(i),
            t["spotify_id"],
            t.get("title", ""),
            ", ".join(t.get("artists") or []),
            "",                              # artist_ids
            "",                              # genres
            t.get("release_year", ""),
            "",                              # spotify_popularity
        ]))
    return "\n".join(rows)


def _clip(s, n):
    s = s or ""
    return s if len(s) <= n else s[: n - 1] + "\u2026"


def print_table(rows):
    print("%-3s %-34s %-24s %6s  %s" % ("#", "SPOTIFY", "MATCHED", "SCORE", "STATE"))
    print("-" * 96)
    for i, r in enumerate(rows, 1):
        src = "%s - %s" % (_clip(r["track"]["title"], 20),
                           _clip(r["track"]["artists"][0] if r["track"]["artists"] else "", 12))
        got = _clip(r["candidate"]["title"], 24) if r["candidate"] else "(nothing)"
        score = "%.2f" % r["score"] if r["candidate"] else "  -  "
        print("%-3d %-34s %-24s %6s  %s" % (i, _clip(src, 34), got, score, r["state"]))


def print_candidates(rows, show):
    print("\nUnresolved tracks. Pick a videoId and put it in %s:\n" % OVERRIDES_PATH.name)
    for r in rows:
        t = r["track"]
        print("  %s - %s   [%s]  %s" % (
            t["title"], ", ".join(t["artists"]), t["spotify_id"],
            "%d:%02d" % divmod(round(t["duration_ms"] / 1000), 60)))
        if not r["scored"]:
            print("      no candidates at all\n")
            continue
        for score, c in r["scored"][:show]:
            print("      %.2f  %-11s  %-40s  %-24s  %s" % (
                score, c["videoId"], _clip(c["title"], 40),
                _clip(", ".join(a["name"] for a in c["artists"]), 24),
                c.get("duration") or "?"))
        print()
    print("  Format: {\"<spotify_id>\": {\"video_id\": \"<videoId>\", \"note\": \"why\"}}")
    print("  Or, if the track genuinely is not on YouTube Music:")
    print("         {\"<spotify_id>\": {\"omit\": true, \"note\": \"why\"}}\n")


# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser(
        description="Build a YouTube Music playlist from a list of Spotify track ids.",
        epilog="Dry run is the default; nothing is created without --publish.",
    )
    ap.add_argument("ids", nargs="*", metavar="TRACK_ID",
                    help="Spotify track ids, URLs or URIs (or use --ids-file / stdin)")
    ap.add_argument("--ids-file", help="file of track ids, whitespace- or newline-separated")
    ap.add_argument("--playlist", metavar="URL",
                    help="read ids from a Spotify playlist YOU OWN (one-time browser login)")
    ap.add_argument("--tracks-tsv", action="store_true",
                    help="print the Tracks tab for a round and stop (needs --round)")
    ap.add_argument("--round", metavar="R08",
                    help="round_id to stamp on --tracks-tsv rows")
    ap.add_argument("--publish", action="store_true",
                    help="actually create the playlist (default: dry run)")
    ap.add_argument("--dry-run", action="store_true",
                    help="match and report without creating anything (the default)")
    ap.add_argument("--title", help="playlist title (default: the Spotify playlist's name)")
    ap.add_argument("--threshold", type=float, default=REVIEW_THRESHOLD,
                    help="confidence floor, default %.2f" % REVIEW_THRESHOLD)
    ap.add_argument("--refresh", action="store_true", help="ignore the search cache")
    ap.add_argument("--show", type=int, default=3,
                    help="candidates to list per unresolved track, default 3")
    args = ap.parse_args()

    # --tracks-tsv never touches YouTube, so it must not require ytmusicapi.
    if args.tracks_tsv:
        if not args.round:
            raise SystemExit('--tracks-tsv needs a round, e.g. --round R08')
        tracks = (spotify_playlist(args.playlist)[1] if args.playlist
                  else spotify_tracks(collect_ids(args)))
        if not tracks:
            raise SystemExit("No tracks resolved.")
        print("# Tracks tab, %d rows -- paste at cell A2" % len(tracks), file=sys.stderr)
        print("# Then add a Rounds row:  %s | %s | <theme> | | | | <deadline> | open | 1"
              % (args.round, args.round.lstrip("Rr").lstrip("0") or "1"), file=sys.stderr)
        print(tracks_tsv(tracks, args.round))
        return 0

    playlist_name = None
    if args.playlist:
        playlist_name, tracks_from_playlist = spotify_playlist(args.playlist)
        print("Spotify playlist: %s (%d tracks)" % (playlist_name, len(tracks_from_playlist)))
    else:
        tracks_from_playlist = None
        ids = collect_ids(args)

    if args.publish and not args.title and not playlist_name:
        raise SystemExit('--publish needs a --title, e.g. --title "Songs about cities (R03)".\n'
                         "(Not needed with --playlist: the playlist's own name is used.)")

    try:
        from ytmusicapi import YTMusic
    except ImportError:
        raise SystemExit("ytmusicapi is not installed.  pip install ytmusicapi")

    # Search needs no credentials; only publishing does. That is what makes a
    # dry run possible before authenticating anything.
    if args.publish:
        if not AUTH_PATH.exists():
            raise SystemExit(
                "No YouTube auth at %s.\n"
                "  pip install ytmusicapi && ytmusicapi browser\n"
                "  mv browser.json %s\n"
                "Use a personal Google account, not the work one." % (AUTH_PATH, AUTH_PATH)
            )
        yt = YTMusic(str(AUTH_PATH))
    else:
        yt = YTMusic()

    tracks = tracks_from_playlist if tracks_from_playlist is not None else spotify_tracks(ids)
    if not tracks:
        raise SystemExit("No tracks resolved.")
    name = args.title or playlist_name or "Music League round"
    print("%d track(s) from Spotify\n" % len(tracks))

    overrides = load_overrides()
    rows = []
    for track in tracks:
        ov = overrides.get(track["spotify_id"]) or {}
        scored = rank(track, candidates_for(yt, track, args.refresh))

        if ov.get("omit"):
            rows.append({"track": track, "candidate": None, "score": 0.0,
                         "scored": scored, "state": "OMITTED (override)", "ok": True,
                         "video_id": None})
            continue
        if ov.get("video_id"):
            picked = next((c for _, c in scored if c["videoId"] == ov["video_id"]),
                          {"title": ov.get("note") or "(override)", "artists": []})
            rows.append({"track": track, "candidate": picked, "score": 1.0,
                         "scored": scored, "state": "override", "ok": True,
                         "video_id": ov["video_id"]})
            continue

        if scored and scored[0][0] >= args.threshold:
            score, c = scored[0]
            rows.append({"track": track, "candidate": c, "score": score, "scored": scored,
                         "state": "ok", "ok": True, "video_id": c["videoId"]})
        else:
            score = scored[0][0] if scored else 0.0
            rows.append({"track": track, "candidate": scored[0][1] if scored else None,
                         "score": score, "scored": scored,
                         "state": "UNRESOLVED", "ok": False, "video_id": None})

    print_table(rows)

    unresolved = [r for r in rows if not r["ok"]]
    omitted = [r for r in rows if r["video_id"] is None and r["ok"]]

    if unresolved:
        print_candidates(unresolved, args.show)
        print("%d of %d track(s) below %.2f. Nothing created — a playlist with one "
              "wrong song is worse than no playlist." % (len(unresolved), len(rows), args.threshold))
        return 1

    video_ids = [r["video_id"] for r in rows if r["video_id"]]
    print("\n%d matched, %d omitted by override." % (len(video_ids), len(omitted)))

    if not args.publish:
        print("\nDry run. Re-run with --publish to create it.")
        return 0

    desc = "Music League — %s. %d tracks, matched from Spotify ids." % (name, len(video_ids))
    if omitted:
        desc += " Not on YouTube Music: %s." % "; ".join(
            "%s - %s" % (r["track"]["title"], ", ".join(r["track"]["artists"])) for r in omitted)

    result = yt.create_playlist(name, desc,
                                privacy_status=PLAYLIST_PRIVACY, video_ids=video_ids)
    if not isinstance(result, str):
        raise SystemExit("Playlist creation failed: %s" % json.dumps(result)[:500])

    print("\nCreated (%s): https://music.youtube.com/playlist?list=%s"
          % (PLAYLIST_PRIVACY.lower(), result))
    print("Paste that into the yt_playlist_url column of the Rounds tab.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
