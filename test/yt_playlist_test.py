"""
Tests for the scorer in tools/yt_playlist.py.

Every case here is a mistake hitster_yt already made and fixed. The scorer was
lifted from it, so these exist to prove the lift is faithful — if someone
retunes a weight and one of these flips, the retune broke a known case.

    npm run test:py
"""

import pathlib
import sys
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent / "tools"))

from yt_playlist import (  # noqa: E402
    REVIEW_THRESHOLD,
    clean_title,
    duration_score,
    parse_track_id,
    playlist_id_from_url,
    rank,
    score_candidate,
)


def cand(title, artist, seconds, result_type="song"):
    return {
        "videoId": "v_" + title[:8].replace(" ", ""),
        "title": title,
        "artists": [{"name": artist}],
        "duration_seconds": seconds,
        "resultType": result_type,
    }


class DurationBuckets(unittest.TestCase):
    def test_buckets(self):
        for delta, want in ((0, 1.0), (2, 1.0), (3, 0.85), (5, 0.85), (10, 0.6), (15, 0.6), (60, 0.15)):
            self.assertEqual(duration_score(200 + delta, 200_000), want, "delta %ds" % delta)

    def test_unknown_duration_is_neutral(self):
        self.assertEqual(duration_score(None, 200_000), 0.5)
        self.assertEqual(duration_score(200, 0), 0.5)


class CleanTitle(unittest.TestCase):
    def test_strips_trailing_qualifier(self):
        self.assertEqual(clean_title("Temptation - Album Version Radio Edit"), "Temptation")

    def test_folds_en_and_em_dashes(self):
        # "White Wedding - Part 1" finds one 2005 recording; plain finds 42.
        self.assertEqual(clean_title("White Wedding – Part 1"), "White Wedding")
        self.assertEqual(clean_title("White Wedding — Part 1"), "White Wedding")

    def test_keeps_bracketed_text(self):
        self.assertEqual(clean_title("S.O.S. (Sawed Off Shotgun)"), "S.O.S. (Sawed Off Shotgun)")

    def test_never_returns_empty(self):
        self.assertEqual(clean_title(" - everything"), " - everything")


class DurationSeparatesTakes(unittest.TestCase):
    """YouTube Music ranks a 3:49 Detroit Rock City above the 3:36 album cut."""

    def test_album_cut_beats_higher_ranked_wrong_take(self):
        title, artists, ms = "Detroit Rock City", ["Kiss"], 216_000
        right = score_candidate(cand(title, "Kiss", 216), title, artists, ms)
        wrong = score_candidate(cand(title, "Kiss", 229), title, artists, ms)
        self.assertGreater(right, wrong)
        self.assertGreaterEqual(right, REVIEW_THRESHOLD)


class BracketedTitlesDoNotCollide(unittest.TestCase):
    """Stripping brackets reduces both of these to "s o s"."""

    def test_distinct_songs_score_differently(self):
        title, artists, ms = "S.O.S. (Sawed Off Shotgun)", ["Glass Animals"], 200_000
        right = score_candidate(cand(title, "Glass Animals", 200), title, artists, ms)
        wrong = score_candidate(
            cand("S.O.S. (An Open Letter)", "Glass Animals", 200), title, artists, ms)
        self.assertGreater(right, wrong)


class ArtistMatchIsByToken(unittest.TestCase):
    """"bryan adams" and "jason aldean" clear a character-ratio gate."""

    def test_wrong_artist_is_rejected(self):
        title, artists, ms = "Heaven", ["Bryan Adams"], 240_000
        wrong = score_candidate(cand(title, "Jason Aldean", 240), title, artists, ms)
        self.assertLess(wrong, REVIEW_THRESHOLD)

    def test_right_artist_is_accepted(self):
        title, artists, ms = "Heaven", ["Bryan Adams"], 240_000
        right = score_candidate(cand(title, "Bryan Adams", 240), title, artists, ms)
        self.assertGreaterEqual(right, REVIEW_THRESHOLD)


