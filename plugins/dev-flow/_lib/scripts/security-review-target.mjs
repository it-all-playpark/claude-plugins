// security-review-target.mjs - unified diff が pr-iterate の security review の対象か（_lib/security-review-target.mjs の
// classifySecurityReviewTarget）を判定する CLI（issue #1063）。secfloor-classify.sh（dev-flow の Security floor）と
// pr-iterate-prerun.sh（単体 /pr-iterate）が呼ぶ。規則は security-review-target.mjs の 1 か所に置き、shell 側に写しを持たない。
//
// Usage: node security-review-target.mjs < <unified diff>
// stdout: {"target": boolean, "reasons": ["<規則>: <path>", ...]}（1 行）
import { readFileSync } from 'node:fs'
import { classifySecurityReviewTarget } from '../security-review-target.mjs'

if (process.argv.length > 2) throw new Error('usage: security-review-target.mjs < <unified diff>')
process.stdout.write(`${JSON.stringify(classifySecurityReviewTarget(readFileSync(0, 'utf8')))}\n`)
