"""align.py の単体テスト (標準ライブラリのみ。align.bats から実行される)。"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from align import (  # noqa: E402
    UNKNOWN,
    Turn,
    build_utterances,
    fmt_ts,
    groq_segments,
    Utterance,
    merge_tracks,
    pick_clips,
    relabel,
    render_markdown,
    speaker_for,
    speech_spans,
    to_source_time,
)


def seg(start, end, words, **kw):
    return {
        "start": start,
        "end": end,
        "text": "".join(w for w, _, _ in words),
        "words": [{"word": w, "start": s, "end": e} for w, s, e in words],
        **kw,
    }


class SpeakerForTest(unittest.TestCase):
    def test_picks_max_overlap(self):
        turns = [Turn(0, 2, "A"), Turn(1.5, 5, "B")]
        self.assertEqual(speaker_for(1.0, 1.4, turns), "A")
        self.assertEqual(speaker_for(1.6, 3.0, turns), "B")

    def test_nearest_within_tolerance(self):
        turns = [Turn(0, 2, "A"), Turn(10, 12, "B")]
        self.assertEqual(speaker_for(2.3, 2.5, turns), "A")
        self.assertEqual(speaker_for(9.5, 9.8, turns), "B")
        self.assertEqual(speaker_for(5.0, 6.0, turns), UNKNOWN)


class BuildUtterancesTest(unittest.TestCase):
    def test_splits_segment_on_speaker_change(self):
        turns = [Turn(0, 2, "話者A"), Turn(2, 4, "話者B")]
        segs = [seg(0, 4, [("はい", 0.1, 0.5), ("了解です", 0.6, 1.5), ("じゃあ", 2.2, 2.8), ("次へ", 2.9, 3.5)])]
        utts = build_utterances(segs, "system", turns=turns)
        self.assertEqual([(u.speaker, u.text) for u in utts], [("話者A", "はい了解です"), ("話者B", "じゃあ次へ")])

    def test_merges_same_speaker_across_segments(self):
        segs = [seg(0, 1, [("今日は", 0, 1)]), seg(1.5, 2, [("よろしく", 1.5, 2)]), seg(5, 6, [("では", 5, 6)])]
        utts = build_utterances(segs, "mic", fixed_speaker="自分")
        self.assertEqual([u.text for u in utts], ["今日はよろしく", "では"])

    def test_english_words_keep_spaces(self):
        segs = [seg(0, 1, [(" Hello", 0, 0.4), (" world", 0.5, 1)])]
        self.assertEqual(build_utterances(segs, "mic", fixed_speaker="me")[0].text, "Hello world")

    def test_drops_hallucinations(self):
        segs = [
            seg(0, 1, [("ご視聴ありがとうございました", 0, 1)]),
            seg(1, 2, [("ああああ", 1, 2)], compression_ratio=3.0),
            seg(2, 3, [("ん", 2, 3)], no_speech_prob=0.9, avg_logprob=-1.5),
            seg(3, 4, [("本題です", 3, 4)]),
        ]
        self.assertEqual([u.text for u in build_utterances(segs, "mic", fixed_speaker="自分")], ["本題です"])

    def test_segment_without_words_falls_back(self):
        segs = [{"start": 0, "end": 2, "text": "単語なし", "words": []}]
        utts = build_utterances(segs, "system", turns=[Turn(0, 2, "話者A")])
        self.assertEqual((utts[0].speaker, utts[0].text), ("話者A", "単語なし"))


class RenderTest(unittest.TestCase):
    def test_relabel_merge_render(self):
        turns = [Turn(5, 6, "SPEAKER_01"), Turn(0, 1, "SPEAKER_03"), Turn(7, 8, "SPEAKER_01")]
        self.assertEqual(relabel(turns), {"SPEAKER_03": "話者A", "SPEAKER_01": "話者B"})

        a = build_utterances([seg(3, 4, [("相手", 3, 4)])], "system", fixed_speaker="話者A")
        b = build_utterances([seg(0, 1, [("自分", 0, 1)])], "mic", fixed_speaker="自分")
        merged = merge_tracks(a, b)
        self.assertEqual([u.speaker for u in merged], ["自分", "話者A"])
        md = render_markdown(merged, "定例")
        self.assertTrue(md.startswith("# 定例"))
        self.assertIn("**[00:00:03] 話者A**: 相手", md)

    def test_fmt_ts(self):
        self.assertEqual(fmt_ts(3725.9), "01:02:05")


class PickClipsTest(unittest.TestCase):
    def utts(self):
        return [
            Utterance(0, 2, "話者A", "短い", "system"),
            Utterance(3, 6, "話者A", "長い", "system"),
            Utterance(4, 20, "話者B", "別人", "system"),
            Utterance(10, 12, "話者A", "同じ長さで後", "system"),
            Utterance(1, 9, "自分", "マイク", "mic"),
        ]

    def span(self, clips):
        return [(c.start, c.end, c.text) for c in clips]

    def test_longest_first_until_total(self):
        # 3 秒 → 2 秒 (同じ長さなら早い方) で合計 5 秒。他の話者は混ぜない
        self.assertEqual(self.span(pick_clips(self.utts(), "話者A")), [(3, 6, "長い"), (0, 2, "短い")])

    def test_long_utterance_is_cut_to_total(self):
        clips = pick_clips(self.utts(), "話者B")
        self.assertEqual(self.span(clips), [(4, 9, "別人")])

    def test_keeps_source_for_choosing_the_track(self):
        clips = pick_clips(self.utts(), "自分")
        self.assertEqual([(c.source, c.start, c.end) for c in clips], [("mic", 1, 6)])

    def test_stops_when_remainder_is_too_short(self):
        utts = [Utterance(0, 4.8, "話者A", "a", "system"), Utterance(5, 7, "話者A", "b", "system")]
        self.assertEqual(self.span(pick_clips(utts, "話者A")), [(0, 4.8, "a")])

    def test_unknown_speaker_gives_nothing(self):
        self.assertEqual(pick_clips(self.utts(), "話者Z"), [])


class SpeechSpansTest(unittest.TestCase):
    Q, L = -80.0, -20.0  # 無音 / 発話のフレーム

    def test_pads_and_clips_to_audio_bounds(self):
        # フレーム 0 と 9 だけ発話 (1 秒刻み)。前後 0.3 秒広げ、音声の外には出さない
        levels = [self.L] + [self.Q] * 8 + [self.L]
        self.assertEqual(speech_spans(levels, 1.0), [(0.0, 1.3), (8.7, 10.0)])

    def test_merges_short_gaps(self):
        levels = [self.L, self.Q, self.L]  # 隙間 1 秒 → 広げた後の隙間は 0.4 秒でつながる
        self.assertEqual(speech_spans(levels, 1.0), [(0.0, 3.0)])

    def test_silence_gives_nothing(self):
        self.assertEqual(speech_spans([self.Q] * 5, 1.0), [])


class ToSourceTimeTest(unittest.TestCase):
    spans = [(10.0, 12.0), (20.0, 25.0)]  # つないだ音声の 0-2 秒が 10-12、2-7 秒が 20-25

    def test_maps_into_each_span(self):
        self.assertEqual(to_source_time(0.5, self.spans), 10.5)
        self.assertEqual(to_source_time(3.0, self.spans), 21.0)

    def test_boundary_stays_in_earlier_span(self):
        self.assertEqual(to_source_time(2.0, self.spans), 12.0)

    def test_past_end_clamps_to_last_span(self):
        self.assertEqual(to_source_time(99.0, self.spans), 25.0)


class GroqSegmentsTest(unittest.TestCase):
    def resp(self):
        return {
            "segments": [
                {"id": 0, "start": 0.0, "end": 2.0, "text": "聞こえる", "no_speech_prob": 0, "tokens": [1]},
                {"id": 1, "start": 2.0, "end": 4.0, "text": "はい", "no_speech_prob": 0, "tokens": [2]},
            ],
            # 順序が前後した単語と、どのセグメントにも入らない単語を含む (実際の応答で起きる)
            "words": [
                {"word": "こえる", "start": 0.5, "end": 1.0},
                {"word": "聞", "start": 0.0, "end": 0.5},
                {"word": "はい", "start": 2.5, "end": 3.0},
                {"word": "ね", "start": 4.2, "end": 4.4},
            ],
        }

    def test_nests_words_in_order_and_maps_time_back(self):
        segs = groq_segments(self.resp(), [(100.0, 105.0)])
        self.assertEqual(
            [(s["text"], s["start"], s["end"], [(w["word"], w["start"]) for w in s["words"]]) for s in segs],
            [
                ("聞こえる", 100.0, 102.0, [("聞", 100.0), ("こえる", 100.5)]),
                ("はい", 102.0, 104.0, [("はい", 102.5), ("ね", 104.2)]),
            ],
        )
        self.assertNotIn("tokens", segs[0])

    def test_feeds_build_utterances(self):
        utts = build_utterances(groq_segments(self.resp(), [(0.0, 5.0)]), "mic", fixed_speaker="自分")
        self.assertEqual([(u.text, u.start, u.end) for u in utts], [("聞こえる", 0.0, 1.0), ("はいね", 2.5, 4.4)])

    def test_no_segments_gives_nothing(self):
        self.assertEqual(groq_segments({"segments": [], "words": []}, [(0.0, 1.0)]), [])


if __name__ == "__main__":
    unittest.main()
