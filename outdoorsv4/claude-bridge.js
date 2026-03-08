// Drop-in replacement for outdoorsv1/backend/src/claude-bridge.js
// Adds outdoorsv4 support via OUTDOORS_V4_ENABLED env var.
// Copy this to outdoorsv1/backend/src/claude-bridge.js when ready to switch.
//
// Defaults:
//   - OUTDOORS_V4_ENABLED=true  → uses outdoorsv4
//   - OUTDOORS_V3_ENABLED=true  → uses outdoorsv3
//   - Neither                 → uses outdoorsv3 (safe default)

import * as outdoorsv2 from '../../../outdoorsv2/index.js';
import * as outdoorsv3 from '../../../outdoorsv3/index.js';
import * as outdoorsv4 from '../../../outdoorsv4/index.js';

function useV4() {
  const raw = String(process.env.OUTDOORS_V4_ENABLED || '').trim().toLowerCase();
  if (!raw) return false;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function useV3() {
  const raw = String(process.env.OUTDOORS_V3_ENABLED || '').trim().toLowerCase();
  if (!raw) return true;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

function bridge() {
  if (useV4()) return outdoorsv4;
  return useV3() ? outdoorsv3 : outdoorsv2;
}

export function executeClaudePrompt(prompt, options) {
  return bridge().executeClaudePrompt(prompt, options);
}

export function killProcess(key) {
  return bridge().killProcess(key);
}

export function codeAgentOptions(baseOptions, modelOverride) {
  return bridge().codeAgentOptions(baseOptions, modelOverride);
}

export function employeeAgentOptions(employeeName, baseOptions, modelOverride) {
  return bridge().employeeAgentOptions(employeeName, baseOptions, modelOverride);
}

export function getEmployeeMode(employeeName) {
  return bridge().getEmployeeMode(employeeName);
}

export function setProcessChangeListener(fn) {
  return bridge().setProcessChangeListener(fn);
}

export function setProcessActivityListener(fn) {
  return bridge().setProcessActivityListener(fn);
}

export function getActiveProcessSummary() {
  return bridge().getActiveProcessSummary();
}

export function getClarificationState(key) {
  return bridge().getClarificationState(key);
}

export function clearClarificationState(key) {
  return bridge().clearClarificationState(key);
}
