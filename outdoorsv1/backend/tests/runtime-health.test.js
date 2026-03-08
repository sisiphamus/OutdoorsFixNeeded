import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildFingerprintSnapshot, compareFingerprints, createRuntimeAwareProgress, getRuntimeHealthStatus } from '../src/runtime-health.js';

describe('runtime-health', () => {
  it('returns deterministic runtime status shape', () => {
    const status = getRuntimeHealthStatus();
    assert.equal(typeof status.stale, 'boolean');
    assert.ok(status.bootFingerprint);
    assert.equal(typeof status.bootFingerprint.pid, 'number');
    assert.ok(Array.isArray(status.bootFingerprint.codeFingerprint.files));
  });

  it('detects stale change when file mtime/hash changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outdoors-runtime-'));
    const file = join(root, 'critical.js');
    writeFileSync(file, 'console.log("v1");\n', 'utf-8');

    const boot = buildFingerprintSnapshot([file]);
    await new Promise((r) => setTimeout(r, 5));
    writeFileSync(file, 'console.log("v2");\n', 'utf-8');
    const current = buildFingerprintSnapshot([file]);

    const diff = compareFingerprints(boot, current);
    assert.equal(diff.stale, true);
    assert.equal(diff.changedFiles.length, 1);
    assert.equal(diff.changedFiles[0].path, file);
  });

  it('attaches runtime metadata on first pipeline_phase', () => {
    const seen = [];
    const wrapped = createRuntimeAwareProgress((type, data) => {
      seen.push({ type, data });
    });

    wrapped.onProgress('pipeline_phase', { phase: 'analyzing', description: 'Analyzing request...' });
    wrapped.onProgress('assistant_text', { text: 'hello' });

    const phase = seen.find((e) => e.type === 'pipeline_phase');
    assert.ok(phase);
    assert.equal(phase.data.phase, 'analyzing');
    assert.ok(phase.data.runtime);
    assert.equal(typeof phase.data.runtimeStaleDetected, 'boolean');
    assert.ok(Array.isArray(phase.data.runtimeChangedFiles));
  });
});
