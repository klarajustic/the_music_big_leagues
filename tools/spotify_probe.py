#!/usr/bin/env python3
"""
spotify_probe.py — what can client credentials still reach after the
February 2026 Web API migration?

    export SPOTIFY_CLIENT_ID=...  SPOTIFY_CLIENT_SECRET=...
    python3 tools/spotify_probe.py             # what can client credentials reach?
    python3 tools/spotify_probe.py --genres    # is artist.genres still populated?

Stdlib only, read-only, no dependencies. Diagnostic — delete it once the
migration question is settled.

It answers three separate questions, and they have different consequences:

  A. Does client credentials still get a token at all?
  B. Can we read a playlist we do not own?          -> gates the Tracks tab
  C. Can we still look up a single track / artist?  -> gates every fallback,
     because if ids can come from somewhere else, enrichment still works.

If EVERYTHING 403s, suspect the account rather than the endpoints: Development
Mode apps now require the owner to hold Spotify Premium.
"""

import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

PLAYLIST = os.environ.get("PROBE_PLAYLIST", "6N6cCy60FSQNTm1kzZPRXU")
API = "https://api.spotify.com/v1"


def get(path, token):
    """Returns (status, parsed_body_or_text)."""
    req = urllib.request.Request(API + path, headers={"Authorization": "Bearer " + token})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:300]
    except urllib.error.URLError as e:
        return 0, "network error: %s" % e.reason


