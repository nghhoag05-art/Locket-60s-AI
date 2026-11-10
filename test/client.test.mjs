import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../scripts/ai-image-experimental.js', import.meta.url), 'utf8');
const BACKEND_TOKEN = 'backend-private-token-01234567890123456789';
const INPUT = 'https://firebasestorage.googleapis.com/v0/b/locket-img/o/photo.jpg?alt=media&token=photo-token';
const OUTPUT = 'https://ai.example.com/images/abcdefghijklmnopqrstuvwxyz012345.png';

function run(options = {}) {
  const done = [], posts = [], timers = [], logs = [];
  const store = {
    LOCKET_AI_ENDPOINT: 'https://ai.example.com',
    LOCKET_AI_TOKEN: BACKEND_TOKEN,
    ...options.store,
  };
  const request = {
    url: 'https://api.locketcamera.com/generateFilteredImage',
    method: 'POST',
    headers: { Authorization: 'Bearer locket-account-secret', Cookie: 'session=private' },
    body: JSON.stringify({ imageUrl: INPUT, prompt: '  Add a red scarf.  ', uid: 'private-user-id' }),
    ...options.request,
  };
  const context = {
    $request: request,
    $persistentStore: { read: key => store[key] ?? null },
    $httpClient: { post: (settings, callback) => {
      posts.push({ settings: JSON.parse(JSON.stringify(settings)), callback });
      if (options.throwPost) throw new Error('transport exploded');
    } },
    $done: result => done.push(JSON.parse(JSON.stringify(result ?? {}))),
    console: { log: (...values) => logs.push(values.join(' ')) },
    setTimeout: (callback, delay) => {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout: timer => { timer.cleared = true; },
  };
  if (options.responseContext) context.$response = { status: 200, body: '{}' };
  if (options.noRequest) delete context.$request;
  if (options.noStore) delete context.$persistentStore;
  if (options.noHttpClient) delete context.$httpClient;
  if (options.noPost) context.$httpClient = {};
  if (options.noTimer) delete context.setTimeout;
  if (options.noClearTimer) delete context.clearTimeout;
  vm.runInNewContext(code, context, { timeout: 1000, filename: 'ai-image-experimental.js' });
  return {
    done, posts, timers, logs,
    respond(error = null, response = { status: 200 }, body = JSON.stringify({ outputUrl: OUTPUT })) {
      assert.equal(posts.length, 1, 'one backend request must have been scheduled');
      posts[0].callback(error, response, body);
    },
    expire() { for (const timer of timers) if (!timer.cleared) timer.callback(); },
  };
}

function assertPass(harness) {
  assert.deepEqual(harness.done, [{}]);
  assert.equal(harness.posts.length, 0);
}

test('successful backend result becomes the Locket result without sending account credentials', () => {
  const h = run();
  assert.equal(h.done.length, 0, 'must not claim success before the backend completes');
  assert.equal(h.posts.length, 1);
  const { settings } = h.posts[0];
  assert.equal(settings.url, 'https://ai.example.com/v1/images/edit');
  assert.equal(settings.headers.Authorization, `Bearer ${BACKEND_TOKEN}`);
  assert.equal(settings.headers['Content-Type'], 'application/json');
  assert.equal(settings.timeout, 45, 'Surge timeout option is in seconds');
  assert.equal(settings['auto-redirect'], false);
  assert.equal(settings['auto-cookie'], false);
  assert.deepEqual(JSON.parse(settings.body), { imageUrl: INPUT, prompt: 'Add a red scarf.' });
  assert.ok(!JSON.stringify(settings).includes('locket-account-secret'));
  assert.ok(!JSON.stringify(settings).includes('private-user-id'));
  assert.ok(!JSON.stringify(settings).includes('session=private'));
  assert.equal(h.timers[0].delay, 50000);
  h.respond();
  assert.equal(h.done.length, 1);
  const response = h.done[0].response;
  assert.equal(response.status, 200);
  const payload = JSON.parse(response.body);
  for (const container of [payload.result, payload.result.data]) {
    for (const key of ['outputUrl', 'output_url', 'url', 'imageUrl', 'image_url']) assert.equal(container[key], OUTPUT);
  }
  assert.ok(!response.body.includes(INPUT));
  assert.ok(!h.logs.join('\n').includes(BACKEND_TOKEN));
  assert.ok(!h.logs.join('\n').includes('locket-account-secret'));
});

test('the endpoint may be stored as the complete API URL', () => {
  const h = run({ store: { LOCKET_AI_ENDPOINT: 'https://ai.example.com/v1/images/edit' } });
  assert.equal(h.posts[0].settings.url, 'https://ai.example.com/v1/images/edit');
  h.respond();
  assert.equal(h.done[0].response.status, 200);
});

test('nested image and prompt fields are supported without forwarding extra data', () => {
  const h = run({ request: { body: JSON.stringify({ data: { image_url: INPUT, instruction: 'Make the background blue.', user_id: 'not-forwarded' } }) } });
  assert.deepEqual(JSON.parse(h.posts[0].settings.body), { imageUrl: INPUT, prompt: 'Make the background blue.' });
});

test('both exact Locket hosts and a generation query are accepted', () => {
  const h = run({ request: { url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage/?test=1' } });
  assert.equal(h.posts.length, 1);
});

test('known filter ID receives an explicit editing prompt', () => {
  const h = run({ request: { body: JSON.stringify({ imageUrl: INPUT, filterId: 'beard' }) } });
  assert.equal(h.posts.length, 1);
  assert.match(JSON.parse(h.posts[0].settings.body).prompt, /beard/i);
});

for (const filterId of ['blonde_bleached', 'bob_cut', 'clown', 'princess', 'wedding', 'cowboy_cowgirl', 'happy_birthday', 'disco_lights', 'slimed', 'cutesy']) {
  test(`known filter ${filterId} has a supported prompt`, () => {
    const h = run({ request: { body: JSON.stringify({ imageUrl: INPUT, data: { filter_id: filterId } }) } });
    assert.equal(h.posts.length, 1);
    assert.ok(JSON.parse(h.posts[0].settings.body).prompt.length > 20);
  });
}

for (const [label, options] of [
  ['missing image', { request: { body: JSON.stringify({ prompt: 'Do something.' }) } }],
  ['missing prompt and filter', { request: { body: JSON.stringify({ imageUrl: INPUT }) } }],
  ['unknown filter', { request: { body: JSON.stringify({ imageUrl: INPUT, filterId: 'unrecognized_filter' }) } }],
  ['malformed JSON', { request: { body: '{broken json' } }],
  ['array JSON', { request: { body: '[]' } }],
  ['null JSON', { request: { body: 'null' } }],
  ['oversized body', { request: { body: ' '.repeat(65537) } }],
  ['non-POST method', { request: { method: 'GET' } }],
  ['wrong endpoint', { request: { url: 'https://api.locketcamera.com/changeProfileInfo' } }],
  ['suffix hostname', { request: { url: 'https://api.locketcamera.com.evil.example/generateFilteredImage' } }],
  ['unrelated hostname', { request: { url: 'https://elsewhere.example.com/generateFilteredImage' } }],
  ['response context', { responseContext: true }],
  ['no request', { noRequest: true }],
  ['no persistent store', { noStore: true }],
  ['missing endpoint', { store: { LOCKET_AI_ENDPOINT: '' } }],
  ['missing token', { store: { LOCKET_AI_TOKEN: '' } }],
  ['short token', { store: { LOCKET_AI_TOKEN: 'too-short' } }],
  ['header-injection token', { store: { LOCKET_AI_TOKEN: `${BACKEND_TOKEN}\r\nX-Foo: injected` } }],
  ['no HTTP client', { noHttpClient: true }],
  ['no POST client', { noPost: true }],
  ['no watchdog timer', { noTimer: true }],
]) {
  test(`passes through ${label}`, () => assertPass(run(options)));
}

for (const endpoint of ['http://ai.example.com', 'https://user:pass@ai.example.com', 'https://ai.example.com?token=bad', 'https://ai.example.com/#token', 'https://ai.example.com/other/path']) {
  test(`rejects backend endpoint ${endpoint}`, () => assertPass(run({ store: { LOCKET_AI_ENDPOINT: endpoint } })));
}

for (const imageUrl of ['http://images.example.com/photo.png', 'https://user:secret@images.example.com/photo.png', 'https://images.example.com/photo.png#fragment', 'https://images.example.com/photo with space.png']) {
  test(`passes through unsupported input URL ${imageUrl}`, () => assertPass(run({ request: { body: JSON.stringify({ imageUrl, prompt: 'Add a scarf.' }) } })));
}

for (const [label, error, response, body] of [
  ['transport error', 'network failed', { status: 200 }, JSON.stringify({ outputUrl: OUTPUT })],
  ['HTTP failure', null, { status: 503 }, JSON.stringify({ outputUrl: OUTPUT })],
  ['missing response', null, undefined, JSON.stringify({ outputUrl: OUTPUT })],
  ['malformed JSON', null, { status: 200 }, '{invalid'],
  ['array body', null, { status: 200 }, '[]'],
  ['missing output', null, { status: 200 }, '{}'],
  ['oversized response', null, { status: 200 }, ' '.repeat(65537)],
]) {
  test(`backend ${label} never becomes success`, () => {
    const h = run();
    h.posts[0].callback(error, response, body);
    assert.deepEqual(h.done, [{}]);
  });
}

for (const outputUrl of [
  INPUT,
  'http://ai.example.com/images/abcdefghijklmnopqrstuvwxyz012345.png',
  'https://evil.example.com/images/abcdefghijklmnopqrstuvwxyz012345.png',
  'https://user:secret@ai.example.com/images/abcdefghijklmnopqrstuvwxyz012345.png',
  `${OUTPUT}?token=unexpected`,
  `${OUTPUT}#unexpected`,
  'https://ai.example.com/wrong/abcdefghijklmnopqrstuvwxyz012345.png',
  'https://ai.example.com/images/short.png',
  'https://ai.example.com/images/abcdefghijklmnopqrstuvwxyz012345.svg',
]) {
  test(`rejects unsafe or unverified output ${outputUrl}`, () => {
    const h = run();
    h.respond(null, { status: 200 }, JSON.stringify({ outputUrl }));
    assert.deepEqual(h.done, [{}]);
  });
}

test('returning the exact input image URL is rejected even on the backend origin', () => {
  const h = run({ request: { body: JSON.stringify({ imageUrl: OUTPUT, prompt: 'Change something.' }) } });
  h.respond();
  assert.deepEqual(h.done, [{}]);
});

test('a duplicate backend callback finishes exactly once', () => {
  const h = run();
  h.respond();
  h.respond();
  assert.equal(h.done.length, 1);
  assert.equal(h.done[0].response.status, 200);
});

test('an error followed by a late successful callback remains passthrough', () => {
  const h = run();
  h.respond('failed');
  h.respond();
  assert.deepEqual(h.done, [{}]);
});

test('the watchdog completes before the module timeout and ignores late success', () => {
  const h = run();
  h.expire();
  assert.deepEqual(h.done, [{}]);
  h.respond();
  assert.deepEqual(h.done, [{}]);
});

test('a synchronous client exception preserves the original request', () => {
  const h = run({ throwPost: true });
  assert.deepEqual(h.done, [{}]);
  h.expire();
  assert.deepEqual(h.done, [{}]);
});

test('clearTimeout is optional in the JSC environment', () => {
  const h = run({ noClearTimer: true });
  h.respond();
  h.expire();
  assert.equal(h.done.length, 1);
});
