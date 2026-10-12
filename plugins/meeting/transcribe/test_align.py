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
    merge_tracks,
    relabel,
    render_markdown,
    speaker_for,
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


if __name__ == "__main__":
    unittest.main()
