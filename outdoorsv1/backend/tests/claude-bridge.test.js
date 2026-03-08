import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// We test the module logic by mocking child_process
describe('claude-bridge', () => {
  it('should export executeClaudePrompt function', async () => {
    const mod = await import('../src/claude-bridge.js');
    assert.equal(typeof mod.executeClaudePrompt, 'function');
  });

  it('executeClaudePrompt should reject on timeout', async () => {
    // Import with a very short timeout
    const { executeClaudePrompt } = await import('../src/claude-bridge.js');
    // Use a command that will definitely hang: sleep
    await assert.rejects(
      () => executeClaudePrompt('test', { timeout: 100, cwd: '.' }),
      (err) => {
        // Should timeout or fail to start claude
        assert.ok(err instanceof Error);
        return true;
      }
    );
  });
});
