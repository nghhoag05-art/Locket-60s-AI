import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const code = await readFile(new URL('../scripts/forceGold4.3_60s_full.js', import.meta.url), 'utf8');
const catalog = JSON.parse(await readFile(new URL('../references/hakaiz-ai-catalog.json', import.meta.url), 'utf8'));
const endpoint = 'https://firebaseremoteconfig.googleapis.com/v1/projects/locket-4252a/namespaces/firebase:fetch';
const version = 'hakaiz-9c2ea58-83';
const filterGateNames = ['camera_filter_sheet', 'camera_filters', 'camera_filter', 'filter', 'filters', 'photo_filters', 'ai_filters', 'holiday_effects', 'holiday_filters', 'holiday_filter', 'ar_filters', 'face_filters'];
const filterUpsellNames = ['filter', 'filters', 'camera_filter', 'camera_filters', 'holiday_filter', 'holiday_filters', 'holiday_effects', 'ai_filter', 'ai_filters'];
const filterPaywallNames = ['holiday_effects', 'camera_filters', 'camera_filter', 'filters', 'filter', 'ai_filter', 'ai_filters', 'filtered_image', 'filtered_images', 'generate_filtered_image'];
const enabledFilterEntries = ['camera_filters_enabled', 'camera_filter_enabled', 'holiday_filters_enabled', 'ai_filters_enabled', 'free_filters_enabled', 'filter_selection_enabled', 'camera_filter_sheet_selection_enabled', 'sheet_filters_selectable', 'dismiss_filter_sheet_on_select', 'all_filters_free', 'unlocked_filters'];
const disabledFilterEntries = ['camera_filter_gold_only', 'camera_filters_gold_only', 'holiday_filters_gold_only', 'filter_gold_only', 'filters_gold_only', 'ai_filter_gold_only', 'ai_filters_gold_only', 'filter_paywall_enabled', 'camera_filter_paywall_enabled', 'filter_upsell_enabled', 'require_gold_for_filters', 'require_gold_for_filter', 'requires_gold_for_filters', 'requires_gold_for_filter', 'requires_gold_for_camera_filters', 'camera_filter_requires_gold', 'camera_filters_require_gold', 'ai_filter_requires_gold', 'ai_filters_require_gold', 'filter_requires_gold', 'filters_require_gold', 'filtered_image_requires_gold', 'filtered_images_require_gold', 'filtered_image_gold_only', 'filtered_images_gold_only'];
const allowedEntryChanges = new Set(['feature_gates', 'upsell_features', 'paywall_presentation_config', 'camera_filter_config', 'cache_ttl_seconds', 'client_cache_ttl_sec', ...enabledFilterEntries, ...disabledFilterEntries]);

function input() {
  return {
    state: 'NO_CHANGE',
    templateVersion: '123',
    entries: {
      unrelated_entry: 'kept',
      camera_filter_config: JSON.stringify({ future_supported_field: { enabled: true }, unknown_camera_string: 'keep' }),
      feature_gates: JSON.stringify({ future_gate: 'enabled' }),
      upsell_features: JSON.stringify({ future_upsell: true }),
      paywall_presentation_config: JSON.stringify({ future_paywall: true })
    }
  };
}

function run(value = input(), options = {}) {
  const calls = [];
  const writes = [];
  const context = {
    $request: options.request || { url: endpoint, headers: { 'User-Agent': 'Locket/4.3' } },
    $response: { body: options.raw ? value : JSON.stringify(value) },
    $done: result => calls.push(result)
  };
  if (options.store !== false) {
    context.$persistentStore = { write: (value, key) => {
      if (options.storageThrows) throw new Error('Storage unavailable');
      writes.push({ key, value });
      return true;
    } };
  }
  vm.runInNewContext(code, context, { timeout: 2000 });
  assert.equal(calls.length, 1, 'Firebase rewrite must finish exactly once');
  const result = JSON.parse(JSON.stringify(calls[0]));
  return { result, output: result.body ? JSON.parse(result.body) : undefined, writes };
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  }
  return value;
}

function protectedConfig(value) {
  const result = structuredClone(value);
  delete result.state;
  delete result.templateVersion;
  for (const key of allowedEntryChanges) delete result.entries[key];
  return result;
}

