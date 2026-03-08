import { existsSync, readFileSync, statSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const PROCESS_START_MS = Date.now();

export const RUNTIME_CRITICAL_FILES = [
  join(REPO_ROOT, 'outdoorsv4', 'index.js'),
  join(REPO_ROOT, 'outdoorsv4', 'pipeline', 'model-runner.js'),
];

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim() || null;
  } catch {
    return null;
  }
}

function hashFile(path) {
  try {
    const content = readFileSync(path);
    return createHash('sha1').update(content).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export function buildFingerprintSnapshot(criticalFiles = RUNTIME_CRITICAL_FILES) {
  const files = criticalFiles.map((path) => {
    if (!existsSync(path)) {
      return {
        path,
        exists: false,
        mtimeMs: null,
        size: null,
        hash: null,
      };
    }
    const stat = statSync(path);
    return {
      path,
      exists: true,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      hash: hashFile(path),
    };
  });

  return {
    processStartTime: new Date(PROCESS_START_MS).toISOString(),
    processStartEpochMs: PROCESS_START_MS,
    pid: process.pid,
    gitCommit: getGitCommit(),
    codeFingerprint: {
      generatedAt: new Date().toISOString(),
      files,
    },
  };
}

export function compareFingerprints(boot, current) {
  const byPath = new Map((boot?.codeFingerprint?.files || []).map((f) => [f.path, f]));
  const changedFiles = [];

  for (const file of current?.codeFingerprint?.files || []) {
    const bootFile = byPath.get(file.path);
    if (!bootFile) {
      changedFiles.push({ path: file.path, reason: 'missing_in_boot' });
      continue;
    }
    if (bootFile.exists !== file.exists) {
      changedFiles.push({ path: file.path, reason: 'existence_changed' });
      continue;
    }
    if (!file.exists) continue;
    if (bootFile.hash !== file.hash || bootFile.mtimeMs !== file.mtimeMs) {
      changedFiles.push({
        path: file.path,
        reason: 'content_or_mtime_changed',
        bootMtimeMs: bootFile.mtimeMs,
        currentMtimeMs: file.mtimeMs,
        bootHash: bootFile.hash,
        currentHash: file.hash,
      });
    }
  }

  return {
    stale: changedFiles.length > 0,
    changedFiles,
  };
}

const BOOT_RUNTIME_FINGERPRINT = buildFingerprintSnapshot();

export function getBootRuntimeFingerprint() {
  return BOOT_RUNTIME_FINGERPRINT;
}

export function getRuntimeHealthStatus() {
  const current = buildFingerprintSnapshot();
  const diff = compareFingerprints(BOOT_RUNTIME_FINGERPRINT, current);
  return {
    stale: diff.stale,
    changedFiles: diff.changedFiles,
    bootFingerprint: BOOT_RUNTIME_FINGERPRINT,
    currentFingerprint: current,
  };
}

export function getRuntimeStatusPayload() {
  const health = getRuntimeHealthStatus();
  return {
    runtime: health.bootFingerprint,
    runtimeStaleDetected: health.stale,
    runtimeChangedFiles: health.changedFiles,
  };
}

export function assertRuntimeBridgeReady() {
  const missing = RUNTIME_CRITICAL_FILES.filter((path) => !existsSync(path));
  if (missing.length) {
    throw new Error(`Runtime bridge check failed. Missing files: ${missing.join(', ')}`);
  }
}

export function createRuntimeAwareProgress(baseOnProgress) {
  const health = getRuntimeHealthStatus();
  let attachedPhaseMetadata = false;
  let staleEventSent = false;

  const onProgress = (type, data = {}) => {
    if (type === 'pipeline_phase' && !attachedPhaseMetadata) {
      attachedPhaseMetadata = true;
      baseOnProgress?.(type, {
        ...data,
        runtime: health.bootFingerprint,
        runtimeStaleDetected: health.stale,
        runtimeChangedFiles: health.changedFiles,
      });
      if (health.stale && !staleEventSent) {
        staleEventSent = true;
        baseOnProgress?.('runtime_stale_code_detected', {
          runtime: health.bootFingerprint,
          changedFiles: health.changedFiles,
        });
      }
      return; // already forwarded above
    }
    baseOnProgress?.(type, data);
  };

  return { onProgress, health };
}
