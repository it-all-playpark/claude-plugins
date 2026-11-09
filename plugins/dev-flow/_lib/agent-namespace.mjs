// dev-flow の subagent 実体は plugin 配下（plugins/dev-flow/agents/）にあり、harness からは
// `dev-flow:<name>` の namespaced id でしか解決できない。bare 名を agent() へ渡すと
// `agent type '<name>' not found` で throw し run 全体が abort する。
//
// workflow 本体・telemetry・routing test は agent の論理名（bare）を保持し、namespace は
// agent() を呼ぶ直前のこの 1 箇所でのみ付与する。namespace は harness 境界の事情であって
// dev-flow のドメイン語彙ではないため、論理名側へ染み出させない（subagent_invocations の
// 集計キーと、agent 名を静的検査する routing test 群が論理名を前提にしている）。
//
// fail-closed: agentType 欠落・非文字列・既に ':' を含む入力はいずれも throw する。
// 二重付与（`dev-flow:dev-flow:x`）を実行時まで持ち越すと agent not found と同じ症状を
// 別の原因で再発させるため、呼び出し側の誤用をここで止める。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。
export const AGENT_NAMESPACE = 'dev-flow:'

/**
 * agent() へ渡す opts の agentType へ plugin namespace を付与した新しい opts を返す。
 *
 * @param {{agentType: string} & Record<string, unknown>} opts - agentType が bare 論理名の opts
 * @returns {Record<string, unknown>} agentType を namespaced id へ置換した複製
 */
export function nsAgentOpts(opts) {
  const bare = opts == null ? undefined : opts.agentType
  if (typeof bare !== 'string' || bare.trim() === '') {
    throw new Error('nsAgentOpts: opts.agentType が必要（受信: ' + JSON.stringify(bare) + '）')
  }
  if (bare.indexOf(':') !== -1) {
    throw new Error(
      'nsAgentOpts: agentType は bare な論理名で渡す（namespace はここで付与する。受信: '
      + JSON.stringify(bare) + '）',
    )
  }
  return { ...opts, agentType: AGENT_NAMESPACE + bare }
}
