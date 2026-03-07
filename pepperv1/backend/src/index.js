import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import QRCode from 'qrcode';
import { readdirSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { config, saveConfig, loadConfig } from './config.js';
import { startWhatsApp, setSocketIO, getStatus, getLastQR } from './whatsapp-client.js';
import { startTelegram, setTelegramSocketIO } from './telegram/bot.js';
import { startSmsGateway, setSmsSocketIO, handleIncomingSms } from './sms/gateway.js';
import { execFile, execFileSync } from 'child_process';
import { executeClaudePrompt, killProcess, codeAgentOptions, getActiveProcessSummary, setProcessChangeListener, setProcessActivityListener, clearClarificationState } from './claude-bridge.js';
import { parseMessage, resolveSession, createOrUpdateConversation, closeConversation, listConversations, getConversationMode } from './conversation-manager.js';
import { assertRuntimeBridgeReady, createRuntimeAwareProgress, getRuntimeHealthStatus, getRuntimeStatusPayload } from './runtime-health.js';
import { extractImages } from './transport-utils.js';
import { createSession, closeSession, listActiveSessions, cleanupOrphanedSessionDirs } from '../../../pepperv4/session/session-manager.js';
import { ensureBrowserReady } from './browser-health.js';
import { registerStartup } from './register-startup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SHORT_TERM_DIR = join(__dirname, '..', 'bot', 'memory', 'short-term');
const LOGS_DIR = join(__dirname, '..', 'bot', 'logs');

const app = express();
const server = createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use('/landing', express.static(join(__dirname, '..', 'public')));
app.use(express.static(join(__dirname, '..', '..', 'frontend'), {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store'),
}));

// API routes
app.get('/api/health/claude', (_req, res) => {
  try {
    const out = execFileSync('claude', ['--version'], { shell: true, timeout: 10000, encoding: 'utf-8' });
    res.json({ ok: true, version: out.trim() });
  } catch (err) {
    if (err.code === 'ENOENT' || (err.message && err.message.includes('not recognized'))) {
      res.json({ ok: false, error: 'not_found' });
    } else {
      res.json({ ok: false, error: 'unknown', detail: err.message });
    }
  }
});

app.get('/api/status', (_req, res) => {
  res.json({ status: getStatus(), ...getRuntimeStatusPayload() });
});

app.get('/api/runtime', (_req, res) => {
  res.json(getRuntimeStatusPayload());
});

app.get('/api/config', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    allowedNumbers: cfg.allowedNumbers,
    allowAllNumbers: cfg.allowAllNumbers,
    prefix: cfg.prefix,
    rateLimitPerMinute: cfg.rateLimitPerMinute,
    maxResponseLength: cfg.maxResponseLength,
    messageTimeout: cfg.messageTimeout,
    telegramToken: cfg.telegramToken ? '***configured***' : '',
    telegramPrefix: cfg.telegramPrefix,
    telegramAllowedIds: cfg.telegramAllowedIds,
    smsGatewayUrl: cfg.smsGatewayUrl || '',
    smsGatewayUsername: cfg.smsGatewayUsername ? '***configured***' : '',
    smsGatewayPassword: cfg.smsGatewayPassword ? '***configured***' : '',
    smsAllowedNumbers: cfg.smsAllowedNumbers || [],
    smsPrefix: cfg.smsPrefix || '',
  });
});

app.post('/api/config', (req, res) => {
  const cfg = loadConfig();
  const allowed = ['allowedNumbers', 'allowAllNumbers', 'prefix', 'rateLimitPerMinute', 'maxResponseLength', 'messageTimeout', 'telegramToken', 'telegramPrefix', 'telegramAllowedIds', 'smsGatewayUrl', 'smsGatewayUsername', 'smsGatewayPassword', 'smsAllowedNumbers', 'smsPrefix'];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      cfg[key] = req.body[key];
      config[key] = req.body[key];
    }
  }
  saveConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/sms/webhook', (req, res) => {
  const payload = req.body?.payload || req.body;
  if (payload?.phoneNumber && payload?.message) {
    handleIncomingSms(payload);
  }
  res.status(200).json({ ok: true });
});