test('pinned catalog resolves every group and picker ID to one of 83 unique filters', () => {
  assert.deepEqual(catalog.source, {
    repo: 'dtuandzxyz/Locket-Filter-Module',
    commit: '9c2ea58aaea3f6d9258b60d3cf1621ea6a4ccdce',
    path: 'js/locketfix.js'
  });
  assert.equal(catalog.filters.length, 83);
  assert.equal(catalog.groups.length, 10);
  assert.equal(catalog.pickerIds.length, 63);
  const ids = new Set(catalog.filters.map(filter => filter.id));
  assert.equal(ids.size, catalog.filters.length);
  for (const filter of catalog.filters) {
    assert.equal(filter.uid, filter.id, 'catalog uid identifies a filter, never a user');
    assert.ok(filter.name && filter.prompt);
  }
  for (const group of catalog.groups) {
    assert.deepEqual(group.filterIds, group.filter_ids);
    for (const id of group.filterIds) assert.ok(ids.has(id), 'unresolved group filter: ' + id);
  }
  for (const id of catalog.pickerIds) assert.ok(ids.has(id), 'unresolved picker filter: ' + id);
  assert.ok(ids.has('photobooth_4cut'));
  assert.ok(ids.has('khung_hello_kitty_h_ng_pastel'));
});

test('native camera config contains the full source catalog and both naming conventions', () => {
  const config = JSON.parse(run().output.entries.camera_filter_config);
  for (const key of ['remoteFilters', 'remote_filters', 'filters']) assert.deepEqual(config[key], catalog.filters);
  for (const key of ['filterGroups', 'filter_groups', 'sheetFilters', 'sheet_filters']) assert.deepEqual(config[key], catalog.groups);
  for (const key of ['pickerFilters', 'picker_filters']) assert.deepEqual(config[key], catalog.pickerIds);
  for (const key of ['showFilterButton', 'show_filter_button', 'allowsCustomFilters', 'allows_custom_filters', 'referenceImageAttachmentEnabled', 'reference_image_attachment_enabled', 'sheetEnabled', 'sheet_enabled']) assert.equal(config[key], true, key);
  assert.equal(config.openSheetImmediately, false);
  assert.equal(config.open_sheet_immediately, false);
});

test('future camera, feature gate and paywall fields survive the catalog merge', () => {
  const entries = run().output.entries;
  const config = JSON.parse(entries.camera_filter_config);
  assert.deepEqual(config.future_supported_field, { enabled: true });
  assert.equal(config.unknown_camera_string, 'keep');
  assert.equal(JSON.parse(entries.feature_gates).future_gate, 'enabled');
  assert.equal(JSON.parse(entries.upsell_features).future_upsell, true);
  assert.equal(JSON.parse(entries.paywall_presentation_config).future_paywall, true);
});

test('source selection gates coexist with the existing personal Gold configuration', () => {
  const entries = run().output.entries;
  const gates = JSON.parse(entries.feature_gates);
  const upsell = JSON.parse(entries.upsell_features);
  const paywall = JSON.parse(entries.paywall_presentation_config);
  for (const key of filterGateNames) assert.equal(gates[key], 'enabled', key);
  for (const key of filterUpsellNames) assert.equal(upsell[key], false, key);
  for (const key of filterPaywallNames) assert.equal(paywall[key], false, key);
  for (const key of enabledFilterEntries) assert.equal(entries[key], 'true', key);
  for (const key of disabledFilterEntries) assert.equal(entries[key], 'false', key);
  assert.equal(gates.longer_video, 'enabled');
  assert.equal(upsell.camera_roll, true);
  assert.equal(paywall.profile_banner, true);
});

test('NO_CHANGE responses carry source UPDATE metadata and zero cache TTL after rewriting', () => {
  const output = run().output;
  assert.equal(output.state, 'UPDATE');
  assert.match(output.templateVersion, /^\d+$/);
  assert.ok(Number(output.templateVersion) > 123);
  assert.equal(output.entries.cache_ttl_seconds, '0');
  assert.equal(output.entries.client_cache_ttl_sec, '0');
});

test('all original personal output outside the explicit filter and metadata scope is unchanged', () => {
  // Captured before editing forceGold4.3_60s_full.js, using the exact input() fixture.
  // Original script SHA-256: 93519a1c932ce3de37612150f9d9524d4e291905b274e37260a287acac1f1a0f
  const digest = createHash('sha256').update(JSON.stringify(stable(protectedConfig(run().output)))).digest('hex');
  assert.equal(digest, 'a7df6db966d3aef7c32d049e60a3e6e960a101addae279c67ff0abac71ff52de');
});

