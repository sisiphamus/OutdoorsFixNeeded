// Process registry — tracks active pipelines and their subprocesses.
// Supports kill-by-key (kills all subprocesses matching a pipeline key).

import { spawn } from 'child_process';

const processes = new Map(); // key → { proc, label, startedAt }
let changeListener = null;
let activityListener = null;

export function register(key, proc, label = '') {
  processes.set(key, { proc, label, startedAt: Date.now() });
  changeListener?.();
}

export function unregister(key) {
  processes.delete(key);
  changeListener?.();
}

export function kill(key) {
  let killed = false;
  for (const [k, entry] of processes) {
    if (k === key || k.startsWith(key + ':')) {
      entry.proc._stoppedByUser = true;
      try {
        if (process.platform === 'win32') {
          // On Windows, proc.kill() only kills the shell wrapper, not the child tree.
          // taskkill /T /F kills the entire process tree.
          // Use full path to avoid shell: true (which requires cmd.exe and fails in Git Bash).
          const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
          spawn(taskkill, ['/T', '/F', '/PID', String(entry.proc.pid)], {
            shell: false,
            stdio: 'ignore',
            detached: true,
          });
        } else {
          process.kill(-entry.proc.pid, 'SIGTERM');
        }
      } catch {}
      killed = true;
    }
  }
  return killed;
}

export function has(key) {
  for (const k of processes.keys()) {
    if (k === key || k.startsWith(key + ':')) return true;
  }
  return false;
}

export function getSummary() {
  const numbered = [];
  const unnumbered = [];
  const seen = new Set();

  for (const [key, entry] of processes) {
    // Extract pipeline key (strip sub-model suffixes like :A, :B, :C, :D)
    const pipelineKey = key.replace(/:[A-Z]$/, '').replace(/:learner$/, '');
    if (seen.has(pipelineKey)) continue;
    seen.add(pipelineKey);

    // Parse conversation number from key patterns like web:conv:3, wa:conv:5, conv:7
    const convMatch = pipelineKey.match(/:conv:(\d+)/);
    const item = {
      key: pipelineKey,
      label: entry.label,
      startedAt: entry.startedAt,
    };

    if (convMatch) {
      item.number = parseInt(convMatch[1], 10);
      numbered.push(item);
    } else {
      unnumbered.push(item);
    }
  }

  return { numbered, unnumbered };
}

export function setChangeListener(fn) {
  changeListener = fn;
}

export function setActivityListener(fn) {
  activityListener = fn;
}

export function emitActivity(processKey, type, summary) {
  activityListener?.(processKey, type, summary);
}
