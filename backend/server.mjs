import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileImageStore, imageType } from './storage.mjs';

const DEFAULT_HOSTS = ['firebasestorage.googleapis.com', 'storage.googleapis.com', 'cdn.locketcamera.com'];
const MiB = 1024 * 1024;
export class AppError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new AppError(status, code, message); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function integer(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Invalid ${name}`);
  return n;
}
function publicOrigin(value) {
  if (!value) return '';
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('PUBLIC_BASE_URL must be an HTTPS origin without credentials, path or query');
  }
  return url.origin;
}
export function readConfig(env = process.env) {
  const allowedHosts = (env.INPUT_IMAGE_HOSTS || DEFAULT_HOSTS.join(',')).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  if (!allowedHosts.length || allowedHosts.some(host => !/^[a-z0-9.-]+$/.test(host) || host.includes('..') || isIP(host) || host === 'localhost')) {
    throw new Error('INPUT_IMAGE_HOSTS must contain exact trusted DNS hostnames');
  }
  const model = env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image';
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(model)) throw new Error('Invalid GEMINI_IMAGE_MODEL');
  return {
    port: integer(env.PORT, 8787, 0, 65535, 'PORT'), host: env.HOST || '0.0.0.0',
    apiKey: env.GEMINI_API_KEY || '', accessToken: env.BACKEND_ACCESS_TOKEN || '',
    publicBaseUrl: publicOrigin(env.PUBLIC_BASE_URL || ''), model, allowedHosts,
    dataDir: path.resolve(env.DATA_DIR || './data/generated'),
    maxImageBytes: integer(env.MAX_IMAGE_BYTES, 10 * MiB, 1024, 20 * MiB, 'MAX_IMAGE_BYTES'),
    maxBodyBytes: 16 * 1024, maxProviderBytes: 32 * MiB,
    downloadTimeoutMs: integer(env.DOWNLOAD_TIMEOUT_MS, 8000, 100, 15000, 'DOWNLOAD_TIMEOUT_MS'),
    providerTimeoutMs: integer(env.PROVIDER_TIMEOUT_MS, 32000, 100, 35000, 'PROVIDER_TIMEOUT_MS'),
    imageTtlMs: integer(env.IMAGE_TTL_SECONDS, 900, 30, 86400, 'IMAGE_TTL_SECONDS') * 1000,
    rateLimit: integer(env.RATE_LIMIT_PER_MINUTE, 3, 1, 60, 'RATE_LIMIT_PER_MINUTE'),
    maxConcurrent: integer(env.MAX_CONCURRENT, 1, 1, 4, 'MAX_CONCURRENT'),
  };
}

export function isPublicAddress(address) {
  const v4 = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v4) === 4) {
    const [a, b] = v4.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b)) ||
      (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // Only globally routed unicast space, excluding documentation and local ranges.
    return /^[23][0-9a-f]{0,3}:/.test(normalized) && !normalized.startsWith('2001:db8:');
  }
  return false;
}
export async function validateInputUrl(value, config, lookup = dnsLookup) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'invalid_image_url', 'A direct HTTPS image URL is required.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash ||
      isIP(url.hostname) || !config.allowedHosts.includes(url.hostname.toLowerCase())) {
    fail(400, 'unsafe_image_url', 'The image URL must use an approved image host.');
  }
  let addresses;
  let lookupTimer;
  try {
    addresses = await Promise.race([
      lookup(url.hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => { lookupTimer = setTimeout(() => reject(new Error('DNS timeout')), 2000); }),
    ]);
  }
  catch { fail(400, 'image_dns_failed', 'The image host could not be resolved.'); }
  finally { clearTimeout(lookupTimer); }
  if (!addresses.length || addresses.some(entry => !isPublicAddress(entry.address))) {
    fail(400, 'unsafe_image_host', 'The image host must resolve to public addresses.');
  }
  return url.href;
}
async function boundedResponse(response, maximum, code) {
  const advertised = response.headers.get('content-length');
  if (advertised && Number(advertised) > maximum) { await response.body?.cancel(); fail(413, code, 'The image or response is too large.'); }
  if (!response.body) fail(502, code, 'An empty upstream response was received.');
  const reader = response.body.getReader(); const parts = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) { await reader.cancel(); fail(413, code, 'The image or response is too large.'); }
      parts.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts, total);
}
export async function downloadImage(url, config, fetchImpl = fetch) {
  let response;
  try {
    response = await fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(config.downloadTimeoutMs), headers: { Accept: 'image/png,image/jpeg,image/webp' } });
  } catch { fail(502, 'image_download_failed', 'The input image could not be downloaded.'); }
  if (!response.ok) { await response.body?.cancel(); fail(502, 'image_download_failed', 'The input image could not be downloaded.'); }
  const declared = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(declared)) { await response.body?.cancel(); fail(415, 'unsupported_image', 'Use a PNG, JPEG or WebP image.'); }
  let bytes;
  try { bytes = await boundedResponse(response, config.maxImageBytes, 'input_too_large'); }
  catch (error) { if (error instanceof AppError) throw error; fail(502, 'image_download_failed', 'The input image could not be downloaded.'); }
  if (imageType(bytes)?.mime !== declared) fail(415, 'invalid_image', 'The downloaded bytes are not a supported image.');
  return { bytes, mime: declared };
}
export function createGeminiEditor(config, fetchImpl = fetch) {
  return async ({ image, prompt }) => {
    let response;
    try {
      response = await fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${config.model}:generateContent`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(config.providerTimeoutMs),
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.apiKey },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ inlineData: { mimeType: image.mime, data: image.bytes.toString('base64') } }, { text: prompt }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }),
      });
    } catch { fail(502, 'provider_unavailable', 'The image provider is unavailable or timed out.'); }
    if (!response.ok) {
      const status = response.status; await response.body?.cancel();
      if (status === 429) fail(429, 'provider_rate_limited', 'The image provider rate limit was reached.');
      fail(502, 'provider_rejected_request', 'The image provider rejected the request. Check its key, billing and model configuration.');
    }
    let payload;
    try { payload = JSON.parse((await boundedResponse(response, config.maxProviderBytes, 'provider_response_too_large')).toString('utf8')); }
    catch (error) { if (error instanceof AppError) throw error; fail(502, 'invalid_provider_response', 'The image provider returned an invalid response.'); }
    if (payload.promptFeedback?.blockReason) fail(422, 'generation_blocked', 'The image provider blocked this request.');
    for (const candidate of payload.candidates || []) {
      if (['SAFETY', 'IMAGE_SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST'].includes(candidate.finishReason)) continue;
      for (const part of candidate.content?.parts || []) {
        const inline = part.inlineData;
        if (!inline || typeof inline.data !== 'string') continue;
        const data = inline.data.replace(/\s/g, '');
        if (data.length > Math.ceil(config.maxImageBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
          fail(502, 'invalid_generated_image', 'The provider returned invalid image data.');
        }
        const bytes = Buffer.from(data, 'base64'); const detected = imageType(bytes);
        if (!detected || bytes.length > config.maxImageBytes || detected.mime !== inline.mimeType || bytes.toString('base64') !== data) {
          fail(502, 'invalid_generated_image', 'The provider returned invalid image data.');
        }
        return { bytes, mime: detected.mime };
      }
    }
    fail(422, 'no_generated_image', 'The provider did not return an edited image.');
  };
}
function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(JSON.stringify(body));
}
function authenticated(header, token) {
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const actual = Buffer.from(header.slice(7)); const expected = Buffer.from(token);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
function readBody(req, maximum) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let stopped = false;
    req.on('data', chunk => {
      if (stopped) return;
      total += chunk.length;
      if (total > maximum) { stopped = true; req.pause(); reject(new AppError(413, 'request_too_large', 'The request is too large.')); return; }
      chunks.push(chunk);
    });
    req.on('end', () => { if (!stopped) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => reject(new AppError(400, 'invalid_request', 'The request could not be read.')));
    req.on('aborted', () => reject(new AppError(400, 'invalid_request', 'The request was interrupted.')));
  });
}
export function createServer({ config = readConfig(), fetchImpl = fetch, lookup = dnsLookup, editImage, imageStore, now = Date.now } = {}) {
  const store = imageStore || new FileImageStore(config.dataDir, config.imageTtlMs, now);
  const edit = editImage || createGeminiEditor(config, fetchImpl);
  let inFlight = 0; let requestTimes = [];
  const configured = Boolean(config.apiKey && config.accessToken.length >= 24 && config.publicBaseUrl);
  const server = http.createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && requestUrl.pathname === '/health') return sendJson(res, 200, { ok: true, configured });
      if (req.method === 'GET' && requestUrl.pathname.startsWith('/images/')) {
        const filename = requestUrl.pathname.slice('/images/'.length);
        const image = await store.read(filename);
        if (!image) return sendJson(res, 404, { error: { code: 'image_not_found', message: 'The image does not exist or has expired.' } });
        res.writeHead(200, { 'Content-Type': image.mime, 'Content-Length': image.bytes.length, 'Cache-Control': 'private, max-age=60', 'X-Content-Type-Options': 'nosniff' });
        return res.end(image.bytes);
      }
      if (requestUrl.pathname !== '/v1/images/edit') return sendJson(res, 404, { error: { code: 'not_found', message: 'Not found.' } });
      if (req.method !== 'POST') return sendJson(res, 405, { error: { code: 'method_not_allowed', message: 'Use POST.' } }, { Allow: 'POST' });
      if (!configured) fail(503, 'not_configured', 'The backend needs its API key, access token and public HTTPS URL.');
      if (!authenticated(req.headers.authorization, config.accessToken)) fail(401, 'unauthorized', 'A valid backend access token is required.');
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) fail(415, 'invalid_content_type', 'Use application/json.');
      if (Number(req.headers['content-length']) > config.maxBodyBytes) fail(413, 'request_too_large', 'The request is too large.');
      let body;
      try { body = JSON.parse(await readBody(req, config.maxBodyBytes)); }
      catch (error) { if (error instanceof AppError) throw error; fail(400, 'invalid_json', 'The request body must be valid JSON.'); }
      if (!record(body) || typeof body.imageUrl !== 'string' || body.imageUrl.length > 4096 ||
          typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 4096) {
        fail(400, 'invalid_input', 'Provide imageUrl and a non-empty prompt of at most 4096 characters.');
      }
      if (inFlight >= config.maxConcurrent) fail(429, 'backend_busy', 'An image is already being generated. Try again later.');
      requestTimes = requestTimes.filter(timestamp => now() - timestamp < 60000);
      if (requestTimes.length >= config.rateLimit) fail(429, 'backend_rate_limited', 'The backend request limit was reached.');
      requestTimes.push(now()); inFlight++;
      try {
        const imageUrl = await validateInputUrl(body.imageUrl, config, lookup);
        const image = await downloadImage(imageUrl, config, fetchImpl);
        const generated = await edit({ image, prompt: body.prompt.trim() });
        if (!generated || !Buffer.isBuffer(generated.bytes) || generated.bytes.length > config.maxImageBytes || imageType(generated.bytes)?.mime !== generated.mime) fail(502, 'invalid_generated_image', 'The image provider did not return a valid image.');
        const filename = await store.save(generated.bytes, generated.mime);
        const outputUrl = `${config.publicBaseUrl}/images/${filename}`;
        return sendJson(res, 200, { outputUrl, expiresInSeconds: Math.floor(config.imageTtlMs / 1000) });
      } finally { inFlight--; }
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      const known = error instanceof AppError;
      sendJson(res, known ? error.status : 500, { error: { code: known ? error.code : 'internal_error', message: known ? error.message : 'The image request failed.' } }, { Connection: 'close' });
    }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  server.on('close', () => store.close?.());
  return server;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const config = readConfig();
  const server = createServer({ config });
  server.listen(config.port, config.host, () => console.log(`Locket AI backend listening on port ${config.port}. See /health for configuration status.`));
}