class VariantPenaltyBacksOff(unittest.TestCase):
    """A remaster is the same recording relabelled; a 7:41 remix is not."""

    def test_exact_duration_remaster_beats_unrelated_remix(self):
        title, artists, ms = "Domino Dancing", ["Pet Shop Boys"], 250_000
        remaster = score_candidate(
            cand("Domino Dancing (2003 Remaster)", "Pet Shop Boys", 250), title, artists, ms)
        remix = score_candidate(
            cand("Domino Dancing (Disco Mix)", "Pet Shop Boys", 461), title, artists, ms)
        self.assertGreater(remaster, remix)
        self.assertGreaterEqual(remaster, REVIEW_THRESHOLD)

    def test_variant_the_source_asked_for_is_not_penalised(self):
        title, artists, ms = "Whole Lotta Love (Live)", ["Led Zeppelin"], 300_000
        live = score_candidate(
            cand("Whole Lotta Love (Live)", "Led Zeppelin", 300), title, artists, ms)
        self.assertGreaterEqual(live, REVIEW_THRESHOLD)


class CataloguePreferredOverUserUpload(unittest.TestCase):
    def test_video_result_type_is_penalised(self):
        title, artists, ms = "Rebel Rebel", ["David Bowie"], 270_000
        song = score_candidate(cand(title, "David Bowie", 270, "song"), title, artists, ms)
        video = score_candidate(cand(title, "David Bowie", 270, "video"), title, artists, ms)
        self.assertGreater(song, video)


class Ranking(unittest.TestCase):
    def test_rank_sorts_best_first(self):
        track = {"title": "Blue Monday", "artists": ["New Order"], "duration_ms": 450_000}
        scored = rank(track, [
            cand("Blue Monday", "New Order", 300),
            cand("Blue Monday", "New Order", 450),
            cand("Blue Monday", "Orgy", 450),
        ])
        self.assertEqual([s for s, _ in scored], sorted([s for s, _ in scored], reverse=True))
        self.assertEqual(scored[0][1]["duration_seconds"], 450)
        self.assertEqual(scored[0][1]["artists"][0]["name"], "New Order")


class TrackIdParsing(unittest.TestCase):
    """The input seam. Ids arrive by copy-paste, so accept what people paste."""

    ID = "4gzpq5DPGxSnKTe4SA8HAU"

    def test_bare_id(self):
        self.assertEqual(parse_track_id(self.ID), self.ID)

    def test_open_spotify_url_with_query(self):
        self.assertEqual(
            parse_track_id("https://open.spotify.com/track/%s?si=deadbeef" % self.ID), self.ID)

    def test_uri(self):
        self.assertEqual(parse_track_id("spotify:track:%s" % self.ID), self.ID)

    def test_surrounding_whitespace_and_commas(self):
        self.assertEqual(parse_track_id("  %s, " % self.ID), self.ID)

    def test_blank_is_skipped_not_an_error(self):
        self.assertIsNone(parse_track_id("   "))

    def test_garbage_is_rejected_loudly(self):
        with self.assertRaises(SystemExit):
            parse_track_id("not-an-id")

    def test_playlist_url_is_rejected_with_an_explanation(self):
        # The mistake people will actually make. A playlist id is also 22
        # chars, so without this guard it is mined into a track id that 404s.
        with self.assertRaises(SystemExit) as e:
            parse_track_id("https://open.spotify.com/playlist/6N6cCy60FSQNTm1kzZPRXU")
        self.assertIn("playlist link", str(e.exception))
        self.assertIn("TRACK ids", str(e.exception))

    def test_album_url_is_rejected_too(self):
        with self.assertRaises(SystemExit):
            parse_track_id("spotify:album:6N6cCy60FSQNTm1kzZPRXU")


class PlaylistUrlParsing(unittest.TestCase):
    """--playlist takes the URL of a copy you own."""

    PID = "7tgbHrLo7vkU5gkNzxjbGM"

    def test_open_spotify_url(self):
        self.assertEqual(
            playlist_id_from_url("https://open.spotify.com/playlist/%s?si=x" % self.PID), self.PID)

    def test_uri(self):
        self.assertEqual(playlist_id_from_url("spotify:playlist:%s" % self.PID), self.PID)

    def test_track_url_is_not_a_playlist(self):
        with self.assertRaises(SystemExit):
            playlist_id_from_url("https://open.spotify.com/track/4gzpq5DPGxSnKTe4SA8HAU")


if __name__ == "__main__":
    unittest.main()
