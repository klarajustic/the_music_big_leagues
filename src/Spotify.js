/**
 * Spotify — pulls the round playlist and enriches it with artist genres and
 * release year.
 *
 * Uses the Client Credentials flow: no user login.
 *
 * FEBRUARY 2026 MIGRATION. Three things changed here:
 *
 *   1. GET /playlists/{id}/tracks became GET /playlists/{id}/items, and the
 *      wrapper field inside each row went from `track` to `item`.
 *   2. Track `popularity` was removed from the API outright. The Tracks tab
 *      still has a spotify_popularity column; it is written empty now.
 *      Nothing reads it — see the note on that column in CLAUDE.md.
 *   3. Batch lookups (GET /artists?ids=) were removed. fetchArtistGenres_
 *      now issues one request per artist.
 *
 * UNRESOLVED, AND IT GATES THIS WHOLE FILE: /playlists/{id}/items returns
 * contents only for playlists the token's user owns or collaborates on, and
 * client credentials has no user. Music League owns the round playlists. Run
 * tools/spotify_probe.py before trusting anything here against a real round.
 *
 * Note: genres in Spotify's API live on the ARTIST, not the track, and they
 * are coarse. Genre stats are directional, not gospel.
 */

function spotifyToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('sp_token');
  if (cached) return cached;

  const id = getProp_('SPOTIFY_CLIENT_ID', true);
  const secret = getProp_('SPOTIFY_CLIENT_SECRET', true);

  const res = UrlFetchApp.fetch('https://accounts.spotify.com/api/token', {
    method: 'post',
    headers: { Authorization: 'Basic ' + Utilities.base64Encode(id + ':' + secret) },
    payload: { grant_type: 'client_credentials' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Spotify auth failed (' + res.getResponseCode() + '): ' + res.getContentText());
  }
  const body = JSON.parse(res.getContentText());
  cache.put('sp_token', body.access_token, Math.max(60, body.expires_in - 120));
  return body.access_token;
}

function spotifyGet_(path, attempt) {
  const res = UrlFetchApp.fetch('https://api.spotify.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + spotifyToken_() },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 429) {
    // Bounded on purpose. Per-artist genre lookups turned one batched call
    // into 20-40, so a rate-limit loop is now plausible, and retrying forever
    // only spends the 6-minute execution budget before failing anyway.
    const tries = attempt || 1;
    if (tries >= 4) {
      throw new Error('Spotify rate-limited GET ' + path + ' after ' + tries + ' attempts.');
    }
    Utilities.sleep(2000 * tries);
    return spotifyGet_(path, tries + 1);
  }
  if (code !== 200) {
    throw new Error('Spotify GET ' + path + ' failed (' + code + '): ' + res.getContentText());
  }
  return JSON.parse(res.getContentText());
}

function playlistIdFromUrl_(url) {
  const m = String(url).match(/playlist[/:]([A-Za-z0-9]+)/);
  if (!m) throw new Error('Could not find a playlist id in: ' + url);
  return m[1];
}

/**
 * Confirmed by probe on 2026-09-08: GET /playlists/{id}/items returns 401
 * "Valid user authentication required" for a playlist owned by someone else,
 * while the playlist's metadata still returns 200. Music League ("ML Spotify")
 * owns the round playlists, so this path cannot work as-is.
 */
const PLAYLIST_UNREADABLE_ =
  'Spotify will not return this playlist\'s contents.\n\n' +
  'Since the February 2026 API migration, playlist contents come back only to ' +
  'the account that owns the playlist. Music League owns the round playlists, ' +
  'so there is nothing to fix in the credentials or the URL.\n\n' +
  'The round track list has to come from somewhere else. See CLAUDE.md, ' +
  '"Spotify playlist ingest", for the options and their status.';

/** Returns [{position, track_id, title, artist, artist_ids, release_year}] */
function fetchPlaylistTracks_(playlistUrl) {
  const id = playlistIdFromUrl_(playlistUrl);
  const out = [];
  let offset = 0;
  let total = 1;

  while (offset < total) {
    // /items, not /tracks; and each row wraps the track in `item`, not `track`.
    let page;
    try {
      page = spotifyGet_('/playlists/' + id + '/items?limit=50&offset=' + offset +
        '&fields=total,items(item(id,name,album(release_date),artists(id,name)))');
    } catch (e) {
      // Measured: 401 "Valid user authentication required" for a playlist we
      // do not own. Don't let that surface as a raw HTTP error -- it looks
      // like a credentials problem, and it is not one.
      if (String(e).indexOf('(401)') !== -1 || String(e).indexOf('(403)') !== -1) {
        throw new Error(PLAYLIST_UNREADABLE_);
      }
      throw e;
    }
    total = page.total;
    const rows = page.items || [];

    // Belt and braces: if it ever degrades to an empty list instead of an
    // error, that must not quietly create a round with zero tracks.
    if (!rows.length && !out.length) {
      throw new Error(PLAYLIST_UNREADABLE_);
    }

    rows.forEach(function (row) {
      const t = row.item;
      if (!t || !t.id) return; // local files / unavailable tracks
      out.push({
        position: out.length + 1,
        track_id: t.id,
        title: t.name,
        artist: t.artists.map(function (a) { return a.name; }).join(', '),
        artist_ids: t.artists.map(function (a) { return a.id; }).filter(String),
        release_year: String(t.album && t.album.release_date || '').slice(0, 4)
      });
    });
    offset += 50;
  }
  return out;
}

/**
 * Genres for a list of artist ids. Returns {artistId: [genres]}.
 *
 * One request per artist since February 2026 removed GET /artists?ids=. A
 * 19-track round is 20-40 sequential calls, so roughly 10-20 seconds — well
 * inside the 6-minute execution limit, but no longer free. If a round ever
 * does time out, the fix is caching genres per artist across rounds (a league
 * reuses artists constantly), not restoring the batch call: it is gone.
 *
 * One artist failing must not lose the whole round, so a failed lookup yields
 * no genres rather than throwing.
 */
function fetchArtistGenres_(artistIds) {
  const unique = [];
  artistIds.forEach(function (id) {
    if (id && unique.indexOf(id) === -1) unique.push(id);
  });

  const map = {};
  unique.forEach(function (id) {
    try {
      const a = spotifyGet_('/artists/' + id);
      if (a && a.id) map[a.id] = a.genres || [];
    } catch (e) {
      Logger.log('Genre lookup failed for artist ' + id + ': ' + e);
      map[id] = [];
    }
  });
  return map;
}
