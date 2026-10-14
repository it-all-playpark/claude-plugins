"""Whisper の単語タイムスタンプと話者分離結果を突き合わせて発話リストを作る。

ML ライブラリに依存しない純粋ロジックだけを置く (テスト容易性のため)。
"""

from __future__ import annotations

from dataclasses import asdict, dataclass

# 無音や環境音に対して Whisper がよく出す幻聴フレーズ
HALLUCINATIONS = {
    "ご視聴ありがとうございました",
    "ご視聴ありがとうございました。",
    "ご清聴ありがとうございました",
    "ご清聴ありがとうございました。",
    "チャンネル登録よろしくお願いします",
    "チャンネル登録をお願いします",
    "最後までご視聴いただきありがとうございました",
    "おやすみなさい",
    "字幕は視聴者によって作成されました",
    "Thank you for watching.",
    "Thanks for watching!",
    "you",
    "...",
}

UNKNOWN = "不明"


@dataclass
class Turn:
    start: float
    end: float
    speaker: str


@dataclass
class Utterance:
    start: float
    end: float
    speaker: str
    text: str
    source: str  # "mic" | "system"

    def to_dict(self) -> dict:
        return asdict(self)


def is_hallucination(seg: dict) -> bool:
    text = seg.get("text", "").strip()
    if not text or text in HALLUCINATIONS:
        return True
    if seg.get("compression_ratio", 0) > 2.4:
        return True  # 同じ語の繰り返しループ
    if seg.get("no_speech_prob", 0) > 0.6 and seg.get("avg_logprob", 0) < -1.0:
        return True
    return False


def _words_of(seg: dict) -> list[dict]:
    """単語タイムスタンプが無いセグメントはセグメント全体を 1 単語として扱う。"""
    words = [w for w in seg.get("words") or [] if w.get("word", "").strip()]
    if words:
        return words
    return [{"word": seg.get("text", ""), "start": seg["start"], "end": seg["end"]}]


def speaker_for(start: float, end: float, turns: list[Turn], tolerance: float = 1.0) -> str:
    """区間と最も長く重なる話者。重ならなければ tolerance 秒以内の最寄りの話者。"""
    best, best_ov = None, 0.0
    for t in turns:
        ov = min(end, t.end) - max(start, t.start)
        if ov > best_ov:
            best, best_ov = t.speaker, ov
    if best is not None:
        return best
    mid = (start + end) / 2
    nearest, dist = None, tolerance
    for t in turns:
        d = t.start - mid if mid < t.start else mid - t.end
        if d <= dist:
            nearest, dist = t.speaker, d
    return nearest or UNKNOWN


def build_utterances(
    segments: list[dict],
    source: str,
    turns: list[Turn] | None = None,
    fixed_speaker: str | None = None,
    merge_gap: float = 1.0,
) -> list[Utterance]:
    """Whisper セグメント → 話者ごとの発話。

    - fixed_speaker を渡すと全単語をその話者にする (マイクトラック = 自分)。
    - turns を渡すと単語ごとに話者を割り当て、話者が変わる所で発話を区切る。
    - 同じ話者の発話が merge_gap 秒以内に続く場合は 1 つにまとめる。
    """
    pieces: list[Utterance] = []
    for seg in segments:
        if is_hallucination(seg):
            continue
        cur: Utterance | None = None
        for w in _words_of(seg):
            if fixed_speaker is not None:
                spk = fixed_speaker
            elif turns:
                spk = speaker_for(w["start"], w["end"], turns)
            else:
                spk = UNKNOWN
            if cur and cur.speaker == spk:
                cur.text += w["word"]
                cur.end = w["end"]
            else:
                if cur:
                    pieces.append(cur)
                cur = Utterance(w["start"], w["end"], spk, w["word"], source)
        if cur:
            pieces.append(cur)

    merged: list[Utterance] = []
    for p in pieces:
        p.text = p.text.strip()
        if not p.text:
            continue
        if merged and merged[-1].speaker == p.speaker and p.start - merged[-1].end <= merge_gap:
            prev = merged[-1]
            prev.text = _join(prev.text, p.text)
            prev.end = max(prev.end, p.end)
        else:
            merged.append(p)
    return merged


def _join(a: str, b: str) -> str:
    # 英語など空白区切りの言語は空白を入れ、日本語はそのまま連結
    if a and b and a[-1].isascii() and a[-1].isalnum() and b[0].isascii() and b[0].isalnum():
        return f"{a} {b}"
    return a + b


