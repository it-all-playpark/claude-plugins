"""transcribe.py の Groq 呼び出しと設定ファイルの読み込みの単体テスト (標準ライブラリのみ。通信はしない。align.bats から実行される)。"""

import argparse
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import transcribe  # noqa: E402


class PostGroqTest(unittest.TestCase):
    def post(self, language="ja"):
        sent = {}

        def fake_urlopen(req, timeout):
            sent["req"] = req
            return io.BytesIO(json.dumps({"segments": [], "words": []}).encode())

        args = argparse.Namespace(language=language)
        with mock.patch.object(transcribe, "groq_key", return_value="k"), \
                mock.patch("urllib.request.urlopen", fake_urlopen):
            transcribe.post_groq(b"OGG", args)
        return sent["req"]

    def test_connection_reset_becomes_groq_error(self):
        # URLError に包まれない接続断も GroqError にして mlx に戻す
        def fake_urlopen(req, timeout):
            raise ConnectionResetError("reset by peer")

        args = argparse.Namespace(language="ja")
        with mock.patch.object(transcribe, "groq_key", return_value="k"), \
                mock.patch("urllib.request.urlopen", fake_urlopen):
            with self.assertRaises(transcribe.GroqError):
                transcribe.post_groq(b"OGG", args)

    def test_sets_own_user_agent(self):
        # urllib 既定の Python-urllib/x.y だと Cloudflare に 403 (error 1010) で弾かれ、毎回ローカルに戻る
        req = self.post()
        self.assertEqual(req.get_header("User-agent"), "meeting-transcribe")

    def test_posts_to_fixed_url_without_prompt(self):
        req = self.post()
        self.assertEqual(req.full_url, transcribe.GROQ_URL)
        self.assertNotIn(b'name="prompt"', req.data)
        self.assertIn(b'name="timestamp_granularities[]"\r\n\r\nword', req.data)
        self.assertIn(b'name="language"\r\n\r\nja', req.data)

    def test_auto_language_is_not_sent(self):
        self.assertNotIn(b'name="language"', self.post(language="auto").data)


class ConfigTest(unittest.TestCase):
    """asr_backend / asr_model / diar_model の既定値は meeting setup が書く設定ファイルから読む。"""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        env = {k: v for k, v in os.environ.items() if k not in ("MEETING_CONFIG", "XDG_CONFIG_HOME")}
        env["HOME"] = self.tmp.name
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def write(self, path, cfg):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(cfg), encoding="utf-8")

    def test_reads_meeting_config(self):
        path = Path(self.tmp.name) / "c.json"
        self.write(path, {"asr_backend": "groq", "asr_model": "m/asr", "diar_model": "m/diar", "notes_dir": "~/n"})
        os.environ["MEETING_CONFIG"] = str(path)
        args = transcribe.parse_args(["d"])
        self.assertEqual((args.asr_backend, args.asr_model, args.diar_model), ("groq", "m/asr", "m/diar"))

    def test_reads_xdg_config_home_then_home_config(self):
        xdg = Path(self.tmp.name) / "xdg"
        self.write(xdg / "meeting" / "config.json", {"asr_backend": "groq"})
        self.write(Path(self.tmp.name) / ".config" / "meeting" / "config.json", {"asr_model": "home/asr"})
        os.environ["XDG_CONFIG_HOME"] = str(xdg)
        self.assertEqual(transcribe.parse_args(["d"]).asr_backend, "groq")
        del os.environ["XDG_CONFIG_HOME"]
        args = transcribe.parse_args(["d"])
        self.assertEqual((args.asr_backend, args.asr_model), ("mlx", "home/asr"))

    def test_defaults_without_config_and_args_override_config(self):
        args = transcribe.parse_args(["d"])
        self.assertEqual((args.asr_backend, args.asr_model, args.diar_model),
                         ("mlx", transcribe.DEFAULT_ASR, transcribe.DEFAULT_DIAR))
        path = Path(self.tmp.name) / "c.json"
        self.write(path, {"asr_backend": "groq"})
        os.environ["MEETING_CONFIG"] = str(path)
        self.assertEqual(transcribe.parse_args(["d", "--asr-backend", "mlx"]).asr_backend, "mlx")

    def test_rejects_unknown_backend_and_broken_file(self):
        path = Path(self.tmp.name) / "c.json"
        os.environ["MEETING_CONFIG"] = str(path)
        self.write(path, {"asr_backend": "openai"})
        with self.assertRaises(SystemExit) as e:
            transcribe.parse_args(["d"])
        self.assertIn("asr_backend", str(e.exception.code))
        path.write_text("{", encoding="utf-8")
        with self.assertRaises(SystemExit) as e:
            transcribe.parse_args(["d"])
        self.assertIn(str(path), str(e.exception.code))


if __name__ == "__main__":
    unittest.main()
