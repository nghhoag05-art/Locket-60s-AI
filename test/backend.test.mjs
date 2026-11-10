import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import { createServer, readConfig, createGeminiEditor, validateInputUrl, isPublicAddress } from '../backend/server.mjs';
import { FileImageStore, imageType } from '../backend/storage.mjs';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(rgba) {
  function chunk(type, data) {
    const name = Buffer.from(type); const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([name, data])));
    return Buffer.concat([length, name, data, crc]);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from([0, ...rgba]))), chunk('IEND', Buffer.alloc(0))]);
}
const INPUT = png([255, 0, 0, 255]); const OUTPUT = png([0, 0, 255, 255]);
const TOKEN = 'test-only-backend-access-token-123456';
const SOURCE = 'https://firebasestorage.googleapis.com/v0/b/test/o/input.png?alt=media';
const PUBLIC = 'https://images.example.com';
function config(overrides = {}) {
  return { ...readConfig({ GEMINI_API_KEY: 'test-only-provider-key', BACKEND_ACCESS_TOKEN: TOKEN, PUBLIC_BASE_URL: PUBLIC }), ...overrides };
}
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const downloadFetch = async () => new Response(INPUT, { headers: { 'content-type': 'image/png' } });
async function fixture(t, options = {}) {
  const tempPrefix = path.join(path.resolve(os.tmpdir()), 'locket-ai-test-');
  const directory = await fs.mkdtemp(tempPrefix);
  const server = createServer({ config: config({ dataDir: directory, ...options.config }), fetchImpl: downloadFetch, lookup: publicLookup, editImage: async () => ({ bytes: OUTPUT, mime: 'image/png' }), ...options, ...(options.config ? { config: config({ dataDir: directory, ...options.config }) } : {}) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory);
    assert.ok(target.startsWith(tempPrefix) && target !== path.resolve(os.tmpdir()));
    await fs.rm(target, { recursive: true, force: true });
  });
  const post = (body = { imageUrl: SOURCE, prompt: 'Make the background blue.' }, headers = {}) => fetch(`${origin}/v1/images/edit`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { server, origin, post, directory };
}

test('real provider adapter request produces stored image bytes and a distinct output URL', async t => {
  const requests = [];
  const providerFetch = async (url, options) => {
    requests.push({ url, options });
    if (url === SOURCE) return downloadFetch();
    assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent');
    assert.equal(options.headers['x-goog-api-key'], 'test-only-provider-key');
    assert.equal(options.headers.Authorization, undefined);
    const body = JSON.parse(options.body);
    assert.equal(body.contents[0].parts[0].inlineData.data, INPUT.toString('base64'));
    assert.equal(body.contents[0].parts[1].text, 'Make the background blue.');
    assert.deepEqual(body.generationConfig.responseModalities, ['TEXT', 'IMAGE']);
    return Response.json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: OUTPUT.toString('base64') } }] }, finishReason: 'STOP' }] });
  };
  const { origin, post } = await fixture(t, { fetchImpl: providerFetch, editImage: undefined });
  const response = await post(); assert.equal(response.status, 200);
  const body = await response.json();
  assert.match(body.outputUrl, /^https:\/\/images\.example\.com\/images\/[a-f0-9]{48}\.png$/);
  assert.notEqual(body.outputUrl, SOURCE); assert.equal(body.expiresInSeconds, 900);
  const image = await fetch(origin + new URL(body.outputUrl).pathname);
  assert.equal(image.status, 200); assert.equal(image.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), OUTPUT);
  assert.notDeepEqual(OUTPUT, INPUT); assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers.Authorization, undefined);
  assert.equal(requests[0].options.redirect, 'error');
});

test('missing API key reports not configured and never attempts generation', async t => {
  let fetched = false;
  const { origin, post } = await fixture(t, { config: { apiKey: '' }, fetchImpl: async () => { fetched = true; } });
  assert.deepEqual(await (await fetch(origin + '/health')).json(), { ok: true, configured: false });
  const response = await post(); assert.equal(response.status, 503); assert.equal((await response.json()).error.code, 'not_configured');
  assert.equal(fetched, false);
});

test('invalid backend token is rejected before input download', async t => {
  let fetched = false;
  const { post } = await fixture(t, { fetchImpl: async () => { fetched = true; } });
  const response = await post(undefined, { Authorization: 'Bearer wrong' });
  assert.equal(response.status, 401); assert.equal(fetched, false);
});

test('invalid inputs and content types are rejected without synthetic success', async t => {
  const { post } = await fixture(t);
  for (const body of ['{broken', [], { imageUrl: SOURCE }, { imageUrl: SOURCE, prompt: '  ' }, { imageUrl: SOURCE, prompt: 'x'.repeat(4097) }]) {
    const response = await post(body); assert.equal(response.status, 400); assert.equal(typeof (await response.json()).error.code, 'string');
  }
  assert.equal((await post(undefined, { 'Content-Type': 'application/jsonp' })).status, 415);
  assert.equal((await post('x'.repeat(17000))).status, 413);
});

test('URL validation blocks credentials, ports, private hosts, unapproved hosts and HTTP', async () => {
  for (const url of ['http://firebasestorage.googleapis.com/a.png', 'https://localhost/a.png', 'https://127.0.0.1/a.png', 'https://evil.example/a.png', 'https://user:password@firebasestorage.googleapis.com/a.png', 'https://firebasestorage.googleapis.com:444/a.png', SOURCE + '#fragment']) {
    await assert.rejects(validateInputUrl(url, config(), publicLookup), error => error.status === 400);
  }
  for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.0.1', '100.64.0.1', '::1', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address);
  assert.equal(isPublicAddress('8.8.8.8'), true); assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
  await assert.rejects(validateInputUrl(SOURCE, config(), async () => [{ address: '10.0.0.1' }]), error => error.code === 'unsafe_image_host');
});

