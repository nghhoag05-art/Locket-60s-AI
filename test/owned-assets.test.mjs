import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('assets/filters/catalog.json', root), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('assets/filters/render-presets.json', root), 'utf8'));
const prefix = 'https://raw.githubusercontent.com/nghhoag05-art/Locket-60s-AI/main/';

function strings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

test('every live filter asset is hosted in the personal repository and matches its content hash', async () => {
  const urls = [...new Set(strings(catalog.filters).filter(value => value.startsWith('https://')))];
  assert.ok(urls.length > 20);
  for (const url of urls) {
    assert.ok(url.startsWith(prefix + 'assets/filters/'), 'foreign catalog URL: ' + url);
    const relative = url.slice(prefix.length);
    const digest = /^assets\/filters\/([a-f0-9]{64})\.png$/.exec(relative)?.[1];
    assert.ok(digest, 'unrecognized asset path');
    const data = await readFile(new URL(relative, root));
    assert.equal(createHash('sha256').update(data).digest('hex'), digest);
    assert.equal(data.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  }
});

test('all 27 frame entries have matching local overlays and truthful native capture hints', () => {
  const entries = catalog.filters.filter(entry => ['Frames', 'Photobooth'].includes(entry.category));
  assert.equal(entries.length, 27);
  assert.equal(Object.keys(manifest.presets).length, 27);
  let four = 0;
  for (const entry of entries) {
    const preset = manifest.presets[entry.id];
    assert.ok(preset);
    assert.equal(entry.overlayImageUrl, prefix + preset.asset);
    assert.equal(entry.ptbFrameId, entry.id);
    assert.equal(entry.captureCountHint, preset.slots.length);
    assert.equal(entry.filterType, 'cutout');
    assert.equal(preset.slots.length, preset.kind === 'photobooth' ? 4 : 1);
    if (preset.slots.length === 4) four++;
    for (const [x, y, width, height] of preset.slots) {
      assert.ok(x >= 0 && y >= 0 && width > 0 && height > 0);
      assert.ok(x + width <= preset.size[0] && y + height <= preset.size[1]);
    }
  }
  assert.equal(four, 9);
});

test('the personal module keeps all AI scripts in its own repository without upstream backend credentials', async () => {
  const module = await readFile(new URL('module/locket-60s-ai-youtube.module', root), 'utf8');
  for (const line of module.split(/\r?\n/)) {
    if (!/^locket_\w+\s*=/.test(line)) continue;
    const path = /script-path=([^,\s]+)/.exec(line)?.[1];
    assert.ok(path?.startsWith(prefix + 'scripts/'), line);
    assert.ok(!line.includes('argument='), 'foreign module license must not be copied');
  }
  assert.ok(!/anhtu4nn|mhiep20077|uplocket\.io\.vn/.test(module));
  const client = await readFile(new URL('scripts/ai-image-experimental.js', root), 'utf8');
  assert.ok(!/X-PTB-Access|ptb_307_redirect|ptb_307_auth/.test(client));
});
