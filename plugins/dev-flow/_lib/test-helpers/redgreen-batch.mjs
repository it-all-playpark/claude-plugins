/**
 * redgreen-batch.mjs — Evaluate の redgreen-verify バッチ呼び出し（label 'redgreen' = start の spawn、1 iteration 1 回）の
 * stub 共有モジュール（issue #683）。start の応答に結果を返す stub は wait を経ずに終わる（実行がすぐ終わったときの start と同じ形）。
 *
 * dev-flow.js は対象 AC の (test_files, impl_files) を引数順に 1 prompt へ並べ、
 * `{results:[{index,red,green,...}]}` を受け取って results[k].index を rgTargets の添字に突合する。
 * routing test は per-AC の応答を組み立てたいので、prompt からペアを復元し ac_results に突合して
 * ac_index を得た上で responseFor(acIndex, pairIndex) を呼び、その返り値（index 抜きの per-pair 結果）を
 * results に組み直す。
 *
 * Export:
 *   - isRedgreenCall(agentType, label): dev-runner-haiku の 'redgreen' 呼び出しか
 *   - parseRedgreenPairs(prompt): [{test_csv, impl_csv}]（引数順）
 *   - redgreenBatchResponse(prompt, acResults, responseFor): {results:[...]}。
 *     responseFor が null を返したペアは results から落とす（script 側の欠落 = fail-safe 経路の再現）
 */

export function isRedgreenCall(agentType, label) {
  return label === 'redgreen' && /(^|:)dev-runner-haiku$/.test(agentType ?? '');
}

export function parseRedgreenPairs(prompt) {
  const m = String(prompt ?? '').match(/^redgreen-verify start (.*)$/m);
  if (!m) return [];
  const args = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
  const pairs = [];
  for (let i = 0; i + 1 < args.length; i += 2) pairs.push({ test_csv: args[i], impl_csv: args[i + 1] });
  return pairs;
}

export function redgreenBatchResponse(prompt, acResults, responseFor) {
  const pairs = parseRedgreenPairs(prompt);
  const results = [];
  pairs.forEach((p, k) => {
    const ac = (acResults ?? []).find((r) => r
      && Array.isArray(r.test_files) && r.test_files.join(',') === p.test_csv
      && Array.isArray(r.impl_files) && r.impl_files.join(',') === p.impl_csv);
    const acIndex = ac ? ac.ac_index : k;
    const body = responseFor(acIndex, k);
    if (body != null) results.push({ index: k, ...body });
  });
  return { results };
}
