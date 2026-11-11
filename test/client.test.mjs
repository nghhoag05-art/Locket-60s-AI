import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const code = await readFile(new URL('../scripts/ai-image-experimental.js', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../references/hakaiz-ai-catalog.json', import.meta.url), 'utf8'));
const BACKEND_TOKEN = 'backend-private-token-01234567890123456789';
const INPUT = 'https://firebasestorage.googleapis.com/v0/b/locket-img/o/photo.jpg?alt=media&token=photo-token';
const OUTPUT = 'https://ai.example.com/images/abcdefghijklmnopqrstuvwxyz012345.png';

function run(options = {}) {
  const done = [], posts = [], timers = [], logs = [], writes = [];
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
    $persistentStore: {
      read: key => store[key] ?? null,
      write: (value, key) => {
        if (options.throwWrite) throw new Error('storage unavailable');
        writes.push({ key, value });
        store[key] = value;
        return true;
      },
    },
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
  if (options.noWrite) delete context.$persistentStore.write;
  if (options.noHttpClient) delete context.$httpClient;
  if (options.noPost) context.$httpClient = {};
  if (options.noTimer) delete context.setTimeout;
  if (options.noClearTimer) delete context.clearTimeout;
  vm.runInNewContext(code, context, { timeout: 1000, filename: 'ai-image-experimental.js' });
  return {
    done, posts, timers, logs, writes, store,
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

const nativeIds = [
  'okay_wig', 'influencer', 'looks_maxxing', 'toothless', 'bye_brows',
  'bowling_ball', 'blonde_bleached', 'beard', 'bob_cut', 'buns', 'tatted',
  'mohawk', 'braces', 'slimed', 'princess', 'disco_lights', 'cash_money',
  'happy_birthday', 'cutesy', 'sticker_face', 'flower_crown', 'love_bug',
  'wedding', 'cowboy_cowgirl', 'giraffe', 'clown', 'easter_bunney_cutout',
  'easter_chick_cutout', 'bearded', 'leprechaun', 'lucky_face',
  'sweet_hearts', 'elf_cutout', 'santa_cutout', 'frosty',
];

function sentPrompt(harness) {
  assert.equal(harness.posts.length, 1);
  const body = JSON.parse(harness.posts[0].settings.body);
  assert.deepEqual(Object.keys(body).sort(), ['imageUrl', 'prompt']);
  assert.equal(body.imageUrl, INPUT);
  assert.equal(typeof body.prompt, 'string');
  assert.ok(body.prompt.length > 0 && body.prompt.length <= 4096);
  assert.match(body.prompt, /\s/);
  return body.prompt;
}

for (const filterId of nativeIds) {
  test(`native preset ${filterId} dispatches natural-language editing instructions`, () => {
    const h = run({ request: { body: JSON.stringify({ imageUrl: INPUT, filterId }) } });
    const prompt = sentPrompt(h);
    assert.notEqual(prompt, filterId);
    assert.ok(prompt.length > 30);
  });
}

test('the pinned catalog retains all 83 entries, including 27 unsupported compositions', () => {
  assert.equal(catalog.filters.length, 83);
  assert.equal(new Set(catalog.filters.map(filter => filter.id)).size, 83);
  assert.equal(catalog.filters.filter(filter => ['Frames', 'Photobooth'].includes(filter.category)).length, 27);
});

for (const [index, filter] of catalog.filters.entries()) {
  const composition = ['Frames', 'Photobooth'].includes(filter.category);
  test(`catalog ${filter.id} ${composition ? 'does not fabricate frame or multi-shot output' : 'dispatches a real editing instruction'}`, () => {
    const request = index % 2
      ? { imageUrl: INPUT, data: { filter_id: filter.id } }
      : { imageUrl: INPUT, filterId: filter.id };
    const h = run({ request: { body: JSON.stringify(request) } });
    if (composition) {
      assertPass(h);
      assert.equal(JSON.parse(h.store.LOCKET_AI_STATUS).code, 'unsupported_composition');
      const symbolic = run({ request: { body: JSON.stringify({ imageUrl: INPUT, data: { prompt: filter.prompt } }) } });
      assertPass(symbolic);
      assert.equal(JSON.parse(symbolic.store.LOCKET_AI_STATUS).code, 'unsupported_composition');
    } else {
      const prompt = sentPrompt(h);
      assert.ok(prompt.length > 30);
      assert.notEqual(prompt, filter.id);
      if (/^[a-z0-9_]+$/i.test(filter.prompt)) assert.notEqual(prompt, filter.prompt);
      else assert.equal(prompt, filter.prompt, 'natural-language source instructions are preserved');
    }
  });
}

for (const field of ['prompt', 'text_prompt', 'instruction']) {
  for (const nested of [false, true]) {
    test(`${nested ? 'data' : 'root'} ${field} resolves an explicit symbolic alias`, () => {
      const values = { [field]: 'stk_dio_cash' };
      const body = { imageUrl: INPUT, ...(nested ? { data: values } : values) };
      const prompt = sentPrompt(run({ request: { body: JSON.stringify(body) } }));
      assert.match(prompt, /banknotes/i);
      assert.ok(!prompt.includes('stk_dio_cash'));
    });
  }
}

test('catalog IDs and canonical symbolic prompts resolve to the same instructions', () => {
  for (const filter of catalog.filters.filter(filter => !filter.category && /^[a-z0-9_]+$/i.test(filter.prompt))) {
    const byId = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, filterId: filter.id }) } }));
    const byPrompt = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, prompt: filter.prompt }) } }));
    assert.equal(byId, byPrompt, filter.id);
  }
});

