# Jev（issue analyze の意味判定）

prerun の analyze は、正規表現では決められない判定を Jev（Vercel AI Gateway 経由の判定専用モデル）に聞く。
Jev のクライアントは plugin に同梱せず、公開された参照実装も無い。**前提条件**: Jev を使うには、下記の
インターフェースを満たす `jev-classify` を自分で用意して PATH に置く（`DEVFLOW_JEV_CLASSIFY` で別名にできる）。
置かない場合は下の「効かないときの挙動」になる。plugin は `jev-classify` を次のインターフェースで呼ぶ:

- 入力: stdin に state（判定対象の issue 本文などを Markdown で並べたテキスト）、引数
  `--questions '<questions JSON>' --redact --reason-file <path>`（`--redact` は送信前に token / password 等を
  伏せる。応答の上限秒数を環境変数 `JEV_MAX_TIME` で渡す。値は `DEVFLOW_JEV_MAX_TIME`、既定 10）
- questions JSON: 質問 id → 質問のオブジェクト。型は 2 つ:
  - `{"type":"noul","instructions":"…"}` — yes / no の質問。id は `breaking`・`migration`
  - `{"type":"choice","instructions":"…","criteria":{"<選択肢>":"<基準>",…}}` — 選択肢から 1 つ選ぶ質問。
    id は `kind`、選択肢は `override` / `conflict` / `resolved` / `unrelated`
- 出力: 成功時は `{"answers":{…}}` を stdout に 1 行で出す（他のキーは読まない）。`answers` は質問 id ごとに
  - noul: `{"noul":<yes の確率 0〜1>}`
  - choice: `{"choice":"<選んだ選択肢>","probabilities":{"<選択肢>":<確率>,…}}`（選んだ選択肢の確率は必須）

  plugin は確率 0.9 以上を yes / その選択肢、0.1 以下を no とし、その間は低確信として安全側（uncertain・
  conflict）に倒す。確率は 0〜1 の数値。それ以外（`true` / `false` / `null` / 文字列 / 範囲外）は
  判定値なしと同じく uncertain になる。答えられない質問は id ごと省いてよい（その判定だけ
  uncertain になる）。
  最小の実装例は `dev-flow/scripts/prerun-analyze.bats` の偽 `jev-classify`、質問の全文は
  `dev-flow/scripts/prerun-analyze.sh`
- 失敗時は stdout を空にし、理由 1 行を `--reason-file` に書く。exit は常に 0。理由の先頭語（`no API key` /
  `keychain unreachable` / `keychain read failed` / `broker unreachable` / `broker request failed` / `timeout` /
  `request failed` / `bad response`）で uncertain の見出しを変える

- **要否**: 必須ではない。Jev を呼ぶのは、title / body に breaking 系キーワードがある issue と comment が付いた
  issue だけで、どちらにも当たらない issue は Jev が無くても同じ結果になる。AC の観測型判定は Jev を使わず、
  analyze ゲートの分類 agent（`ac-observational#N`）が全 AC について行う
- **効かないときの挙動**: `jev-classify` が PATH に無い・鍵が無い・届かない・タイムアウト・低確信のとき、breaking と comment の判定は
  uncertain に積まれ、run は Setup 末尾の analyze ゲートで**必ず needs_clarification で止まる**（実装に進まない）。
  `DEVFLOW_JEV_DISABLE=1` で切ったときも同じ
- **注記: 作者の `jev-classify` 実装を使う場合の鍵の設定**（その実装は上から順に試す。plugin には含まれず、
  自前の実装ならこの手順ではなくその実装に従う。`AI_GATEWAY_API_KEY` を置くだけでは `jev-classify` は手に入らない）:
  1. 環境変数 `AI_GATEWAY_API_KEY`（Vercel AI Gateway の API key `vck_…`）— 第一の方法。`dev-flow-prerun` を
     実行する Claude Code セッションの環境に置く（起動前のシェルで export する、または settings.json の `env`）。
     鍵は Bash ツールの環境から見える。sandbox 下では network の許可に `ai-gateway.vercel.sh` が要る
  2. jev-broker（**任意**）: 鍵を Bash の環境に出さずに中継する Unix socket。`JEV_BROKER_SOCKET`（既定
     `$HOME/.local/state/jev-broker/jev.sock`）に socket があれば経由する。sandbox 下では socket のパスを
     `sandbox.network.allowUnixSockets` に足す。broker が無くても 1 か 3 で動く
  3. macOS Keychain の service `vercel-ai-gateway`（`JEV_KEYCHAIN_SERVICE` で変更可）の generic password。
     登録は `security add-generic-password -s vercel-ai-gateway -a <任意のアカウント名> -w 'vck_…'`。
     Keychain の解除は監査セッションごとに効くので、sandbox 内の Bash と bg job からは解除済みでも届かない
     （exit 36）。その環境では 1 か 2 を使う