// Bluetooth connect endpoint — runs connect-bt.ps1
app.post('/api/bluetooth/connect', (_req, res) => {
  const scriptPath = join(__dirname, '..', 'connect-bt.ps1');
  execFile('powershell', ['-ExecutionPolicy', 'Bypass', '-File', scriptPath], { timeout: 30000 }, (err, stdout, stderr) => {
    if (err) {
      console.log('[Bluetooth] Error:', err.message);
      return res.json({ ok: false, error: err.message, output: stdout + stderr });
    }
    console.log('[Bluetooth]', stdout);
    const success = stdout.includes('SUCCESS') || stdout.includes('Status: OK');
    res.json({ ok: success, output: stdout });
  });
});

app.get('/api/qr', async (_req, res) => {
  const qr = getLastQR();
  if (!qr) return res.status(404).send('No QR available');
  try {
    const svg = await QRCode.toString(qr, { type: 'svg', margin: 2 });
    res.type('svg').send(svg);
  } catch {
    res.status(500).send('QR generation failed');
  }
});

// --- Conversation log index (built on startup, updated incrementally) ---
let logIndex = []; // [{ filename, sessionId, conversationNumber, sender, prompt, timestamp, cost }]
let logCounter = 0;

export function nextLogNumber() {
  return logCounter++;
}

function buildLogIndex() {
  try {
    const files = readdirSync(LOGS_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const num = parseInt(f, 10);
      if (!isNaN(num) && num >= logCounter) logCounter = num + 1;
    }
    logIndex = files.map(filename => {
      try {
        const data = JSON.parse(readFileSync(join(LOGS_DIR, filename), 'utf-8'));
        const costEvent = (data.fullEvents || data.events || []).find(e => e.type === 'cost');
        return {
          filename,
          sessionId: data.sessionId || null,
          conversationNumber: data.conversationNumber ?? null,
          sender: data.sender || 'unknown',
          prompt: (data.prompt || '').slice(0, 80),
          timestamp: data.timestamp,
          cost: costEvent?.cost || 0,
        };
      } catch { return null; }
    }).filter(Boolean);
  } catch { logIndex = []; }
}

export function addToLogIndex(filename, data) {
  const costEvent = (data.fullEvents || data.events || []).find(e => e.type === 'cost');
  logIndex.push({
    filename,
    sessionId: data.sessionId || null,
    conversationNumber: data.conversationNumber ?? null,
    sender: data.sender || 'unknown',
    prompt: (data.prompt || '').slice(0, 80),
    timestamp: data.timestamp,
    cost: costEvent?.cost || 0,
  });
}

// Conversation API endpoints
app.get('/api/conversations', (_req, res) => {
  // Group logs by sessionId
  const groups = {};
  for (const entry of logIndex) {
    const key = entry.sessionId || entry.filename;
    if (!groups[key]) {
      groups[key] = {
        sessionId: entry.sessionId,
        conversationNumber: entry.conversationNumber,
        sender: entry.sender,
        firstMessage: entry.prompt,
        firstTimestamp: entry.timestamp,
        lastTimestamp: entry.timestamp,
        messageCount: 0,
        totalCost: 0,
      };
    }
    const g = groups[key];
    g.messageCount++;
    g.totalCost += entry.cost || 0;
    if (entry.conversationNumber !== null) g.conversationNumber = entry.conversationNumber;
    if (entry.timestamp > g.lastTimestamp) g.lastTimestamp = entry.timestamp;
    if (entry.timestamp < g.firstTimestamp) {
      g.firstTimestamp = entry.timestamp;
      g.firstMessage = entry.prompt;
    }
  }
  const list = Object.values(groups).sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  res.json(list);
});

app.get('/api/conversations/active', (_req, res) => {
  res.json(listConversations());
});

app.get('/api/processes', (_req, res) => {
  res.json(getActiveProcessSummary());
});