test('root explicit user instructions take precedence and remain unchanged', () => {
  const text = 'Add an embroidery label saying photo_mode. Keep the face unchanged.';
  const prompt = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, prompt: `  ${text}  `, filterId: 'stk_dio_cash', data: { prompt: 'beard' } }) } }));
  assert.equal(prompt, text);
});

test('nested explicit user instructions take precedence over preset IDs', () => {
  const prompt = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, filterId: 'beard', data: { instruction: 'Make the background blue.' } }) } }));
  assert.equal(prompt, 'Make the background blue.');
});

test('unknown symbolic keys are never sent as editing instructions', () => {
  const h = run({ request: { body: JSON.stringify({ imageUrl: INPUT, prompt: 'stk_unrecognized_filter', filterId: 'beard' }) } });
  assertPass(h);
  assert.equal(JSON.parse(h.store.LOCKET_AI_STATUS).code, 'unknown_preset');
});

test('canonical holiday bearded is not shadowed by the upstream beard alias', () => {
  const holiday = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, prompt: 'bearded' }) } }));
  const ordinary = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, prompt: 'beard' }) } }));
  const catalogHoliday = sentPrompt(run({ request: { body: JSON.stringify({ imageUrl: INPUT, filterId: 'stk_dio_bearded_holiday' }) } }));
  assert.equal(holiday, catalogHoliday);
  assert.notEqual(holiday, ordinary);
});

for (const field of ['imageUrl', 'image_url', 'inputUrl', 'input_url', 'url', 'downloadUrl', 'download_url']) {
  test(`nested ${field} uses the same input handling as root`, () => {
    const h = run({ request: { body: JSON.stringify({ data: { [field]: INPUT, filter_id: 'stk_dio_toothless' } }) } });
    assert.match(sentPrompt(h), /toothless/i);
  });
}

test('diagnostics contain only fixed stage/code and timestamp, never private request data', () => {
  const h = run();
  h.respond();
  assert.ok(h.writes.length >= 3);
  for (const write of h.writes) {
    assert.equal(write.key, 'LOCKET_AI_STATUS');
    const status = JSON.parse(write.value);
    assert.deepEqual(Object.keys(status).sort(), ['code', 'stage', 'timestamp']);
    assert.ok(['request', 'backend', 'result'].includes(status.stage));
    assert.ok(['received', 'started', 'success'].includes(status.code));
    assert.match(status.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }
  for (const privateValue of [BACKEND_TOKEN, INPUT, OUTPUT, 'ai.example.com', 'Add a red scarf.', 'locket-account-secret', 'private-user-id', 'session=private']) {
    assert.ok(!JSON.stringify(h.writes).includes(privateValue));
  }
});

test('diagnostics explain missing configuration without retaining its value', () => {
  for (const [store, expected] of [[{ LOCKET_AI_ENDPOINT: '' }, 'endpoint_missing'], [{ LOCKET_AI_TOKEN: '' }, 'token_missing']]) {
    const h = run({ store });
    assertPass(h);
    assert.equal(JSON.parse(h.store.LOCKET_AI_STATUS).code, expected);
  }
});

test('diagnostic writes are optional and storage failures cannot prevent editing', () => {
  for (const options of [{ noWrite: true }, { throwWrite: true }]) {
    const h = run(options);
    sentPrompt(h);
    h.respond();
    assert.equal(h.done[0].response.status, 200);
  }
});

test('timeout diagnostics survive a late response without being replaced by success', () => {
  const h = run();
  h.expire();
  const lastStatus = h.store.LOCKET_AI_STATUS;
  assert.equal(JSON.parse(lastStatus).code, 'timeout');
  h.respond();
  assert.equal(h.store.LOCKET_AI_STATUS, lastStatus);
});

test('oversized explicit instructions pass through with a bounded diagnostic', () => {
  const h = run({ request: { body: JSON.stringify({ imageUrl: INPUT, prompt: 'x'.repeat(4097) }) } });
  assertPass(h);
  assert.equal(JSON.parse(h.store.LOCKET_AI_STATUS).code, 'prompt_too_long');
});
