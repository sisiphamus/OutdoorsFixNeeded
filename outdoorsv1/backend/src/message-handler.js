import { executeClaudePrompt, killProcess, codeAgentOptions, clearClarificationState, getActiveProcessSummary } from './claude-bridge.js';
import { config } from './config.js';
import { parseMessage, resolveSession, createOrUpdateConversation, closeConversation, getConversationMode } from './conversation-manager.js';
import { downloadContentFromMessage } from '@whiskeysockets/baileys';
import { writeFileSync, mkdirSync, readFileSync, existsSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';
import { createRuntimeAwareProgress } from './runtime-health.js';
import { createSession, closeSession } from '../../../outdoorsv4/session/session-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHORT_TERM_DIR = join(__dirname, '..', 'bot', 'memory', 'short-term');
const CHAT_SESSIONS_PATH = join(__dirname, '..', 'bot', 'memory', 'wa-chat-sessions.json');
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;

// Track active sessions per JID for conversation continuity
const chatSessions = new Map();

function loadChatSessions() {
  try {
    if (existsSync(CHAT_SESSIONS_PATH)) {
      const data = JSON.parse(readFileSync(CHAT_SESSIONS_PATH, 'utf-8'));
      for (const [key, value] of Object.entries(data)) {
        chatSessions.set(key, value);
      }
    }
  } catch {}
}

function saveChatSessions() {
  try {
    const obj = {};
    for (const [key, value] of chatSessions) {
      obj[key] = value;
    }
    const tmpPath = CHAT_SESSIONS_PATH + `.tmp.${randomBytes(4).toString('hex')}`;
    writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    renameSync(tmpPath, CHAT_SESSIONS_PATH);
  } catch {}
}

loadChatSessions();

const rateLimitMap = new Map();

function isRateLimited(jid) {
  const now = Date.now();
  const timestamps = rateLimitMap.get(jid) || [];
  const recent = timestamps.filter((t) => now - t < 60000);
  rateLimitMap.set(jid, recent);
  return recent.length >= config.rateLimitPerMinute;
}

function recordMessage(jid) {
  const timestamps = rateLimitMap.get(jid) || [];
  timestamps.push(Date.now());
  rateLimitMap.set(jid, timestamps);
}

function isAllowed(jid) {
  if (config.allowAllNumbers) return true;
  const number = jid.replace(/@.*/, '');
  return config.allowedNumbers.some((n) => number.includes(n.replace(/\D/g, '')));
}

function extractPrompt(text) {
  if (!text) return null;
  if (config.prefix && text.startsWith(config.prefix)) {
    return text.slice(config.prefix.length).trim();
  }
  if (!config.prefix) return text.trim();
  return null;
}

function formatQuestionsForText(questionsPayload) {
  const questions = Array.isArray(questionsPayload?.questions) ? questionsPayload.questions : [];
  if (!questions.length) {
    return 'I need a bit more detail before I continue. Please reply with the missing details.';
  }
  const lines = ['I need a few details before I continue:'];
  for (let i = 0; i < questions.length; i++) {
    lines.push(`${i + 1}. ${questions[i].question || 'Please clarify'}`);
  }
  lines.push('Reply with your answer(s), and I will continue.');
  return lines.join('\n');
}

/**
 * Downloads an image from a WhatsApp message and saves it to short-term memory.
 * Returns the file path or null.
 */
async function downloadWhatsAppImage(message, imageDir) {
  const imageMsg = message.message?.imageMessage || message.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;
  if (!imageMsg) return null;

  const dir = imageDir || SHORT_TERM_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    const stream = await downloadContentFromMessage(imageMsg, 'image');
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    const ext = (imageMsg.mimetype || 'image/jpeg').includes('png') ? 'png' : 'jpg';
    const filename = `wa_${randomBytes(4).toString('hex')}.${ext}`;
    const filepath = join(dir, filename);
    writeFileSync(filepath, buffer);
    return filepath;
  } catch (err) {
    console.log('[whatsapp:image_download_error]', err.message);
    return null;
  }
}

/**
 * Processes an incoming WhatsApp message.
 * Returns { response, sender, prompt } or null if the message should be ignored.
 */