test('every original switch inside the three extended JSON entries is preserved exactly', () => {
  // Values captured from the pre-edit script, independently of the new catalog.
  const previous = {
    feature_gates: {
      app_icon_picker: 'enabled', camera_roll: 'enabled', camera_theme: 'enabled',
      locket_views: 'enabled', long_captions: 'enabled', longer_video: 'enabled',
      unlimited_friends: 'enabled', priority_support: 'enabled', profile_badge: 'enabled',
      remove_ads: 'enabled', video: 'enabled', custom_widget_frames: 'enabled', streak_recovery: 'enabled'
    },
    upsell_features: {
      app_icon_picker: true, camera_roll: true, camera_theme: true,
      locket_views: true, remove_ads: true, custom_widget_frames: true
    },
    paywall_presentation_config: {
      uid: 'paywall_testflight', onboarding: false, after_sent_moment: false,
      on_foreground: false, interval: 2592000, profile_banner: true
    }
  };
  const entries = run().output.entries;
  for (const [entry, fields] of Object.entries(previous)) {
    const current = JSON.parse(entries[entry]);
    for (const [key, value] of Object.entries(fields)) assert.deepEqual(current[key], value, entry + '.' + key);
  }
});

test('personal intro, captions, 60-second duration and original bitrate remain intact', () => {
  const output = run().output;
  const entries = output.entries;
  const popup = JSON.parse(entries.feature_discovery_popup_config);
  assert.equal(popup.tag, 'LOCKET GOLD Hoàng Pro');
  assert.equal(popup.feature_set[0].title, 'Hoàng Official ✨');
  assert.equal(popup.feature_set[0].body, 'Zalo 0978738782');
  assert.equal(popup.feature_set[0].imageURL, 'https://raw.githubusercontent.com/nghhoag05-art/Locket-60s-AI/main/assets/zalo-intro.png');
  assert.equal(entries.max_video_duration, '60.0');
  assert.equal(JSON.parse(entries.camera).gold_max_duration, 60);
  assert.equal(JSON.parse(entries.camera_roll).gold_max_duration, 60);
  assert.equal(JSON.parse(entries.camera).quality_mbps, 0.9);
  assert.ok(JSON.stringify(output).includes('caption:hoangnguyen'));
  assert.ok(JSON.stringify(output).includes('caption:em_nho_anhh'));
});

test('account, celebrity and analytics fields from the existing server response are preserved', () => {
  const original = input();
  original.custom_server_metadata = { account: 'existing-account' };
  original.entries.celebrity_filter_config = JSON.stringify({ celebrityUid: 'existing-account' });
  original.entries.user_uid = 'existing-account';
  original.entries.region_code = 'VN';
  original.entries.existing_analytics_setting = 'leave-as-is';
  const output = run(original).output;
  assert.deepEqual(output.custom_server_metadata, original.custom_server_metadata);
  for (const key of ['celebrity_filter_config', 'user_uid', 'region_code', 'existing_analytics_setting']) assert.equal(output.entries[key], original.entries[key]);
  assert.equal(Object.hasOwn(run().output.entries, 'celebrity_filter_config'), false);
  assert.ok(!code.includes('BASE_VIP_USERS'));
  assert.ok(!code.includes('LOCKET_SELF_UID'));
  assert.ok(!code.includes('locket_admin_custom'));
});

test('a fixed version marker is the only persistent write after a successful rewrite', () => {
  assert.deepEqual(run().writes, [{ key: 'LOCKET_AI_CATALOG_VERSION', value: version }]);
  assert.ok(run(input(), { store: false }).output.entries.camera_filter_config);
  assert.ok(run(input(), { storageThrows: true }).output.entries.camera_filter_config);
});

test('malformed nested server JSON does not prevent catalog injection', () => {
  for (const value of ['not-json', 'null', '[]', '42', '"string"', null, [], 42]) {
    const original = input();
    for (const key of ['camera_filter_config', 'feature_gates', 'upsell_features', 'paywall_presentation_config']) original.entries[key] = value;
    const output = run(original).output;
    assert.equal(JSON.parse(output.entries.camera_filter_config).remoteFilters.length, 83);
    assert.equal(JSON.parse(output.entries.feature_gates).ai_filters, 'enabled');
    assert.equal(output.entries.unrelated_entry, 'kept');
  }
});

test('invalid outer responses pass through without fabricating config or writing diagnostics', () => {
  for (const value of ['', '{bad-json', 'null', '[]', '42', '"string"']) {
    const { result, writes } = run(value, { raw: true });
    assert.deepEqual(result, {});
    assert.deepEqual(writes, []);
  }
});

test('unrelated responses retain their original state and do not receive a catalog', () => {
  const original = input();
  const { output, writes } = run(original, { request: { url: 'https://example.com/config', headers: { 'User-Agent': 'OtherApp' } } });
  assert.deepEqual(output, original);
  assert.deepEqual(writes, []);
});