app.get('/api/conversations/:sessionId', (req, res) => {
  const sid = req.params.sessionId;
  const matching = logIndex.filter(e => e.sessionId === sid);
  if (!matching.length) return res.status(404).json({ error: 'Not found' });

  const messages = matching
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .map(entry => {
      try {
        return JSON.parse(readFileSync(join(LOGS_DIR, entry.filename), 'utf-8'));
      } catch { return null; }
    })
    .filter(Boolean);

  res.json({
    sessionId: sid,
    conversationNumber: matching[0].conversationNumber,
    messages,
  });
});

// Session isolation API endpoints
app.get('/api/sessions', (_req, res) => {
  res.json(listActiveSessions());
});

app.delete('/api/sessions/:id', (req, res) => {
  const id = req.params.id;
  const sessions = listActiveSessions();
  const session = sessions.find(s => s.id === id);
  if (session) {
    killProcess(session.processKey);
    closeSession(id);
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: 'Session not found' });
  }
});

// Web chat session tracking
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
let webSession = { sessionId: null, lastActivity: 0 };
const activeWebConversations = new Set();  // numbered conv numbers currently in-flight
const activeWebWindows = new Set();         // windowIds currently in-flight (unnumbered)

function cleanupShortTerm() {
  try {
    const files = readdirSync(SHORT_TERM_DIR);
    for (const f of files) unlinkSync(join(SHORT_TERM_DIR, f));
  } catch {}
}

function normalizeQuestionsPayload(payload) {
  if (!payload) return { questions: [] };
  if (Array.isArray(payload.questions)) return payload;
  if (Array.isArray(payload)) return { questions: payload };
  return { questions: [], raw: payload };
}