export async function handleMessage(message, emitLog) {
  const jid = message.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return null;

  // Extract text from various message types
  const text =
    message.message?.conversation ||
    message.message?.extendedTextMessage?.text ||
    message.message?.imageMessage?.caption ||
    null;

  // Check if there's an image attached
  const hasImage = !!(message.message?.imageMessage);

  // Need either text or an image
  if (!text && !hasImage) return null;

  // Self-messages and group messages bypass the prefix requirement
  const isSelfMessage = !!message.key.fromMe;
  const isGroup = jid.endsWith('@g.us');
  let prompt;
  if (isSelfMessage || isGroup) {
    prompt = (text || (hasImage ? 'What is this image?' : null))?.trim() || null;
    // Still strip prefix if present
    if (prompt && config.prefix && prompt.startsWith(config.prefix)) {
      prompt = prompt.slice(config.prefix.length).trim();
    }
  } else {
    prompt = extractPrompt(text || (hasImage ? 'What is this image?' : null));
  }
  if (!prompt) return null;

  const sender = message.pushName || jid.replace(/@.*/, '');
  emitLog?.('incoming', { sender, prompt, jid });

  if (!isSelfMessage && !isGroup && !isAllowed(jid)) {
    emitLog?.('blocked', { sender, jid, reason: 'not in allowed list' });
    return null;
  }

  if (isRateLimited(jid)) {
    emitLog?.('rate-limited', { sender, jid });
    return { response: 'Rate limited. Please wait a moment.', sender, prompt, jid };
  }

  recordMessage(jid);

  // Parse for numbered conversation prefix
  const parsed = parseMessage(prompt);

  // Handle close command
  if (parsed.command === 'close') {
    const closed = closeConversation(parsed.number);
    clearClarificationState(`wa:conv:${parsed.number}`);
    const response = closed
      ? `Conversation #${parsed.number} closed.`
      : `No active conversation #${parsed.number}.`;
    return { response, sender, prompt, jid };
  }

  // Handle stop command
  if (parsed.command === 'stop') {
    const processKey = parsed.number !== null ? `wa:conv:${parsed.number}` : `wa:chat:${jid}`;
    const killed = killProcess(processKey);
    clearClarificationState(processKey);
    if (killed) {
      const label = parsed.number !== null ? `conversation #${parsed.number}` : 'current conversation';
      return { response: `Stopped ${label}.`, sender, prompt, jid };
    } else {
      const label = parsed.number !== null ? `conversation #${parsed.number}` : 'this chat';
      return { response: `Nothing running for ${label}.`, sender, prompt, jid };
    }
  }

  // Handle pause command (same as stop, friendlier message)
  if (parsed.command === 'pause') {
    const processKey = parsed.number !== null ? `wa:conv:${parsed.number}` : `wa:chat:${jid}`;
    killProcess(processKey);
    clearClarificationState(processKey);
    const label = parsed.number !== null ? `Conversation #${parsed.number}` : 'Conversation';
    return { response: `${label} paused. Send a message to continue.`, sender, prompt, jid };
  }

  // Handle new command (clear session, start fresh)
  if (parsed.command === 'new') {
    chatSessions.delete(jid);
    saveChatSessions();
    clearClarificationState(`wa:chat:${jid}`);
    return { response: 'Session cleared. Next message starts a fresh conversation.', sender, prompt, jid };
  }

  // Handle status command (show active processes)
  if (parsed.command === 'status') {
    const { numbered, unnumbered } = getActiveProcessSummary();
    if (numbered.length === 0 && unnumbered.length === 0) {
      return { response: 'No active conversations.', sender, prompt, jid };
    }
    const lines = [];
    for (const item of numbered) {
      const elapsed = Math.round((Date.now() - item.startedAt) / 1000);
      lines.push(`#${item.number} — ${item.label || 'untitled'} (${elapsed}s)`);
    }
    for (const item of unnumbered) {
      const elapsed = Math.round((Date.now() - item.startedAt) / 1000);
      lines.push(`${item.label || item.key} (${elapsed}s)`);
    }
    return { response: lines.join('\n'), sender, prompt, jid };
  }

  let resumeSessionId = null;
  if (parsed.number !== null) {
    resumeSessionId = resolveSession(parsed.number);
  } else {
    const existing = chatSessions.get(jid);
    if (existing && (Date.now() - existing.lastActivity) < SESSION_TIMEOUT_MS) {
      resumeSessionId = existing.sessionId;
    }
  }
  emitLog?.('processing', { sender, prompt: parsed.body, conversation: parsed.number, resuming: resumeSessionId });

  const processKey = parsed.number !== null ? `wa:conv:${parsed.number}` : `wa:chat:${jid}`;

  // Create isolated session for this execution
  const session = createSession(processKey, 'whatsapp');

  // Download image if present and prepend path to prompt (session-scoped dir)
  let finalPrompt = parsed.body;
  if (hasImage) {
    const imagePath = await downloadWhatsAppImage(message, session.shortTermDir);
    if (imagePath) {
      finalPrompt = `[The user sent an image. Read it with your Read tool at: ${imagePath}]\n\n${finalPrompt}`;
      emitLog?.('image', { sender, path: imagePath });
    }
  }

  const isKnownCode = parsed.number !== null && getConversationMode(parsed.number) === 'code';
  const progressWrapper = createRuntimeAwareProgress((type, data) => emitLog?.(type, { sender, ...data }));
  const onProgress = progressWrapper.onProgress;
  if (progressWrapper.health.stale) {
    emitLog?.('runtime_stale_code_detected', { sender, jid, changedFiles: progressWrapper.health.changedFiles });
  }

  try {
    let execResult;
    let didDelegate = false;
    if (isKnownCode) {
      execResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress, resumeSessionId, processKey, clarificationKey: processKey, sessionContext: session }));
    } else {
      execResult = await executeClaudePrompt(finalPrompt, { onProgress, resumeSessionId, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
      if (execResult.delegation) {
        didDelegate = true;
        emitLog?.('delegation', { sender, employee: 'coder', model: execResult.delegation.model });
        execResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }, execResult.delegation.model));
      }
    }
    if (execResult.status === 'needs_user_input') {
      const response = formatQuestionsForText(execResult.questions);
      return { response, sender, prompt: parsed.body, jid, sessionId: execResult.sessionId, fullEvents: execResult.fullEvents, conversationNumber: parsed.number };
    }
    const response = execResult.response;

    const mode = (isKnownCode || didDelegate) ? 'code' : 'assistant';
    if (execResult.sessionId) {
      if (parsed.number !== null) {
        createOrUpdateConversation(parsed.number, execResult.sessionId, parsed.body, 'whatsapp', mode);
      }
      chatSessions.set(jid, { sessionId: execResult.sessionId, lastActivity: Date.now() });
      saveChatSessions();
    }

    emitLog?.('response', { sender, prompt: parsed.body, responseLength: response.length });
    return {
      response,
      sender,
      prompt: parsed.body,
      jid,
      sessionId: execResult.sessionId,
      fullEvents: execResult.fullEvents,
      conversationNumber: parsed.number,
      runtimeFingerprint: progressWrapper.health.bootFingerprint,
      runtimeStaleDetected: progressWrapper.health.stale,
      runtimeChangedFiles: progressWrapper.health.changedFiles,
    };
  } catch (err) {
    if (err.stopped) {
      return null; // Stop handler already returned a response
    }
    // If resume failed, retry with a fresh session
    if (resumeSessionId) {
      emitLog?.('resume_failed', { sender, error: err.message, fallback: 'fresh session' });
      chatSessions.delete(jid);
      saveChatSessions();
      try {
        const retryProgressWrapper = createRuntimeAwareProgress((type, data) => emitLog?.(type, { sender, ...data }));
        const retryOnProgress = retryProgressWrapper.onProgress;
        let retryResult;
        let didRetryDelegate = false;
        if (isKnownCode) {
          retryResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress: retryOnProgress, processKey, clarificationKey: processKey, sessionContext: session }));
        } else {
          retryResult = await executeClaudePrompt(finalPrompt, { onProgress: retryOnProgress, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
          if (retryResult.delegation) {
            didRetryDelegate = true;
            retryResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress: retryOnProgress, processKey, clarificationKey: processKey, sessionContext: session }, retryResult.delegation.model));
          }
        }
        if (retryResult.status === 'needs_user_input') {
          const response = formatQuestionsForText(retryResult.questions);
          return { response, sender, prompt: parsed.body, jid, sessionId: retryResult.sessionId, fullEvents: retryResult.fullEvents, conversationNumber: parsed.number };
        }
        const mode = (isKnownCode || didRetryDelegate) ? 'code' : 'assistant';
        if (retryResult.sessionId) {
          if (parsed.number !== null) {
            createOrUpdateConversation(parsed.number, retryResult.sessionId, parsed.body, 'whatsapp', mode);
          }
          chatSessions.set(jid, { sessionId: retryResult.sessionId, lastActivity: Date.now() });
          saveChatSessions();
        }
        return {
          response: retryResult.response,
          sender,
          prompt: parsed.body,
          jid,
          sessionId: retryResult.sessionId,
          fullEvents: retryResult.fullEvents,
          conversationNumber: parsed.number,
          runtimeFingerprint: retryProgressWrapper.health.bootFingerprint,
          runtimeStaleDetected: retryProgressWrapper.health.stale,
          runtimeChangedFiles: retryProgressWrapper.health.changedFiles,
        };
      } catch (retryErr) {
        emitLog?.('error', { sender, prompt: parsed.body, error: retryErr.message });
        return { response: `Error: ${retryErr.message}`, sender, prompt: parsed.body, jid };
      }
    }
    emitLog?.('error', { sender, prompt: parsed.body, error: err.message });
    return {
      response: `Error: ${err.message}`,
      sender,
      prompt: parsed.body,
      jid,
      runtimeFingerprint: progressWrapper.health.bootFingerprint,
      runtimeStaleDetected: progressWrapper.health.stale,
      runtimeChangedFiles: progressWrapper.health.changedFiles,
    };
  } finally {
    // Clean up this session's short-term files
    closeSession(session.id);
  }
}

export { isAllowed, isRateLimited, extractPrompt, recordMessage };