def speech_spans(
    levels_db: list[float],
    frame: float,
    threshold_db: float = -50.0,
    pad: float = 0.3,
    merge_gap: float = 1.0,
) -> list[tuple[float, float]]:
    """フレームごとの音量 (dBFS) から話している区間 (秒) を出す。

    Groq には無音を送らない: 無音区間で「ご視聴ありがとうございました」の幻聴が出るうえ、
    Groq の no_speech_prob は常に 0 で is_hallucination では落とせない。送る秒数も無料枠の上限に効く。
    前後を pad 秒広げ、merge_gap 秒以内の隙間はつなぐ (語頭・語尾と息継ぎを切らない)。
    """
    total = len(levels_db) * frame
    spans: list[tuple[float, float]] = []
    for i, db in enumerate(levels_db):
        if db < threshold_db:
            continue
        s, e = max(0.0, i * frame - pad), min(total, (i + 1) * frame + pad)
        if spans and s - spans[-1][1] <= merge_gap:
            spans[-1] = (spans[-1][0], e)
        else:
            spans.append((s, e))
    return spans


def to_source_time(t: float, spans: list[tuple[float, float]]) -> float:
    """spans をつないだ音声の時刻 t を、元の音声の時刻に戻す。"""
    offset = 0.0
    for s, e in spans:
        if t <= offset + (e - s):
            return s + max(0.0, t - offset)
        offset += e - s
    return spans[-1][1] if spans else t


def groq_segments(resp: dict, spans: list[tuple[float, float]]) -> list[dict]:
    """Groq の verbose_json を mlx-whisper と同じ形 (セグメントの中に words) にし、時刻を元の音声に戻す。

    Groq は単語をセグメントの外 (最上位の words) に返し、順序が前後したりどのセグメントにも
    入らなかったりするので、開始時刻で含むセグメント、無ければ最寄りのセグメントに入れる。
    """
    segs = [
        {k: v for k, v in s.items() if k in ("start", "end", "text", "avg_logprob", "compression_ratio", "no_speech_prob")}
        | {"words": []}
        for s in resp.get("segments") or []
    ]
    if not segs:
        return []
    for w in resp.get("words") or []:
        t = w["start"]
        home = next((s for s in segs if s["start"] <= t < s["end"]), None)
        if home is None:
            home = min(segs, key=lambda s: s["start"] - t if t < s["start"] else t - s["end"])
        home["words"].append({"word": w["word"], "start": w["start"], "end": w["end"]})
    for s in segs:
        s["words"].sort(key=lambda w: w["start"])
        for x in (s, *s["words"]):
            x["start"], x["end"] = to_source_time(x["start"], spans), to_source_time(x["end"], spans)
    return segs


def relabel(turns: list[Turn]) -> dict[str, str]:
    """pyannote の SPEAKER_00 などを登場順に 話者A, 話者B… へ。"""
    mapping: dict[str, str] = {}
    for t in sorted(turns, key=lambda t: t.start):
        if t.speaker not in mapping:
            i = len(mapping)
            mapping[t.speaker] = "話者" + (chr(ord("A") + i) if i < 26 else str(i + 1))
    return mapping


def merge_tracks(*tracks: list[Utterance]) -> list[Utterance]:
    out = [u for tr in tracks for u in tr]
    out.sort(key=lambda u: (u.start, u.end))
    return out


def pick_clips(utts: list[Utterance], speaker: str, total: float = 5.0, min_clip: float = 0.5) -> list[Utterance]:
    """話者の声を確かめるために再生する区間 (meeting play)。

    その話者の発話を長い順 (同じ長さなら早い順) に取り、各発話の頭から合計 total 秒になるまで切り出す。
    残りが min_clip 秒を切ったら止める (短すぎる断片は聞き分けに役立たない)。
    """
    cands = sorted(
        (u for u in utts if u.speaker == speaker and u.end > u.start),
        key=lambda u: (-(u.end - u.start), u.start),
    )
    clips: list[Utterance] = []
    left = total
    for u in cands:
        if left < min_clip:
            break
        dur = min(u.end - u.start, left)
        clips.append(Utterance(u.start, u.start + dur, u.speaker, u.text, u.source))
        left -= dur
    return clips


def fmt_ts(sec: float) -> str:
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def render_markdown(utts: list[Utterance], title: str = "") -> str:
    lines = [f"# {title}" if title else "# Transcript", ""]
    for u in utts:
        lines.append(f"**[{fmt_ts(u.start)}] {u.speaker}**: {u.text}")
        lines.append("")
    return "\n".join(lines)
