// ac-actor-classify.mjs - AC の actor（_lib/ac-actor.mjs の classifyAcActor）と repo 内外の混在
// （mixedScopeAcReasons）を git-issue の create_issue.py から呼ぶ CLI（issue #1026）。起票時に dev-flow と
// 同じ判定で人手の AC を拒否する。規則は ac-actor.mjs の 1 か所に置き、Python 側に写しを持たない。
// observational / ciVerify は渡さない（観測型は dev-flow で Jev と分類 agent が最終判定し、正規表現の絞り込みだけで
// 拒否すると拾いすぎる。ci_verify は repo の宣言で、起票時には読まない）。
//
// Usage: node ac-actor-classify.mjs [--repo <owner/name>] < <AC 文字列の JSON 配列>
// stdout: {"actors": [AC ごとの actor], "mixed_reasons": [mixedScopeAcReasons の理由行]}（1 行）
import { readFileSync } from 'node:fs'
import { classifyAcActor, mixedScopeAcReasons } from '../ac-actor.mjs'

const args = process.argv.slice(2)
let repo
if (args.length === 2 && args[0] === '--repo') repo = args[1]
else if (args.length !== 0) throw new Error('usage: ac-actor-classify.mjs [--repo <owner/name>] < <JSON array>')

const acs = JSON.parse(readFileSync(0, 'utf8'))
if (!Array.isArray(acs)) throw new Error('stdin must be a JSON array of acceptance criteria')
const actors = acs.map((ac) => classifyAcActor(ac, { repo }))
process.stdout.write(`${JSON.stringify({ actors, mixed_reasons: mixedScopeAcReasons(acs, { repo }) })}\n`)
