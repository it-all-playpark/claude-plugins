/** 「このセッションでは同じコマンドを聞かない」で承認したコマンド: キー（実行ファイル実パス・argv・cwd 実パス）→ 実行した回数 */
export type HostExecApproved = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    'host-exec': { approved: HostExecApproved }
  }
}
