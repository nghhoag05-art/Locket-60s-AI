import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../scripts/ai-setup.js', import.meta.url), 'utf8');
const origin = 'http://locket-ai-setup.invalid';
const token = 'local-backend-token-for-tests-only-123';
function run(request, store = new Map()) {
  const calls = [];
  vm.runInNewContext(code, {
    $request: request,
    $persistentStore: { read: key => store.get(key), write: (value, key) => (store.set(key, value), true) },
    $done: value => calls.push(value)
  }, { timeout: 500 });
  assert.equal(calls.length, 1);
  return { value: calls[0], store };
}
function body(store, fields) {
  return new URLSearchParams({ nonce: store.get('LOCKET_AI_SETUP_NONCE'), ...fields }).toString();
}
test('setup page stores a nonce and never renders an existing connection token', () => {
  const store = new Map([['LOCKET_AI_TOKEN', token], ['LOCKET_AI_ENDPOINT', 'https://ai.example.com/v1/images/edit']]);
  const { value } = run({ url: origin + '/', method: 'GET' }, store);
  assert.equal(value.response.status, 200);
  assert.ok(store.get('LOCKET_AI_SETUP_NONCE'));
  assert.ok(!value.response.body.includes(token));
  assert.match(value.response.headers['Content-Security-Policy'], /form-action 'self'/);
});
test('saves only HTTPS endpoint and separate backend token', () => {
  const store = new Map();
  run({ url: origin + '/', method: 'GET' }, store);
  const { value } = run({ url: origin + '/save', method: 'POST', headers: { Origin: origin }, body: body(store, { endpoint: 'https://ai.example.com', token }) }, store);
  assert.equal(value.response.status, 303);
  assert.equal(store.get('LOCKET_AI_ENDPOINT'), 'https://ai.example.com/v1/images/edit');
  assert.equal(store.get('LOCKET_AI_TOKEN'), token);
  assert.equal(store.get('LOCKET_AI_SETUP_NONCE'), '');
});
test('forged origin and replayed or missing nonce do not update settings', () => {
  const store = new Map();
  run({ url: origin + '/', method: 'GET' }, store);
  const payload = body(store, { endpoint: 'https://ai.example.com', token });
  assert.equal(run({ url: origin + '/save', method: 'POST', headers: { Origin: 'https://other.example' }, body: payload }, store).value.response.status, 403);
  assert.equal(run({ url: origin + '/save', method: 'POST', body: 'nonce=wrong' }, store).value.response.status, 403);
  assert.equal(store.get('LOCKET_AI_TOKEN'), undefined);
});
test('rejects insecure URL, credentials, query strings and short tokens', () => {
  for (const endpoint of ['http://ai.example.com', 'https://user:pass@ai.example.com', 'https://ai.example.com/?token=x', 'https://ai.example.com/other', 'https://a..example.com']) {
    const store = new Map();
    run({ url: origin + '/', method: 'GET' }, store);
    const { value } = run({ url: origin + '/save', method: 'POST', body: body(store, { endpoint, token }) }, store);
    assert.equal(value.response.status, 400, endpoint);
    assert.equal(store.get('LOCKET_AI_TOKEN'), undefined);
  }
});
test('clear requires valid form and removes both settings', () => {
  const store = new Map([['LOCKET_AI_TOKEN', token], ['LOCKET_AI_ENDPOINT', 'https://ai.example.com/v1/images/edit']]);
  run({ url: origin + '/', method: 'GET' }, store);
  assert.equal(run({ url: origin + '/clear', method: 'POST', body: body(store, {}) }, store).value.response.status, 303);
  assert.equal(store.get('LOCKET_AI_TOKEN'), '');
  assert.equal(store.get('LOCKET_AI_ENDPOINT'), '');
});
test('setup rejects a token the client would not accept', () => {
  for (const invalidToken of ['short', 'a'.repeat(257), 'x'.repeat(30) + '\r\nInjected: value']) {
    const store = new Map();
    run({ url: origin + '/', method: 'GET' }, store);
    const { value } = run({ url: origin + '/save', method: 'POST', body: body(store, { endpoint: 'https://ai.example.com', token: invalidToken }) }, store);
    assert.equal(value.response.status, 400);
    assert.equal(store.get('LOCKET_AI_TOKEN'), undefined);
  }
});
test('unrelated requests pass through', () => {
  assert.equal(Object.keys(run({ url: 'https://example.com/', method: 'GET' }).value).length, 0);
});

test('setup shows catalog version and only whitelisted diagnostic text', () => {
  const marker = 'test-only-private-value-never-render';
  const store = new Map([
    ['LOCKET_AI_CATALOG_VERSION', 'hakaiz-9c2ea58-83'],
    ['LOCKET_AI_STATUS', JSON.stringify({ stage: 'backend', code: 'transport_error', imageUrl: marker, token: marker })],
  ]);
  const html = run({ url: origin + '/', method: 'GET' }, store).value.response.body;
  assert.match(html, /Đã áp dụng danh mục Hakaiz gồm 83 mục/);
  assert.match(html, /Không kết nối được backend/);
  assert.ok(!html.includes(marker));
});

test('malformed or unknown stored diagnostics never reflect private text or HTML', () => {
  const marker = '<img src=x onerror=private_test_marker>';
  for (const status of [marker, JSON.stringify({ code: marker }), JSON.stringify(null), JSON.stringify({ code: '__proto__' })]) {
    const store = new Map([['LOCKET_AI_STATUS', status], ['LOCKET_AI_CATALOG_VERSION', marker]]);
    const html = run({ url: origin + '/', method: 'GET' }, store).value.response.body;
    assert.match(html, /Chưa ghi nhận yêu cầu tạo ảnh/);
    assert.ok(!html.includes(marker));
    assert.ok(!html.includes('private_test_marker'));
  }
});
