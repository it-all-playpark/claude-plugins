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
- --asr-backend groq (MEETING_ASR_BACKEND=groq) のときだけ Whisper を Groq に送る。送るのは話している区間の
  音声だけで、initial_prompt (固有名詞が入る) は送らない。失敗したら MLX で処理し直す。
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
    groq_segments,
    merge_tracks,
    relabel,
    render_markdown,
    speech_spans,
)

SR = 16_000
DEFAULT_ASR = "mlx-community/whisper-large-v3-turbo"
DEFAULT_DIAR = "pyannote/speaker-diarization-community-1"
# 送り先は固定し、環境変数で差し替えさせない (音声を任意の URL に送れる口を作らない)
GROQ_URL = "https://api.groq.com/openai/v1/audio/transcriptions"
GROQ_MODEL = "whisper-large-v3-turbo"
GROQ_KEYCHAIN_SERVICE = "meeting-groq"
GROQ_MAX_BYTES = 25 * 1024 * 1024  # 無料枠の 1 ファイルの上限


class GroqError(Exception):
    pass


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


def transcribe(audio, args) -> tuple[list[dict], str]:
    """(セグメント, 実際に使った backend)。Groq が失敗したら MLX で処理し直す。"""
    if args.asr_backend == "groq":
        try:
            return transcribe_groq(audio, args), "groq"
        except GroqError as e:
            log(f"Groq で文字起こしできなかったためローカルで処理します: {e}")
    return transcribe_mlx(audio, args), "mlx"


def frame_levels_db(audio, frame: float = 0.1) -> list[float]:
    import numpy as np

    n = int(SR * frame)
    usable = audio[: len(audio) // n * n].reshape(-1, n)
    return (20 * np.log10(np.sqrt(np.mean(usable**2, axis=1)) + 1e-12)).tolist()


def transcribe_groq(audio, args) -> list[dict]:
    import numpy as np

    frame = 0.1
    spans = speech_spans(frame_levels_db(audio, frame), frame)
    if not spans:
        return []
    voiced = np.concatenate([audio[int(s * SR) : int(e * SR)] for s, e in spans])
    log(f"Groq に送信: 話している区間 {len(voiced) / SR / 60:.1f} 分 / 全体 {len(audio) / SR / 60:.1f} 分")
    # Opus 32kbps はディスクに書かずにパイプで受け取る。FLAC と比べて文字起こしは変わらず 1/8 の大きさになる
    enc = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
         "-c:a", "libopus", "-b:a", "32k", "-f", "ogg", "-"],
        input=voiced.astype(np.float32).tobytes(),
        capture_output=True,
    )
    if enc.returncode != 0:
        raise GroqError(f"Opus に変換できません (ffmpeg に libopus が無い?): {enc.stderr.decode(errors='replace')[:200]}")
    ogg = enc.stdout
    if len(ogg) > GROQ_MAX_BYTES:
        raise GroqError(f"音声が {len(ogg) / 1e6:.0f}MB あり上限 25MB を超えています")
    return groq_segments(post_groq(ogg, args), spans)


def groq_key() -> str:
    r = subprocess.run(
        ["security", "find-generic-password", "-s", GROQ_KEYCHAIN_SERVICE, "-w"],
        capture_output=True,
        text=True,
    )
    if r.returncode != 0 or not r.stdout.strip():
        raise GroqError(f"Keychain から API キーを読めません (service={GROQ_KEYCHAIN_SERVICE}, exit {r.returncode})")
    return r.stdout.strip()


def post_groq(ogg: bytes, args) -> dict:
    import urllib.error
    import urllib.request
    import uuid

    fields = [("model", GROQ_MODEL), ("response_format", "verbose_json"), ("temperature", "0"),
              ("timestamp_granularities[]", "word"), ("timestamp_granularities[]", "segment")]
    if args.language != "auto":
        fields.append(("language", args.language))
    boundary = uuid.uuid4().hex
    body = b"".join(
        f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode() for k, v in fields
    )
    body += (
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\n'
        "Content-Type: audio/ogg\r\n\r\n"
    ).encode() + ogg + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        GROQ_URL,
        data=body,
        # urllib 既定の User-Agent (Python-urllib/x.y) は Groq の前段 (Cloudflare) に 403 (error 1010) で弾かれる
        headers={"Authorization": f"Bearer {groq_key()}", "Content-Type": f"multipart/form-data; boundary={boundary}",
                 "User-Agent": "meeting-transcribe"},
    )
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        retry = e.headers.get("retry-after")
        raise GroqError(f"HTTP {e.code}{f' (retry-after {retry}s)' if retry else ''}: {e.read()[:200]!r}") from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as e:
        raise GroqError(str(e)) from None


def transcribe_mlx(audio, args) -> list[dict]:
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
    ap.add_argument("--asr-backend", choices=("mlx", "groq"), default=os.environ.get("MEETING_ASR_BACKEND", "mlx"),
                    help="groq は Whisper を Groq に送る (失敗したら mlx)。default: mlx")
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
    backends: dict[str, str] = {}  # どのトラックを外部に送ったかを残す
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
            segs, backends["system"] = transcribe(audio, args)
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
            segs, backends["mic"] = transcribe(audio, args)
            tracks.append(build_utterances(segs, "mic", fixed_speaker=args.me))

    if not tracks:
        raise SystemExit(f"{d} に文字起こしできる音声がありません (system.wav / mic.wav)")

    utts = merge_tracks(*tracks)
    result = {
        "meta": meta,
        "asr_backend": backends,
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
