// dev-flow Merge tier phase: merge-tier-facts の checks サブ結果から env_key ごとの CI check が全 green かを
// 判定する純関数群。CI green を根拠に auto-close してよい ENV item を allowlist で限定する
// （AC-3。npm-cache-eperm 等 CI で検証できない ENV key は含めない）。
//
// INLINE COPY POLICY: workflow から参照される最上位宣言だけが tools/sync-inlines.mjs --write で inline 生成される。
// 直接 workflow 側を編集しない。一致は _lib/workflow-inlines.sync.test.mjs が検証する。

// env_key ごとの CI check 名判定 regex。CI green で auto-close してよい ENV key の allowlist を兼ねる
// （npm-cache-eperm 等 CI で検証できない ENV key は含めない）。
export const ENV_CHECK_RES = {
  'turbopack-sandbox': /build|vercel|ci/i,
  'bats-sandbox': /bats/i,
};

// CI green で auto-close してよい ENV key の allowlist（ENV_CHECK_RES の key 集合）。
export const CI_VERIFIABLE_ENV_KEYS = Object.keys(ENV_CHECK_RES);

// checks サブ結果の schema。
export const CHECKS = {
  type: 'object',
  required: ['ok'],
  properties: {
    ok: { type: 'boolean' },
    checks: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'bucket'],
        properties: {
          name: { type: 'string' },
          bucket: { type: 'string' },
        },
      },
    },
    error: { type: 'string' },
  },
};

// checks サブ結果（{name, bucket} の配列）から、指定 env_key に対応する CI check が全 pass かを判定する純関数。
export function envChecksGreen(checks, envKey) {
  const re = ENV_CHECK_RES[envKey];
  if (!re) {
    return { green: false, reason: 'unknown-env-key', checkNames: [] };
  }
  if (!Array.isArray(checks)) {
    return { green: false, reason: 'invalid', checkNames: [] };
  }
  const relevant = checks.filter((c) => c && typeof c.name === 'string' && re.test(c.name));
  if (relevant.length === 0) {
    return { green: false, reason: 'no-matching-checks', checkNames: [] };
  }
  const checkNames = relevant.map((c) => c.name);
  if (relevant.every((c) => c.bucket === 'pass')) {
    return { green: true, reason: 'all-pass', checkNames };
  }
  if (relevant.some((c) => c.bucket === 'pending')) {
    return { green: false, reason: 'pending', checkNames };
  }
  return { green: false, reason: 'not-pass', checkNames };
}
