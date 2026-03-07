/**
 * register-startup.js
 *
 * Registers the app as a Windows Task Scheduler task so it starts automatically
 * at user login. Called once on first boot — idempotent thereafter.
 *
 * Task: "PepperV6"
 * Trigger: At logon (current user)
 * Action: node <path-to-index.js> with working directory set to this project
 * Settings: No time limit, restarts up to 3x on failure, starts when available
 */

import { execFile } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(__dirname, '..');
const TASK_NAME = 'PepperV6';

function ps(script) {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 15000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim()));
        else resolve(stdout.trim());
      }
    );
  });
}

async function isRegistered() {
  try {
    const out = await ps(
      `(Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue).TaskName`
    );
    return out === TASK_NAME;
  } catch {
    return false;
  }
}

export async function registerStartup() {
  try {
    if (await isRegistered()) {
      console.log(`  [Startup] Task '${TASK_NAME}' already registered ✓`);
      return;
    }

    const nodeBin = process.execPath;
    const indexJs = resolve(__dirname, 'index.js');
    const workDir = PROJECT_DIR;

    await ps(`
      $a = New-ScheduledTaskAction -Execute '${nodeBin}' -Argument '"${indexJs}"' -WorkingDirectory '${workDir}'
      $t = New-ScheduledTaskTrigger -AtLogOn
      $s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable $true
      Register-ScheduledTask -TaskName '${TASK_NAME}' -Action $a -Trigger $t -Settings $s -Force
    `);

    console.log(`  [Startup] Registered '${TASK_NAME}' in Task Scheduler — will start on next login ✓`);
  } catch (err) {
    console.warn(`  [Startup] Could not register startup task: ${err.message}`);
  }
}
