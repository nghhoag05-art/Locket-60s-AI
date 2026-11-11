import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../scripts/firebase-config-request.js', import.meta.url), 'utf8');
const url = 'https://firebaseremoteconfig.googleapis.com/v1/projects/locket-4252a/namespaces/firebase:fetch';

function run(request, extra = {}) {
  const completed = [];
  vm.runInNewContext(script, { $request: request, $done: result => completed.push(JSON.parse(JSON.stringify(result))), ...extra });
  assert.equal(completed.length, 1);
  return completed[0];
}

test('Firebase fetch removes conditional validators while preserving authentication and body', () => {
  const headers = {
    'If-None-Match': 'old-template', 'if-modified-since': 'old-time', 'X-Goog-If-None-Match': 'old-google-template',
    Authorization: 'test-only-account-token', 'X-Firebase-AppCheck': 'test-only-app-check', 'Content-Type': 'application/json',
  };
  const request = { url, headers, body: '{"private":"not-read"}' };
  assert.deepEqual(run(request), { headers: {
    Authorization: headers.Authorization, 'X-Firebase-AppCheck': headers['X-Firebase-AppCheck'], 'Content-Type': 'application/json',
  } });
  assert.equal(request.body, '{"private":"not-read"}');
  assert.equal(request.headers['If-None-Match'], 'old-template');
});

test('unrelated projects, fake domains and response contexts pass through unchanged', () => {
  for (const wrong of [url.replace('locket-4252a', 'unrelated-project'), url.replace('.googleapis.com/', '.googleapis.com.evil.example/'), url.replace('https:', 'http:')]) {
    assert.deepEqual(run({ url: wrong, headers: { 'If-None-Match': 'keep' } }), {});
  }
  assert.deepEqual(run({ url, headers: {} }, { $response: {} }), {});
});

test('missing or invalid request headers are left untouched', () => {
  for (const headers of [undefined, null, 'invalid', []]) assert.deepEqual(run({ url, headers }), {});
  assert.deepEqual(run(null), {});
});
