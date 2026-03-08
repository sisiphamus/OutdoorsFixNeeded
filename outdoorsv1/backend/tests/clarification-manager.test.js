import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClarificationManager } from '../../../outdoorsv4/memory/clarification-manager.js';

describe('ClarificationManager', () => {
  it('persists and clears pending clarification state', () => {
    const root = mkdtempSync(join(tmpdir(), 'outdoors-clarify-'));
    const manager = new ClarificationManager(root);

    manager.setPending('tg:chat:1', {
      originalPrompt: 'Can you create a landing page',
      pendingQuestions: { questions: [{ question: 'What product?' }] },
      partialState: { phase: 'auditing' },
      sessionId: 'abc',
    });

    const pending = manager.get('tg:chat:1');
    assert.equal(pending.originalPrompt, 'Can you create a landing page');
    assert.equal(pending.state, 'awaiting_answers');
    assert.equal(pending.answers.length, 0);

    const updated = manager.appendAnswer('tg:chat:1', 'It is for Outdoors');
    assert.equal(updated.answers.length, 1);
    assert.equal(updated.state, 'ready_to_resume');

    const augmented = manager.buildAugmentedPrompt(updated);
    assert.match(augmented, /Original request:/);
    assert.match(augmented, /Collected user answers:/);
    assert.match(augmented, /It is for Outdoors/);

    manager.clear('tg:chat:1');
    assert.equal(manager.get('tg:chat:1'), null);
  });

  it('expires stale entries and isolates keys', async () => {
    const root = mkdtempSync(join(tmpdir(), 'outdoors-clarify-ttl-'));
    const manager = new ClarificationManager(root, 1);
    manager.setPending('web:win:a', { originalPrompt: 'A', pendingQuestions: { questions: [] } });
    manager.setPending('web:win:b', { originalPrompt: 'B', pendingQuestions: { questions: [] } });

    await new Promise((r) => setTimeout(r, 5));

    assert.equal(manager.get('web:win:a'), null);
    assert.equal(manager.get('web:win:b'), null);
  });
});

describe('model-runner safety guards', () => {
  it('uses shell:false and prompt file mode', () => {
    const src = readFileSync(join(process.cwd(), '..', '..', 'outdoorsv4', 'pipeline', 'model-runner.js'), 'utf-8');
    assert.match(src, /shell:\s*false/);
    assert.match(src, /--append-system-prompt-file/);
  });
});
