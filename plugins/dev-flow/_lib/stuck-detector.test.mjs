import { test } from 'vitest';
import assert from 'node:assert/strict';
import { stuckTopicKey, makeSeenTracker } from './stuck-detector.mjs';

// ---- stuckTopicKey ----

test('stuckTopicKey: null → 空文字列', () => {
  assert.equal(stuckTopicKey(null), '');
});

test('stuckTopicKey: undefined → 空文字列', () => {
  assert.equal(stuckTopicKey(undefined), '');
});

test('stuckTopicKey: string passthrough', () => {
  assert.equal(stuckTopicKey('foo bar'), 'foo bar');
  assert.equal(stuckTopicKey(''), '');
});

test('stuckTopicKey: topic プロパティが優先（trim あり）', () => {
  assert.equal(stuckTopicKey({ topic: '  hello  ', description: 'desc' }), 'hello');
  assert.equal(stuckTopicKey({ topic: 'topic-val' }), 'topic-val');
});

test('stuckTopicKey: problem-class の大小文字・空白・_・ハイフンの表記ゆれは同じキーになる', () => {
  const keys = [
    'Input Validation Missing::create-user',
    ' input_validation--missing ::create-user',
    'input-validation-missing::create-user',
  ].map((topic) => stuckTopicKey({ topic }));
  assert.deepEqual(keys, Array(3).fill('input-validation-missing::create-user'));
});

test('stuckTopicKey: `::` より後ろの詳細は大小文字を区別し、trim と空白の圧縮だけをする', () => {
  assert.notEqual(
    stuckTopicKey({ topic: 'test-missing::src/Foo.ts' }),
    stuckTopicKey({ topic: 'test-missing::src/foo.ts' }),
  );
  assert.equal(stuckTopicKey({ topic: 'logic-bug::  Resolve   Gate  ' }), 'logic-bug::Resolve Gate');
});

test('stuckTopicKey: `::` を含まない topic でも problem-class の正規化がかかる', () => {
  assert.equal(stuckTopicKey({ topic: ' Edge_Case  Unhandled- ' }), 'edge-case-unhandled');
});

test('stuckTopicKey: 空 topic は topic を使わず次へ fallback', () => {
  // 空 topic + file あり → `file::description`
  assert.equal(
    stuckTopicKey({ topic: '  ', file: 'src/foo.ts', description: 'unused import' }),
    'src/foo.ts::unused import',
  );
});

test('stuckTopicKey: 空 topic + file あり + description なし → file::JSON.stringify', () => {
  const x = { topic: '', file: 'src/bar.ts' };
  assert.equal(stuckTopicKey(x), `src/bar.ts::${JSON.stringify(x)}`);
});

test('stuckTopicKey: topic なし + file あり → `file::description`', () => {
  assert.equal(
    stuckTopicKey({ file: 'src/foo.ts', description: 'unused import' }),
    'src/foo.ts::unused import',
  );
});

test('stuckTopicKey: topic なし + file あり + description が null → `file::JSON.stringify`', () => {
  const x = { file: 'src/baz.ts', description: null };
  assert.equal(stuckTopicKey(x), `src/baz.ts::${JSON.stringify(x)}`);
});

test('stuckTopicKey: topic なし + file なし + description あり（非空）→ String(description)', () => {
  assert.equal(
    stuckTopicKey({ description: 'something wrong' }),
    'something wrong',
  );
});

test('stuckTopicKey: topic なし + file なし + description が空文字 → JSON.stringify', () => {
  const x = { description: '' };
  assert.equal(stuckTopicKey(x), JSON.stringify(x));
});

test('stuckTopicKey: topic なし + file なし + description なし → JSON.stringify', () => {
  const x = { severity: 'major' };
  assert.equal(stuckTopicKey(x), JSON.stringify(x));
});

// ---- makeSeenTracker ----

test('makeSeenTracker: 同一 topic 2 回 register → threshold=2 で stuckTopics に含まれる', () => {
  const tracker = makeSeenTracker(2);
  const item = { topic: 'T1', description: 'some issue' };
  tracker.register(item);
  assert.deepEqual(tracker.stuckTopics(), []);
  tracker.register(item);
  assert.deepEqual(tracker.stuckTopics(), ['t1']);
});

test('makeSeenTracker: 表記だけが違う topic 2 回 register → threshold=2 で stuckTopics に 1 件入る', () => {
  const tracker = makeSeenTracker(2);
  tracker.register({ topic: 'Input Validation Missing::create-user' });
  tracker.register({ topic: ' input_validation--missing ::create-user' });
  assert.deepEqual(tracker.stuckTopics(), ['input-validation-missing::create-user']);
});

test('makeSeenTracker: 1 回では stuckTopics に含まれない', () => {
  const tracker = makeSeenTracker(2);
  tracker.register({ topic: 'T1' });
  assert.deepEqual(tracker.stuckTopics(), []);
});

test('makeSeenTracker: prior() が挿入順で最新 item を返す', () => {
  const tracker = makeSeenTracker(2);
  const a = { topic: 'A', v: 1 };
  const b = { topic: 'B', v: 2 };
  tracker.register(a);
  tracker.register(b);
  assert.deepEqual(tracker.prior(), [a, b]);
});

test('makeSeenTracker: 同一 topic 再 register で item が最新版に上書きされ count が増える', () => {
  const tracker = makeSeenTracker(3);
  const v1 = { topic: 'X', version: 1 };
  const v2 = { topic: 'X', version: 2 };
  const v3 = { topic: 'X', version: 3 };
  tracker.register(v1);
  tracker.register(v2);
  tracker.register(v3);
  // prior() は最新 item v3 を返す
  assert.deepEqual(tracker.prior(), [v3]);
  // count=3 で threshold=3 を満たす
  assert.deepEqual(tracker.stuckTopics(), ['x']);
});

test('makeSeenTracker: threshold=Infinity で stuckTopics() は常に []', () => {
  const tracker = makeSeenTracker(Infinity);
  for (let i = 0; i < 100; i++) {
    tracker.register({ topic: 'T', i });
  }
  assert.deepEqual(tracker.stuckTopics(), []);
});

test('makeSeenTracker: 異なる topic は独立カウント', () => {
  const tracker = makeSeenTracker(2);
  tracker.register({ topic: 'A' });
  tracker.register({ topic: 'B' });
  tracker.register({ topic: 'A' });
  // A は 2 回 → stuck、B は 1 回 → not stuck
  assert.deepEqual(tracker.stuckTopics(), ['a']);
  // prior() は A と B 両方を含む
  assert.equal(tracker.prior().length, 2);
});

test('makeSeenTracker: string item は文字列 key で tracking される', () => {
  const tracker = makeSeenTracker(2);
  tracker.register('topic-string');
  tracker.register('topic-string');
  assert.deepEqual(tracker.stuckTopics(), ['topic-string']);
});
