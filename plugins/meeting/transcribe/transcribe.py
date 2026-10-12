#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11,<3.13"
# dependencies = [
#   "mlx-whisper>=0.4.2",
#   "pyannote.audio>=3.3",
#   "torch>=2.4",
#   "numpy",
# ]
# ///
"""meeting-rec の録音ディレクトリを文字起こし + 話者分離する。

    uv run transcribe.py ~/Meetings/2026-10-11_1400-定例

入力:  system.wav (相手側), mic.wav (自分, 任意), meta.json (任意)
出力:  transcript.json, transcript.md

- mic.wav は話者分離せず全て「自分」として扱う (別トラックなので確実)。
- system.wav だけを pyannote で話者分離し、Whisper の単語タイムスタンプに割り当てる。
- Apple Silicon 前提: Whisper は MLX、pyannote は MPS で動かす。
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from align import (  # noqa: E402
    Turn,
    build_utterances,
    merge_tracks,
    relabel,
    render_markdown,
)

SR = 16_000
DEFAULT_ASR = "mlx-community/whisper-large-v3-turbo"
DEFAULT_DIAR = "pyannote/speaker-diarization-community-1"


def log(msg: str) -> None:
    print(f"[transcribe] {msg}", file=sys.stderr, flush=True)


def load_audio(path: Path):
    """ffmpeg で 16kHz mono float32 にデコード。"""
    import numpy as np

    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def is_silent(audio, threshold_db: float = -55.0) -> bool:
    import numpy as np

    if audio.size == 0:
        return True
    peak_rms = 0.0
    for i in range(0, audio.size, SR):  # 1 秒ごとの RMS の最大値
        peak_rms = max(peak_rms, float(np.sqrt(np.mean(audio[i : i + SR] ** 2))))
    return 20 * np.log10(peak_rms + 1e-12) < threshold_db


def transcribe(audio, args) -> list[dict]:
    import mlx_whisper

    kw = dict(
        path_or_hf_repo=args.asr_model,
        word_timestamps=True,
        condition_on_previous_text=False,  # 幻聴ループ対策
        hallucination_silence_threshold=2.0,
        verbose=None,
    )
    if args.language != "auto":
        kw["language"] = args.language
    if args.prompt:
        kw["initial_prompt"] = args.prompt
    return mlx_whisper.transcribe(audio, **kw)["segments"]


def diarize(audio, args) -> list[Turn]:
    import torch

    pipe = load_pipeline(args.diar_model)
    device = args.device or ("mps" if torch.backends.mps.is_available() else "cpu")
    pipe.to(torch.device(device))

    kw = {}
    if args.num_speakers:
        kw["num_speakers"] = args.num_speakers
    if args.min_speakers:
        kw["min_speakers"] = args.min_speakers
    if args.max_speakers:
        kw["max_speakers"] = args.max_speakers

    out = pipe({"waveform": torch.from_numpy(audio)[None], "sample_rate": SR}, **kw)
    # community-1 は重なり発話を排除した exclusive 版を返すので、文字起こしとの突き合わせにはそちらを使う
    # (Annotation は空だと falsy なので `or` で繋がない)
    ann = out
    for attr in ("exclusive_speaker_diarization", "speaker_diarization"):
        if getattr(out, attr, None) is not None:
            ann = getattr(out, attr)
            break
    return [Turn(seg.start, seg.end, spk) for seg, _, spk in ann.itertracks(yield_label=True)]


def load_pipeline(model: str):
    from pyannote.audio import Pipeline

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    try:
        pipe = Pipeline.from_pretrained(model, token=token)  # pyannote >= 4
    except TypeError:
        pipe = Pipeline.from_pretrained(model, use_auth_token=token)  # pyannote 3.x
    if pipe is None:
        raise SystemExit(
            f"話者分離モデル {model} を取得できません。\n"
            f"  1) https://huggingface.co/{model} で利用規約に同意\n"
            "  2) HF_TOKEN 環境変数を設定 (または `hf auth login`)"
        )
    return pipe


def prefetch(args) -> None:
    """モデルを先に取得しておく。自動録音後の初回の文字起こしがダウンロード失敗で落ちないように。"""
    from huggingface_hub import snapshot_download

    log(f"{args.asr_model} を取得中")
    snapshot_download(repo_id=args.asr_model)
    if not args.no_diarize:
        log(f"{args.diar_model} を取得中")
        load_pipeline(args.diar_model)
    log("モデルの取得が完了しました")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dir", type=Path, nargs="?", help="meeting-rec の出力ディレクトリ")
    ap.add_argument("--prefetch", action="store_true", help="モデルを取得するだけで終わる (meeting setup が使う)")
    ap.add_argument("--language", default="ja", help="ja / en / auto (default: ja)")
    ap.add_argument("--prompt", default="", help="固有名詞・専門用語のヒント (Whisper initial_prompt)")
    ap.add_argument("--me", default="自分", help="mic.wav の話者名 (default: 自分)")
    ap.add_argument("--num-speakers", type=int, help="相手側の人数が分かっていれば指定 (精度が上がる)")
    ap.add_argument("--min-speakers", type=int)
    ap.add_argument("--max-speakers", type=int)
    ap.add_argument("--asr-model", default=os.environ.get("MEETING_ASR_MODEL", DEFAULT_ASR))
    ap.add_argument("--diar-model", default=os.environ.get("MEETING_DIAR_MODEL", DEFAULT_DIAR))
    ap.add_argument("--device", help="pyannote の実行デバイス (default: mps があれば mps)")
    ap.add_argument("--no-diarize", action="store_true", help="相手側を話者分離しない")
    args = ap.parse_args()
    if args.prefetch:
        prefetch(args)
        return
    if args.dir is None:
        ap.error("dir が必要です")

    d: Path = args.dir.expanduser().resolve()
    meta_path = d / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    if not args.prompt:
        args.prompt = meta.get("prompt", "")

    tracks = []
    speaker_map: dict[str, str] = {}
    t0 = time.time()

    sys_wav = d / "system.wav"
    if sys_wav.exists():
        log("system.wav を読み込み中")
        audio = load_audio(sys_wav)
        if is_silent(audio):
            log("system.wav はほぼ無音のためスキップ")
        else:
            log(f"system.wav 文字起こし ({len(audio) / SR / 60:.1f} 分)")
            segs = transcribe(audio, args)
            turns: list[Turn] = []
            if not args.no_diarize:
                log("system.wav 話者分離")
                turns = diarize(audio, args)
                speaker_map = relabel(turns)
                turns = [Turn(t.start, t.end, speaker_map[t.speaker]) for t in turns]
                log(f"検出話者数: {len(speaker_map)}")
            tracks.append(build_utterances(segs, "system", turns=turns, fixed_speaker=None if turns else "相手"))

    mic_wav = d / "mic.wav"
    if mic_wav.exists():
        log("mic.wav を読み込み中")
        audio = load_audio(mic_wav)
        if is_silent(audio):
            log("mic.wav はほぼ無音のためスキップ")
        else:
            log(f"mic.wav 文字起こし ({len(audio) / SR / 60:.1f} 分)")
            tracks.append(build_utterances(transcribe(audio, args), "mic", fixed_speaker=args.me))

    if not tracks:
        raise SystemExit(f"{d} に文字起こしできる音声がありません (system.wav / mic.wav)")

    utts = merge_tracks(*tracks)
    result = {
        "meta": meta,
        "asr_model": args.asr_model,
        "diar_model": None if args.no_diarize else args.diar_model,
        "speakers": sorted({u.speaker for u in utts}),
        "diarization_labels": speaker_map,
        "utterances": [u.to_dict() for u in utts],
    }
    (d / "transcript.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    (d / "transcript.md").write_text(render_markdown(utts, meta.get("title", "")))
    log(f"完了 ({time.time() - t0:.0f}s): {d / 'transcript.md'}")


if __name__ == "__main__":
    main()