// Socket.IO
io.on('connection', async (socket) => {
  socket.emit('status', getStatus());
  socket.emit('process_status', getActiveProcessSummary());

  // Re-send last QR if one exists (handles page load after QR was generated)
  const qr = getLastQR();
  if (qr && getStatus() === 'waiting_for_qr') {
    try {
      const dataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 2 });
      socket.emit('qr', dataUrl);
    } catch {}
  }

  // Web chat messages — accepts string or { text, image, sessionId } object
  socket.on('web_message', async (data) => {
    let prompt, imageBase64, imageMime, clientSessionId, windowId;
    if (typeof data === 'string') {
      prompt = data;
    } else if (data && typeof data === 'object') {
      prompt = data.text || '';
      imageBase64 = data.image; // base64-encoded image data
      imageMime = data.imageMime || 'image/jpeg';
      clientSessionId = data.sessionId || null;
      windowId = data.windowId || null;
    }
    if ((!prompt || typeof prompt !== 'string' || !prompt.trim()) && !imageBase64) return;

    const trimmed = (prompt || '').trim();
    if (!trimmed && !imageBase64) return;

    // Handle /new to clear session
    if (trimmed && trimmed.toLowerCase() === '/new') {
      webSession = { sessionId: null, lastActivity: 0 };
      clearClarificationState(`web:win:${windowId || '__no_window__'}`);
      socket.emit('chat_response', 'Session cleared. Next message starts fresh.');
      return;
    }

    // Parse for numbered conversation prefix — only for non-dashboard clients.
    // Dashboard windows (identified by windowId) don't use the number system;
    // each window IS a conversation. Numbers are only needed on phone platforms.
    let parsed;
    if (windowId) {
      if (/^stop$/i.test(trimmed)) {
        parsed = { number: null, command: 'stop', body: '' };
      } else {
        parsed = { number: null, command: 'message', body: trimmed || 'What is this image?' };
      }
    } else {
      parsed = parseMessage(trimmed || 'What is this image?');
    }

    // Handle close command
    if (parsed.command === 'close') {
      const closed = closeConversation(parsed.number);
      clearClarificationState(`web:conv:${parsed.number}`);
      socket.emit('chat_response', closed
        ? `Conversation #${parsed.number} closed.`
        : `No active conversation #${parsed.number}.`);
      return;
    }

    const windowKey = windowId || '__no_window__';

    // Handle stop command — bypass concurrency gating
    if (parsed.command === 'stop') {
      const processKey = parsed.number !== null ? `web:conv:${parsed.number}` : `web:win:${windowKey}`;
      const killed = killProcess(processKey);
      clearClarificationState(processKey);
      if (killed) {
        const label = parsed.number !== null ? `conversation #${parsed.number}` : 'current conversation';
        socket.emit('chat_response', `Stopped ${label}.`);
      } else {
        const label = parsed.number !== null ? `conversation #${parsed.number}` : 'this chat';
        socket.emit('chat_response', `Nothing running for ${label}.`);
      }
      return;
    }

    // Track active conversations/windows (for cleanup gating, not blocking)
    if (parsed.number !== null) {
      activeWebConversations.add(parsed.number);
    } else {
      activeWebWindows.add(windowKey);
    }

    // Unique ID for correlating responses when multiple messages are in-flight
    const messageId = randomBytes(4).toString('hex');

    // Determine session: numbered conversation takes priority, then client-provided sessionId.
    // Only fall back to global webSession for non-dashboard clients (no windowId) — dashboard
    // windows that send no sessionId are intentionally starting a new conversation.
    let resumeSessionId = null;
    if (parsed.number !== null) {
      resumeSessionId = resolveSession(parsed.number);
    } else if (clientSessionId) {
      resumeSessionId = clientSessionId;
    } else if (!windowId && webSession.sessionId && (Date.now() - webSession.lastActivity) < SESSION_TIMEOUT_MS) {
      resumeSessionId = webSession.sessionId;
    }

    // Save image to disk if present (session-scoped directory)
    let finalPrompt = parsed.body;
    if (imageBase64) {
      try {
        const imageDir = session.shortTermDir;
        mkdirSync(imageDir, { recursive: true });
        const ext = imageMime.includes('png') ? 'png' : 'jpg';
        const filename = `web_${randomBytes(4).toString('hex')}.${ext}`;
        const filepath = join(imageDir, filename);
        writeFileSync(filepath, Buffer.from(imageBase64, 'base64'));
        const caption = finalPrompt || 'What is this image?';
        finalPrompt = `[The user sent an image. Read it with your Read tool at: ${filepath}]\n\n${caption}`;
      } catch (err) {
        console.log('[web:image_save_error]', err.message);
      }
    }

    const processKey = parsed.number !== null ? `web:conv:${parsed.number}` : `web:win:${windowKey}`;
    const convoLog = { sender: 'web', prompt: finalPrompt, conversationNumber: parsed.number, resumeSessionId, timestamp: new Date().toISOString(), events: [] };
    const isKnownCode = parsed.number !== null && getConversationMode(parsed.number) === 'code';
    // Track current sessionId for progress events (starts with resume or client-provided)
    let currentSessionId = resumeSessionId || clientSessionId || null;

    // Create an isolated session for this execution
    const session = createSession(processKey, 'web');
    io.emit('session_created', { id: session.id, processKey, transport: 'web' });
    io.emit('log', { type: 'incoming', data: { sender: 'web', processKey, prompt: finalPrompt, conversation: parsed.number }, timestamp: new Date().toISOString() });

    try {
      const progressWrapper = createRuntimeAwareProgress((type, data) => {
        io.emit('log', { type, data: { sender: 'web', processKey, ...data }, timestamp: new Date().toISOString() });
        convoLog.events.push({ type, ...data });
        socket.emit('chat_progress', { type, data, sessionId: currentSessionId, messageId });
      });
      const onProgress = progressWrapper.onProgress;
      convoLog.runtimeFingerprint = progressWrapper.health.bootFingerprint;
      convoLog.runtimeStaleDetected = progressWrapper.health.stale;
      convoLog.runtimeChangedFiles = progressWrapper.health.changedFiles;
      if (progressWrapper.health.stale) {
        io.emit('log', { type: 'runtime_stale_code_detected', data: { sender: 'web', processKey, changedFiles: progressWrapper.health.changedFiles }, timestamp: new Date().toISOString() });
      }

      let execResult;
      let didDelegate = false;
      if (isKnownCode) {
        execResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress, resumeSessionId, processKey, clarificationKey: processKey, sessionContext: session }));
      } else {
        execResult = await executeClaudePrompt(finalPrompt, { onProgress, resumeSessionId, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
        if (execResult.delegation) {
          didDelegate = true;
          io.emit('log', { type: 'delegation', data: { sender: 'web', processKey, employee: 'coder', model: execResult.delegation.model }, timestamp: new Date().toISOString() });
          socket.emit('chat_progress', { type: 'delegation', data: { employee: 'coder', model: execResult.delegation.model }, sessionId: currentSessionId, messageId });
          execResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }, execResult.delegation.model));
        }
      }
      if (execResult.status === 'needs_user_input') {
        convoLog.clarificationState = {
          status: 'needs_user_input',
          questions: execResult.questions,
        };
        socket.emit('chat_questions', {
          questions: normalizeQuestionsPayload(execResult.questions),
          sessionId: currentSessionId,
          windowId,
          messageId,
        });
        io.emit('log', { type: 'clarification_requested', data: { sender: 'web', processKey, conversation: parsed.number, windowId }, timestamp: new Date().toISOString() });
        return;
      }
      const { response, sessionId, fullEvents } = execResult;
      if (sessionId) currentSessionId = sessionId;

      const mode = (isKnownCode || didDelegate) ? 'code' : 'assistant';
      if (sessionId) {
        if (parsed.number !== null) {
          createOrUpdateConversation(parsed.number, sessionId, parsed.body, 'web', mode);
        }
        webSession = { sessionId, lastActivity: Date.now() };
      }
      convoLog.response = response;
      convoLog.sessionId = sessionId;
      convoLog.fullEvents = fullEvents;
      const { images: responseImages, cleanText: responseCleanText } = extractImages(response);
      socket.emit('chat_response', { response: responseCleanText, sessionId: currentSessionId, images: responseImages, messageId });
      io.emit('conversation_update', { sessionId, conversationNumber: parsed.number });
    } catch (err) {
      if (err.stopped) {
        // Stop handler already sent a response — just let finally clean up
      } else if (resumeSessionId) {
        // Retry without session if resume failed
        webSession = { sessionId: null, lastActivity: 0 };
        currentSessionId = null;
        try {
          const progressWrapper = createRuntimeAwareProgress((type, data) => {
            io.emit('log', { type, data: { sender: 'web', processKey, ...data }, timestamp: new Date().toISOString() });
            convoLog.events.push({ type, ...data });
            socket.emit('chat_progress', { type, data, sessionId: currentSessionId, messageId });
          });
          const onProgress = progressWrapper.onProgress;
          convoLog.runtimeFingerprint = progressWrapper.health.bootFingerprint;
          convoLog.runtimeStaleDetected = progressWrapper.health.stale;
          convoLog.runtimeChangedFiles = progressWrapper.health.changedFiles;
          if (progressWrapper.health.stale) {
            io.emit('log', { type: 'runtime_stale_code_detected', data: { sender: 'web', processKey, changedFiles: progressWrapper.health.changedFiles }, timestamp: new Date().toISOString() });
          }

          let execResult;
          let didDelegate = false;
          if (isKnownCode) {
            execResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }));
          } else {
            execResult = await executeClaudePrompt(finalPrompt, { onProgress, processKey, clarificationKey: processKey, detectDelegation: true, sessionContext: session });
            if (execResult.delegation) {
              didDelegate = true;
              socket.emit('chat_progress', { type: 'delegation', data: { employee: 'coder', model: execResult.delegation.model }, sessionId: currentSessionId, messageId });
              execResult = await executeClaudePrompt(finalPrompt, codeAgentOptions({ onProgress, processKey, clarificationKey: processKey, sessionContext: session }, execResult.delegation.model));
            }
          }
          if (execResult.status === 'needs_user_input') {
            convoLog.clarificationState = {
              status: 'needs_user_input',
              questions: execResult.questions,
            };
            socket.emit('chat_questions', {
              questions: normalizeQuestionsPayload(execResult.questions),
              sessionId: currentSessionId,
              windowId,
              messageId,
            });
            io.emit('log', { type: 'clarification_requested', data: { sender: 'web', processKey, conversation: parsed.number, windowId }, timestamp: new Date().toISOString() });
            return;
          }
          const { response, sessionId, fullEvents } = execResult;
          if (sessionId) currentSessionId = sessionId;

          const mode = (isKnownCode || didDelegate) ? 'code' : 'assistant';
          if (sessionId) {
            if (parsed.number !== null) {
              createOrUpdateConversation(parsed.number, sessionId, finalPrompt, 'web', mode);
            }
            webSession = { sessionId, lastActivity: Date.now() };
          }
          convoLog.response = response;
          convoLog.sessionId = sessionId;
          convoLog.fullEvents = fullEvents;
          const { images: retryImages, cleanText: retryCleanText } = extractImages(response);
          socket.emit('chat_response', { response: retryCleanText, sessionId: currentSessionId, images: retryImages, messageId });
        } catch (retryErr) {
          convoLog.error = retryErr.message;
          socket.emit('chat_error', { error: retryErr.message, messageId });
        }
      } else {
        convoLog.error = err.message;
        socket.emit('chat_error', { error: err.message, messageId });
      }
    } finally {
      // Release tracking for this conversation/window
      if (parsed.number !== null) {
        activeWebConversations.delete(parsed.number);
      } else {
        activeWebWindows.delete(windowKey);
      }

      // Close the session — cleans up this session's short-term dir only
      closeSession(session.id);
      io.emit('session_closed', { id: session.id });
    }

    // Persist log
    try {
      mkdirSync(LOGS_DIR, { recursive: true });
      const filename = `${nextLogNumber()}_web.json`;
      writeFileSync(join(LOGS_DIR, filename), JSON.stringify(convoLog, null, 2));
      addToLogIndex(filename, convoLog);
    } catch {}
  });

  console.log('Dashboard client connected');
});