test('unsafe URL never reaches the downloader', async t => {
  let fetched = false;
  const { post } = await fixture(t, { fetchImpl: async () => { fetched = true; } });
  const response = await post({ imageUrl: 'https://evil.example/private.png', prompt: 'edit' });
  assert.equal(response.status, 400); assert.equal(fetched, false);
});

test('input downloader rejects redirects and non-image bytes', async t => {
  const { post } = await fixture(t, { fetchImpl: async (_, options) => { assert.equal(options.redirect, 'error'); return new Response('<html>no image</html>', { headers: { 'content-type': 'image/png' } }); } });
  const response = await post(); assert.equal(response.status, 415); assert.equal((await response.json()).error.code, 'invalid_image');
});

test('input download size and MIME bounds are enforced', async t => {
  const large = await fixture(t, { config: { maxImageBytes: 1024 }, fetchImpl: async () => new Response(INPUT, { headers: { 'content-type': 'image/png', 'content-length': '2048' } }) });
  assert.equal((await large.post()).status, 413);
  const badMime = await fixture(t, { fetchImpl: async () => new Response(INPUT, { headers: { 'content-type': 'text/html' } }) });
  assert.equal((await badMime.post()).status, 415);
});

test('Gemini blocked, empty, malformed, oversized and invalid output responses stay errors', async () => {
  const cases = [
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'generation_blocked'],
    [{ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }, 'no_generated_image'],
    [{ candidates: [{ content: { parts: [{ text: 'I cannot edit this image.' }] } }] }, 'no_generated_image'],
    [{ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'not base64!' } }] } }] }, 'invalid_generated_image'],
    [{ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/jpeg', data: OUTPUT.toString('base64') } }] } }] }, 'invalid_generated_image'],
  ];
  for (const [payload, code] of cases) {
    const edit = createGeminiEditor(config(), async () => Response.json(payload));
    await assert.rejects(edit({ image: { bytes: INPUT, mime: 'image/png' }, prompt: 'edit' }), error => error.status >= 400 && error.code === code);
  }
  const malformed = createGeminiEditor(config(), async () => new Response('not JSON'));
  await assert.rejects(malformed({ image: { bytes: INPUT, mime: 'image/png' }, prompt: 'edit' }), error => error.code === 'invalid_provider_response');
  const tooLarge = createGeminiEditor(config({ maxProviderBytes: 10 }), async () => Response.json({ ignored: 'x'.repeat(30) }));
  await assert.rejects(tooLarge({ image: { bytes: INPUT, mime: 'image/png' }, prompt: 'edit' }), error => error.code === 'provider_response_too_large');
});

test('provider auth or rate failures do not leak upstream response content', async () => {
  for (const status of [401, 429, 500]) {
    const edit = createGeminiEditor(config(), async () => new Response('private provider diagnostics test-only-provider-key', { status }));
    await assert.rejects(edit({ image: { bytes: INPUT, mime: 'image/png' }, prompt: 'edit' }), error => {
      assert.equal(error.status, status === 429 ? 429 : 502);
      assert.equal(error.message.includes('test-only-provider-key'), false); return true;
    });
  }
  const timeout = createGeminiEditor(config(), async () => { throw new DOMException('timeout', 'TimeoutError'); });
  await assert.rejects(timeout({ image: { bytes: INPUT, mime: 'image/png' }, prompt: 'edit' }), error => error.code === 'provider_unavailable');
});

test('provider failure leaves the edit endpoint as an error, never the original URL', async t => {
  const { post } = await fixture(t, { editImage: async () => { throw new Error('private key should not be exposed'); } });
  const response = await post(); assert.equal(response.status, 500);
  const body = await response.json(); assert.equal(body.outputUrl, undefined); assert.equal(JSON.stringify(body).includes('private key'), false);
});

test('backend rate limit prevents a second generation within the window', async t => {
  let edited = 0;
  const { post } = await fixture(t, { config: { rateLimit: 1 }, editImage: async () => { edited++; return { bytes: OUTPUT, mime: 'image/png' }; } });
  assert.equal((await post()).status, 200);
  const response = await post(); assert.equal(response.status, 429); assert.equal((await response.json()).error.code, 'backend_rate_limited'); assert.equal(edited, 1);
});

test('backend concurrency limit avoids concurrent billable requests', async t => {
  let release; let started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const wait = new Promise(resolve => { release = resolve; });
  const { post } = await fixture(t, { editImage: async () => { started(); await wait; return { bytes: OUTPUT, mime: 'image/png' }; } });
  const first = post(); await startedPromise;
  try { const second = await post(); assert.equal(second.status, 429); assert.equal((await second.json()).error.code, 'backend_busy'); }
  finally { release(); await first; }
});

test('generated image expiry and path validation are enforced', async t => {
  let time = Date.now();
  const { directory } = await fixture(t);
  const store = new FileImageStore(directory, 30000, () => time);
  t.after(() => store.close());
  const filename = await store.save(OUTPUT, 'image/png');
  assert.equal((await store.read(filename)).mime, 'image/png');
  assert.equal(await store.read('../.env'), null);
  time += 60000; assert.equal(await store.read(filename), null);
});

test('config requires HTTPS public origin and rejects secret-bearing URLs', () => {
  for (const url of ['http://example.com', 'https://user:secret@example.com', 'https://example.com/path', 'https://example.com?key=secret']) assert.throws(() => readConfig({ PUBLIC_BASE_URL: url }));
  assert.throws(() => readConfig({ GEMINI_IMAGE_MODEL: '../anything' }));
  assert.equal(imageType(Buffer.from('not an image')), null);
});
