"""transcribe.py の Groq 呼び出しの単体テスト (標準ライブラリのみ。通信はしない。align.bats から実行される)。"""

import argparse
import io
import json
import sys
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


if __name__ == "__main__":
    unittest.main()
