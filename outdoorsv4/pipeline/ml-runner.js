// ml-runner.js — Node.js integration layer for the local ML inference subprocess.
// Maintains a pool of persistent Python subprocesses for concurrent session throughput.
// Communicates via newline-delimited JSON over stdin/stdout.

import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INFER_SCRIPT = join(__dirname, '../ml/infer.py');
const PYTHON = process.env.OUTDOORS_PYTHON || 'python';
const CALL_TIMEOUT_MS = 30000;
const POOL_SIZE = 2;

class MLWorker {
  constructor() {
    this.proc = null;
    this.stdoutBuffer = '';
    this.pendingQueue = [];
  }

  startProcess() {
    this.proc = spawn(PYTHON, [INFER_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });

    this.proc.stdout.on('data', chunk => {
      this.stdoutBuffer += chunk.toString();
      const lines = this.stdoutBuffer.split('\n');
      this.stdoutBuffer = lines.pop(); // keep incomplete last chunk
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const pending = this.pendingQueue.shift();
        if (!pending) {
          process.stderr.write(`[ml-runner] Unexpected output: ${trimmed}\n`);
          continue;
        }
        clearTimeout(pending.timer);
        try {
          pending.resolve(JSON.parse(trimmed));
        } catch (e) {
          pending.reject(new Error(`[ml-runner] JSON parse failed: ${trimmed}`));
        }
      }
    });

    this.proc.stderr.on('data', chunk => {
      process.stderr.write(`[ml-runner] ${chunk}`);
    });

    this.proc.on('close', code => {
      process.stderr.write(`[ml-runner] subprocess exited (code ${code})\n`);
      this.proc = null;
      while (this.pendingQueue.length > 0) {
        const pending = this.pendingQueue.shift();
        clearTimeout(pending.timer);
        pending.reject(new Error(`[ml-runner] subprocess exited unexpectedly (code ${code})`));
      }
    });

    this.proc.on('error', err => {
      process.stderr.write(`[ml-runner] spawn error: ${err.message}\n`);
      this.proc = null;
      while (this.pendingQueue.length > 0) {
        const pending = this.pendingQueue.shift();
        clearTimeout(pending.timer);
        pending.reject(err);
      }
    });
  }

  ensureProcess() {
    if (!this.proc || this.proc.killed) {
      this.startProcess();
    }
  }

  call(payload) {
    return new Promise((resolve, reject) => {
      this.ensureProcess();
      const timer = setTimeout(() => {
        const idx = this.pendingQueue.findIndex(p => p.timer === timer);
        if (idx !== -1) this.pendingQueue.splice(idx, 1);
        reject(new Error(`[ml-runner] timeout after ${CALL_TIMEOUT_MS}ms for task: ${payload.task}`));
      }, CALL_TIMEOUT_MS);

      this.pendingQueue.push({ resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(payload) + '\n');
      } catch (err) {
        clearTimeout(timer);
        this.pendingQueue.pop();
        reject(err);
      }
    });
  }

  shutdown() {
    if (this.proc && !this.proc.killed) {
      this.proc.stdin.end();
      this.proc = null;
    }
  }
}

// Worker pool — round-robin dispatch
const workers = [];
let nextIdx = 0;

function getWorker() {
  while (workers.length < POOL_SIZE) {
    workers.push(new MLWorker());
  }
  const worker = workers[nextIdx % workers.length];
  nextIdx++;
  return worker;
}

// Pre-warm workers on import so the model is loaded before the first real request
(async () => {
  try {
    await getWorker().call({ task: 'phase_a', prompt: 'warmup' });
    process.stderr.write('[ml-runner] Pre-warm complete\n');
  } catch {
    process.stderr.write('[ml-runner] Pre-warm failed (will retry on first real call)\n');
  }
})();

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Phase A: classify the prompt into output type labels.
 * Returns a JSON string compatible with parseOutputSpec().
 */
export async function runPhaseA(prompt) {
  try {
    const result = await getWorker().call({ task: 'phase_a', prompt });
    return JSON.stringify(result);
  } catch (err) {
    process.stderr.write(`[ml-runner] Phase A error: ${err.message}\n`);
    // Return a safe fallback that parseOutputSpec can handle
    return JSON.stringify({
      taskDescription: (prompt || '').slice(0, 500),
      outputType: 'text',
      outputLabels: { text: true, picture: false, command: false, presentation: false, specificFile: false, other: false },
      outputFormat: { type: 'inline_text', structure: 'direct answer', deliveryMethod: 'inline' },
      requiredDomains: [],
      complexity: 'simple',
      estimatedSteps: 1,
    });
  }
}

/**
 * Phase B: retrieve relevant memory files via TF-IDF cosine similarity.
 * inventory is the array from getFullInventory().
 * Returns a JSON string compatible with parseAuditResult().
 */
export async function runPhaseB(prompt, inventory) {
  try {
    const result = await getWorker().call({ task: 'phase_b', prompt, inventory });
    return JSON.stringify(result);
  } catch (err) {
    process.stderr.write(`[ml-runner] Phase B error: ${err.message}\n`);
    return JSON.stringify({
      selectedMemories: [],
      missingMemories: [],
      toolsNeeded: [],
      notes: `ML retrieval failed: ${err.message}`,
    });
  }
}

/**
 * Gracefully shut down all Python subprocesses.
 */
export function shutdown() {
  for (const worker of workers) {
    worker.shutdown();
  }
  workers.length = 0;
}
