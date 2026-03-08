// Session manager — creates isolated execution contexts for concurrent sessions.
// Each session gets its own short-term directory for temporary files (images, etc.).

import { randomUUID } from 'crypto';
import { mkdirSync, readdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_ROOT = join(__dirname, '..', '..', 'outdoorsv1', 'backend', 'bot', 'memory');
const SHORT_TERM_ROOT = join(MEMORY_ROOT, 'short-term');

// Active sessions: Map<sessionId, SessionContext>
const activeSessions = new Map();

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Create a new isolated session.
 * @param {string} processKey - routing key (e.g. "web:conv:1", "wa:chat:123")
 * @param {string} transport - "web" | "whatsapp"
 * @returns {SessionContext}
 */
export function createSession(processKey, transport) {
  const id = randomUUID();
  const shortTermDir = join(SHORT_TERM_ROOT, id);
  mkdirSync(shortTermDir, { recursive: true });

  const ctx = {
    id,
    processKey,
    transport,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    shortTermDir,
    claudeSessionId: null, // Claude CLI's --resume session ID
    status: 'active',
  };

  activeSessions.set(id, ctx);
  return ctx;
}

/**
 * Look up an active session by its internal ID.
 */
export function getSession(id) {
  return activeSessions.get(id) || null;
}

/**
 * Find an active session by its Claude --resume session ID.
 */
export function findSessionByClaudeId(claudeSessionId) {
  for (const ctx of activeSessions.values()) {
    if (ctx.claudeSessionId === claudeSessionId) return ctx;
  }
  return null;
}

/**
 * Update lastActivity timestamp (keeps session alive).
 */
export function touchSession(id) {
  const ctx = activeSessions.get(id);
  if (ctx) ctx.lastActivity = Date.now();
}

/**
 * Get the session-scoped short-term directory.
 * Falls back to the global short-term dir if sessionId is unknown.
 */
export function getShortTermDir(sessionId) {
  const ctx = activeSessions.get(sessionId);
  if (!ctx) return SHORT_TERM_ROOT;
  return ctx.shortTermDir;
}

/**
 * Track which Claude CLI session ID belongs to this internal session.
 */
export function setClaudeSessionId(sessionId, claudeSessionId) {
  const ctx = activeSessions.get(sessionId);
  if (ctx) ctx.claudeSessionId = claudeSessionId;
}

/**
 * Close a session and clean up its short-term directory.
 * Output directories are NOT cleaned (outputs persist).
 */
export function closeSession(sessionId) {
  const ctx = activeSessions.get(sessionId);
  if (!ctx) return;
  ctx.status = 'closed';

  // Clean up short-term files for this session only
  cleanupDir(ctx.shortTermDir);
  activeSessions.delete(sessionId);
}

/**
 * List all active sessions (for dashboard API).
 */
export function listActiveSessions() {
  return Array.from(activeSessions.values()).map(ctx => ({
    id: ctx.id,
    processKey: ctx.processKey,
    transport: ctx.transport,
    createdAt: ctx.createdAt,
    lastActivity: ctx.lastActivity,
    status: ctx.status,
    claudeSessionId: ctx.claudeSessionId,
  }));
}

/**
 * Remove sessions that have been inactive for longer than SESSION_TTL_MS.
 */
export function cleanupStaleSessions() {
  const now = Date.now();
  for (const [id, ctx] of activeSessions) {
    if (now - ctx.lastActivity > SESSION_TTL_MS) {
      closeSession(id);
    }
  }
}

/**
 * On server startup, remove orphaned session directories that don't
 * correspond to any active session (e.g. from a previous crash).
 */
export function cleanupOrphanedSessionDirs() {
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  // Clean orphaned short-term dirs
  try {
    if (existsSync(SHORT_TERM_ROOT)) {
      for (const entry of readdirSync(SHORT_TERM_ROOT, { withFileTypes: true })) {
        if (entry.isDirectory() && UUID_RE.test(entry.name)) {
          if (!activeSessions.has(entry.name)) {
            cleanupDir(join(SHORT_TERM_ROOT, entry.name));
          }
        }
      }
    }
  } catch {}
}

function cleanupDir(dir) {
  try {
    if (!existsSync(dir)) return;
    rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Periodic cleanup every 5 minutes
setInterval(cleanupStaleSessions, 5 * 60 * 1000);