setSocketIO(io);
setTelegramSocketIO(io);
setSmsSocketIO(io);
setProcessChangeListener(() => io.emit('process_status', getActiveProcessSummary()));
setProcessActivityListener((processKey, type, summary) => {
  io.emit('process_activity', { processKey, type, summary });
});

// Build log index before starting
buildLogIndex();
console.log(`  [Logs] Indexed ${logIndex.length} conversation logs`);

// Clean up orphaned session directories from previous crashes
cleanupOrphanedSessionDirs();
console.log('  [Sessions] Cleaned up orphaned session directories');
assertRuntimeBridgeReady();
const runtimeHealth = getRuntimeHealthStatus();
console.log(`  [Runtime] PID ${runtimeHealth.bootFingerprint.pid} started ${runtimeHealth.bootFingerprint.processStartTime}`);
console.log(`  [Runtime] git=${runtimeHealth.bootFingerprint.gitCommit || 'unknown'} stale=${runtimeHealth.stale}`);
if (runtimeHealth.stale) {
  console.log(`  [Runtime] changed files: ${runtimeHealth.changedFiles.map(f => f.path).join(', ')}`);
}

// Start
server.listen(config.port, async () => {
  console.log(`\n  Pepper Claude Bridge`);
  console.log(`  Dashboard: http://localhost:${config.port}\n`);

  // Register app to start automatically at Windows login (idempotent)
  await registerStartup();

  // Ensure browser is running with CDP for Playwright tasks
  await ensureBrowserReady();

  // Start WhatsApp bridge
  console.log('  [WhatsApp] Starting...');
  startWhatsApp();

  // Start Telegram bot
  console.log('  [Telegram] Starting...');
  startTelegram();

  // Start SMS Gateway
  console.log('  [SMS] Starting...');
  const smsWebhookBase = process.env.SMS_WEBHOOK_BASE || `http://localhost:${config.port}`;
  startSmsGateway(smsWebhookBase);
});