def token():
    cid, secret = os.environ.get("SPOTIFY_CLIENT_ID"), os.environ.get("SPOTIFY_CLIENT_SECRET")
    if not cid or not secret:
        sys.exit("Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET first.")
    auth = base64.b64encode(("%s:%s" % (cid, secret)).encode()).decode()
    req = urllib.request.Request(
        "https://accounts.spotify.com/api/token",
        data=urllib.parse.urlencode({"grant_type": "client_credentials"}).encode(),
        headers={"Authorization": "Basic " + auth,
                 "Content-Type": "application/x-www-form-urlencoded"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode())["access_token"]
    except urllib.error.HTTPError as e:
        sys.exit("A. TOKEN FAILED: HTTP %s\n%s\n\nClient credentials itself is refused. "
                 "Nothing below can work." % (e.code, e.read().decode(errors="replace")[:300]))


def show(label, status, body, note=""):
    ok = "OK " if status == 200 else "FAIL"
    print("  [%s] %-3s  %s" % (ok, status, label))
    if note:
        print("         %s" % note)
    if status != 200:
        msg = body.get("error", {}).get("message") if isinstance(body, dict) else body
        print("         %s" % str(msg)[:200])
    return status == 200


# Canonical, heavily-tagged artists. If genres come back empty for ALL of
# these, the field is dead in practice whatever the schema still says.
WELL_TAGGED = [
    ("Radiohead", "4Z8W4fKeB5YxbusRsdQVPb"),
    ("Metallica", "2ye2Wgw4gimLv2eAKyk1NB"),
    ("Daft Punk", "4tZwfgrHOc3mvqYlEYSvVi"),
    ("Miles Davis", "0kbYTNQb4Pb1rPbbaF0pT4"),
    ("Beyonce", "6vWDO969PvNqNYHIOW5v0m"),
]


def probe_genres():
    """Is artist.genres still populated for anyone?

    The February 2026 changelog does not remove it, but the Artist reference
    marks it Deprecated, and one null observation is not evidence. Five
    canonical artists is.
    """
    tok = token()
    print("ARTIST GENRES\n")
    populated, empty, failed = 0, 0, 0
    for name, aid in WELL_TAGGED:
        st, body = get("/artists/%s" % aid, tok)
        if st != 200:
            failed += 1
            print("  [FAIL] %-3s %-12s %s" % (st, name, str(body)[:120]))
            continue
        g = body.get("genres")
        if g:
            populated += 1
            print("  [OK  ] 200 %-12s %s" % (body.get("name") or name, json.dumps(g)))
        else:
            empty += 1
            print("  [EMPTY]    %-12s genres=%s  (schema says [] when unclassified)"
                  % (body.get("name") or name, json.dumps(g)))

    print("\n" + "=" * 72)
    if populated:
        print("  Genres are ALIVE for %d of %d. GenreStats keeps its source; the null"
              % (populated, len(WELL_TAGGED)))
        print("  you saw is that artist being unclassified, not the field being gone.")
    elif empty and not failed:
        print("  Genres are EMPTY for all %d well-tagged artists. The field still exists" % empty)
        print("  but carries nothing, so per-artist enrichment is pointless work and")
        print("  GenreStats has no source. Needs a replacement tagger.")
    else:
        print("  Inconclusive: %d lookups failed outright. Fix that first." % failed)
    print()


def main():
    if "--genres" in sys.argv:
        return probe_genres()
    print("Probing playlist %s\n" % PLAYLIST)
    tok = token()
    print("A. CLIENT CREDENTIALS")
    print("  [OK ] 200  token acquired\n")

    print("B. PLAYLIST ACCESS  (gates the Tracks tab)")
    st, body = get("/playlists/%s?fields=name,owner(display_name,id),items(total)" % PLAYLIST, tok)
    meta_ok = show("GET /playlists/{id}  (metadata)", st, body)
    if meta_ok:
        print("         name  : %s" % body.get("name"))
        print("         owner : %s" % json.dumps(body.get("owner")))
        print("         items : %s" % json.dumps(body.get("items"))[:200])

    st, body = get("/playlists/%s/items?limit=5"
                   "&fields=total,items(item(id,name,album(release_date),artists(id,name)))"
                   % PLAYLIST, tok)
    items_ok = show("GET /playlists/{id}/items  (contents, NEW endpoint)", st, body)
    if items_ok:
        got = (body or {}).get("items") or []
        print("         total returned : %s" % body.get("total"))
        print("         items in page  : %d" % len(got))
        if got:
            print("         first item     : %s" % json.dumps(got[0])[:300])
        else:
            print("         EMPTY — metadata-only response rather than a 403.")

    st, body = get("/playlists/%s/tracks?limit=1" % PLAYLIST, tok)
    show("GET /playlists/{id}/tracks  (OLD endpoint, expected gone)", st, body)

    print("\nC. SINGLE-OBJECT LOOKUPS  (gates every fallback)")
    # A stable, always-available track: Rick Astley, Never Gonna Give You Up.
    probe_track = os.environ.get("PROBE_TRACK", "4PTG3Z6ehGkBFwjybzWkR8")
    st, body = get("/tracks/%s" % probe_track, tok)
    track_ok = show("GET /tracks/{id}", st, body)
    artist_id = None
    if track_ok:
        artist_id = (body.get("artists") or [{}])[0].get("id")
        print("         name          : %s" % body.get("name"))
        print("         duration_ms   : %s" % body.get("duration_ms"))
        print("         album.release : %s" % (body.get("album") or {}).get("release_date"))
        print("         popularity    : %s  (removed in Feb 2026; None is expected)"
              % body.get("popularity"))

    if artist_id:
        st, body = get("/artists/%s" % artist_id, tok)
        if show("GET /artists/{id}", st, body):
            print("         name   : %s" % body.get("name"))
            print("         genres : %s" % json.dumps(body.get("genres")))

        st, body = get("/artists?ids=%s" % artist_id, tok)
        show("GET /artists?ids=  (batch, expected gone)", st, body)

    print("\n" + "=" * 72)
    print("READING THIS")
    print("=" * 72)
    if items_ok:
        print("  Playlist contents ARE readable. The migration is a rename only —")
        print("  fix the endpoint and field names and carry on.")
    elif meta_ok:
        print("  Metadata yes, contents no. This is the ownership rule: contents come")
        print("  back only for playlists the token's user owns or collaborates on, and")
        print("  client credentials has no user. Music League owns these playlists, so")
        print("  no amount of reworking this call will read them.")
    elif track_ok:
        print("  The playlist is unreadable but single lookups work. Every fallback that")
        print("  sources track ids elsewhere stays viable, enrichment included.")
    else:
        print("  Everything failed, including single lookups. Suspect the ACCOUNT, not")
        print("  the endpoints: Development Mode apps now require the app owner to hold")
        print("  an active Spotify Premium subscription, and dev mode allows at most")
        print("  five allowlisted users. Check the Developer Dashboard before anything.")
    print()


if __name__ == "__main__":
    main()
