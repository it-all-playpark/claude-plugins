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
                {"id": 0, "start": 0.0, "end": 2.0, "text": "聞こえるよね", "no_speech_prob": 0, "tokens": [1]},
                {"id": 1, "start": 2.0, "end": 4.0, "text": "はいね", "no_speech_prob": 0, "tokens": [2]},
            ],
            # 返ってきた順がセグメントの文と一致し、開始時刻だけが前に戻る (実際の応答で起きる)。
            # 「ね」は最後のセグメントの外にはみ出す
            "words": [
                {"word": "聞", "start": 0.0, "end": 0.5},
                {"word": "こえる", "start": 0.5, "end": 1.0},
                {"word": "よね", "start": 1.0, "end": 1.4},
                {"word": "は", "start": 2.5, "end": 2.7},
                {"word": "い", "start": 2.4, "end": 3.0},
                {"word": "ね", "start": 4.2, "end": 4.4},
            ],
        }

    def text_of(self, segs):
        return [(s["text"], "".join(w["word"] for w in s["words"])) for s in segs]

    def test_keeps_returned_order_when_start_goes_back(self):
        # 開始時刻で並べ替えると「いは」になる
        self.assertEqual(self.text_of(groq_segments(self.resp(), [(0.0, 5.0)])), [("聞こえるよね", "聞こえるよね"), ("はいね", "はいね")])

    def test_word_going_back_does_not_return_to_previous_segment(self):
        resp = self.resp()
        resp["words"][4]["start"] = 1.9  # 前のセグメントの区間に戻っても、今のセグメントに入れる
        self.assertEqual(self.text_of(groq_segments(resp, [(0.0, 5.0)])), [("聞こえるよね", "聞こえるよね"), ("はいね", "はいね")])

    def test_assigns_by_text_when_time_crosses_segment_boundary(self):
        resp = self.resp()
        resp["words"][2]["start"] = 2.1  # 「よね」の時刻は 2 つ目のセグメントに入るが、文としては 1 つ目
        self.assertEqual(self.text_of(groq_segments(resp, [(0.0, 5.0)])), [("聞こえるよね", "聞こえるよね"), ("はいね", "はいね")])

    def test_missing_words_do_not_shift_later_segments(self):
        resp = self.resp()
        del resp["words"][1:3]  # 「こえるよね」が単語の配列から抜ける (実際の応答で起きる)
        segs = groq_segments(resp, [(0.0, 5.0)])
        # 単語が大きく足りないセグメントは words を捨て、セグメント全文を残す
        self.assertEqual(self.text_of(segs), [("聞こえるよね", ""), ("はいね", "はいね")])
        utts = build_utterances(segs, "mic", fixed_speaker="自分")
        self.assertEqual([u.text for u in utts], ["聞こえるよねはいね"])

    def test_maps_time_back_and_drops_extra_fields(self):
        segs = groq_segments(self.resp(), [(100.0, 105.0)])
        self.assertEqual([(s["start"], s["end"]) for s in segs], [(100.0, 102.0), (102.0, 104.0)])
        self.assertEqual([w["start"] for w in segs[1]["words"]], [102.5, 102.4, 104.2])
        self.assertNotIn("tokens", segs[0])

    def test_caps_long_word_from_its_end(self):
        resp = self.resp()
        resp["words"][1] = {"word": "こえる", "start": 0.0, "end": 9.0}  # 直前の無音を抱えて 9 秒
        w = groq_segments(resp, [(0.0, 20.0)])[0]["words"][1]
        self.assertEqual((w["start"], w["end"]), (7.0, 9.0))

    def test_word_end_does_not_cross_into_next_span(self):
        # つないだ音声の 0-2 秒が元の 10-12、2-4 秒が 30-32。1.8-2.6 秒の単語は 12.0 で切る (30.6 まで伸ばさない)
        resp = {"segments": [{"start": 0.0, "end": 4.0, "text": "あ"}], "words": [{"word": "あ", "start": 1.8, "end": 2.6}]}
        w = groq_segments(resp, [(10.0, 12.0), (30.0, 32.0)])[0]["words"][0]
        self.assertAlmostEqual(w["start"], 11.8)
        self.assertEqual(w["end"], 12.0)

    def test_feeds_build_utterances(self):
        utts = build_utterances(groq_segments(self.resp(), [(0.0, 5.0)]), "mic", fixed_speaker="自分")
        self.assertEqual([(u.text, u.start, u.end) for u in utts], [("聞こえるよね", 0.0, 1.4), ("はいね", 2.5, 4.4)])

    def test_no_segments_gives_nothing(self):
        self.assertEqual(groq_segments({"segments": [], "words": []}, [(0.0, 1.0)]), [])


if __name__ == "__main__":
    unittest.main()
