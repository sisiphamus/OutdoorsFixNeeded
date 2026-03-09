import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  makeCacheableSignalKeyStore,
  fetchLatestWaWebVersion,
  Browsers,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import QRCode from 'qrcode';
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config, saveConfig } from './config.js';
import { handleMessage } from './message-handler.js';
import { isOnboardingNeeded, handleOnboardingMessage } from './onboarding.js';
import { addToLogIndex, nextLogNumber } from './index.js';
import { extractImages } from './transport-utils.js';
import { formatOutdoorsResponse } from './wa-formatter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(__dirname, '..', 'bot', 'logs');

const logger = pino({ level: 'silent' });

async function sendOnboardingWelcome(sock, groupJid) {
  try {
    const msg = formatOutdoorsResponse(
      `Hey I'm Outdoors 🌲\n\n` +
      `Quick heads up — when you see the plant animation (🌱🌿🌳) on your message, that means I'm thinking.\n\n` +
      `Gonna ask a few quick questions so I can do my job better. Everything stays on your device and you can change any of it later.\n\n` +
      `So what's your name and when's your birthday? Are you a student or working rn? If you're in school — what school, class of ____, and what's your major? ` +
      `What's your favorite color? And what are your career plans and greatest aspiration?`
    );
    await sock.sendMessage(groupJid, { text: msg });
  } catch (err) {
    console.log('[WhatsApp] Failed to send onboarding welcome:', err.message);
    await sock.sendMessage(groupJid, { text: 'Outdoors is ready! Send a message here to get started.' }).catch(() => {});
  }
}

async function createOutdoorsGroup(sock, emitLog) {
  try {
    const group = await sock.groupCreate('Outdoors 🌲🏔️', []);
    const groupJid = group.id;
    config.outdoorsGroupJid = groupJid;
    saveConfig(config);
    console.log(`[WhatsApp] Created Outdoors group: ${groupJid}`);
    emitLog('group_created', { groupJid, message: 'Outdoors group created — open it in WhatsApp to start chatting' });

    await sock.groupUpdateDescription(groupJid, 'Send messages here to chat with Outdoors.').catch(() => {});

    // Send hardcoded welcome + Round 1 instantly (no LLM call)
    if (isOnboardingNeeded()) {
      await sendOnboardingWelcome(sock, groupJid);
    }
  } catch (err) {
    console.log('[WhatsApp] Failed to create Outdoors group:', err.message);
    emitLog('group_create_error', { error: err.message });
  }
}

let sock = null;
let io = null;
let connectionStatus = 'disconnected';
let lastQR = null;
let reconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 10;

// Track message IDs sent by the bot to prevent infinite loops
const botSentIds = new Set();
// Track message IDs currently being processed to deduplicate Baileys' multiple upsert events
const processingIds = new Set();
// Store sent messages for getMessage callback (needed for sender key retries).
// Module-scoped so it survives reconnects — Baileys needs prior messages to retry
// sender-key distribution, and a fresh Map on reconnect causes silent decryption failures.
const messageStore = new Map();
const MAX_STORE_SIZE = 5000;

function storeMessage(id, message) {
  messageStore.set(id, message);
  if (messageStore.size > MAX_STORE_SIZE) {
    const firstKey = messageStore.keys().next().value;
    messageStore.delete(firstKey);
  }
}

function setSocketIO(socketIO) {
  io = socketIO;
}

function emitLog(type, data) {
  const entry = { type, data, timestamp: new Date().toISOString() };
  io?.emit('log', entry);
  if (type !== 'qr') {
    console.log(`[${type}]`, JSON.stringify(data));
  }
}

function getStatus() {
  return connectionStatus;
}

async function startWhatsApp() {
  mkdirSync(config.authDir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

  let version;
  try {
    const result = await fetchLatestWaWebVersion({});
    version = result.version;
    console.log(`Using WhatsApp Web version: ${version.join('.')}`);
  } catch {
    version = [2, 3000, 1033498124];
    console.log(`Using fallback WhatsApp Web version: ${version.join('.')}`);
  }

  sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    browser: Browsers.windows('Chrome'),
    logger,
    generateHighQualityLinkPreview: false,
    markOnlineOnConnect: true,
    keepAliveIntervalMs: 15_000,
    retryRequestDelayMs: 250,
    getMessage: async (key) => {
      const stored = messageStore.get(key.id);
      return stored || undefined;
    },
  });

  sock.ev.on('creds.update', async () => {
    try { await saveCreds(); }
    catch (err) { console.log('[wa] Failed to save creds:', err.message); }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'waiting_for_qr';
      lastQR = qr;

      QRCode.toString(qr, { type: 'terminal', small: true }, (err, str) => {
        if (!err) console.log('\n' + str);
      });

      QRCode.toDataURL(qr, { width: 280, margin: 2 }, (err, dataUrl) => {
        if (!err) {
          io?.emit('qr', dataUrl);
        }
      });

      io?.emit('status', connectionStatus);
      emitLog('qr', { message: 'QR code generated - scan with WhatsApp' });
    }

    if (connection === 'close') {
      connectionStatus = 'disconnected';
      io?.emit('status', connectionStatus);

      const statusCode = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      emitLog('disconnected', { statusCode, willReconnect: shouldReconnect });

      if (shouldReconnect && reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempt++;
        const delay = Math.min(3000 * Math.pow(1.5, reconnectAttempt - 1), 30000);
        console.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempt}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(startWhatsApp, delay);
      } else if (reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) {
        console.log('Max reconnection attempts reached. Restart the server to try again.');
        emitLog('max_retries', { message: 'Max reconnection attempts reached' });
      } else {
        console.log('Logged out. Delete auth_state folder and restart to re-authenticate.');
        emitLog('logged_out', { message: 'Scan QR code again to reconnect' });
      }
    }

    if (connection === 'open') {
      connectionStatus = 'connected';
      reconnectAttempt = 0;
      io?.emit('status', connectionStatus);
      emitLog('connected', { message: 'WhatsApp connected successfully' });
      console.log('WhatsApp connected!');
      console.log('[wa] Connected as:', JSON.stringify(sock.user));

      if (!config.outdoorsGroupJid) {
        createOutdoorsGroup(sock, emitLog);
      } else {
        // Rename existing group to Outdoors
        (async () => {
          try {
            await sock.groupUpdateSubject(config.outdoorsGroupJid, 'Outdoors 🌲🏔️');
            await sock.groupUpdateDescription(config.outdoorsGroupJid, 'Send messages here to chat with Outdoors.').catch(() => {});
            console.log('[WhatsApp] Renamed group to Outdoors 🌲🏔️');
            if (isOnboardingNeeded()) {
              await sendOnboardingWelcome(sock, config.outdoorsGroupJid);
            }
          } catch (err) {
            console.log('[WhatsApp] Failed to rename group:', err.message, '— creating new group');
            config.outdoorsGroupJid = '';
            saveConfig(config);
            createOutdoorsGroup(sock, emitLog);
          }
        })();
      }
    }
  });

  sock.ev.on('messages.upsert', (upsert) => {
    if (upsert.type !== 'notify') return;
    const messages = upsert.messages || [];
    for (const msg of messages) {
      const msgId = msg.key.id;

      if (botSentIds.has(msgId)) {
        botSentIds.delete(msgId);
        continue;
      }

      if (processingIds.has(msgId)) {
        console.log(`[wa:dedup] Skipping already-processing message ${msgId}`);
        continue;
      }
      processingIds.add(msgId);

      // Skip status updates / delivery receipts with no message content
      if (!msg.message) {
        console.log(`[wa:skip] No message content for ${msgId} from ${msg.key.remoteJid} (likely decryption failure)`);
        continue;
      }

      // Store incoming messages so getMessage can fulfill group retry requests
      if (msg.message) storeMessage(msgId, msg.message);

      // Skip messages sent by us UNLESS it's a group (solo group for self-messaging)
      const remoteJid = msg.key.remoteJid;
      const isGroup = remoteJid?.endsWith('@g.us');
      if (msg.key.fromMe && !isGroup) {
        continue;
      }

      // Fire off each message concurrently — each spawns its own Claude instance
      (async () => {
        const jid = msg.key.remoteJid;
        // (fire-and-forget body — .catch() added at bottom)

        // Retry helper: attempts to send a WhatsApp message up to 3 times
        async function sendWithRetry(jid, content, opts, retries = 3) {
          for (let attempt = 1; attempt <= retries; attempt++) {
            try {
              const sent = await sock.sendMessage(jid, content, opts);
              return sent;
            } catch (err) {
              console.log(`[wa:send] attempt ${attempt}/${retries} failed:`, err.message);
              if (attempt === retries) throw err;
              await new Promise(r => setTimeout(r, 1000 * attempt));
            }
          }
        }

        // Cycle 🌱🌿🌳🪾🍃 reaction while processing
        const growEmojis = ['🌱', '🌿', '🌳', '🪾', '🍃'];
        let growIdx = 0;
        const pulseInterval = setInterval(async () => {
          try {
            growIdx = (growIdx + 1) % growEmojis.length;
            await sock.sendMessage(jid, { react: { key: msg.key, text: growEmojis[growIdx] } });
          } catch {}
        }, 1500);

        try {
          await sock.sendMessage(jid, { react: { key: msg.key, text: '🌱' } });
          console.log('[react] 🌱 sent');

          // --- Onboarding check ---
          if (isOnboardingNeeded()) {
            const text =
              msg.message?.conversation ||
              msg.message?.extendedTextMessage?.text ||
              msg.message?.imageMessage?.caption ||
              null;
            if (text) {
              emitLog('onboarding_message', { jid, text: text.slice(0, 200) });
              try {
                const onboardingResult = await handleOnboardingMessage(text, `wa:${jid}`);
                if (onboardingResult.response) {
                  const formatted = formatOutdoorsResponse(onboardingResult.response);
                  const quoteOpts = { quoted: msg };
                  for (let i = 0; i < formatted.length; i += 4000) {
                    const chunk = formatted.slice(i, i + 4000);
                    const sent = await sendWithRetry(jid, { text: chunk }, quoteOpts);
                    if (sent?.key?.id) {
                      botSentIds.add(sent.key.id);
                      storeMessage(sent.key.id, sent.message);
                    }
                  }
                }
                emitLog('onboarding_response', { jid, responseLength: onboardingResult.response?.length || 0 });
                if (onboardingResult.done) {
                  emitLog('onboarding_complete', { jid, message: 'User profile created' });
                  // Send parallel session commands guide
                  const commandsText = `you can run multiple conversations at once:\n\n` +
                    `- start a convo: *1 email my friend about friday*\n` +
                    `- reply to it: *1 tell them I'll be late*\n` +
                    `- start another: *2 research for my econ project*\n` +
                    `- pause one: *1 pause*\n` +
                    `- done with one: *1 new*`;
                  const commandsMsg = formatOutdoorsResponse(commandsText);
                  const cmdSent = await sendWithRetry(jid, { text: commandsMsg });
                  if (cmdSent?.key?.id) {
                    botSentIds.add(cmdSent.key.id);
                    storeMessage(cmdSent.key.id, cmdSent.message);
                  }

                }
              } catch (err) {
                console.log('[onboarding_error] Full:', err);
                emitLog('onboarding_error', { jid, error: err.message });
              }
              return;
            }
          }

          var result = await handleMessage(msg, emitLog);
        } catch (handlerErr) {
          // handleMessage threw unexpectedly — send error to user instead of silently dropping
          if (!handlerErr.stopped) {
            console.error('[WhatsApp] handleMessage threw:', handlerErr);
            emitLog('handler_crash', { jid, error: handlerErr.message });
            try {
              const errorMsg = formatOutdoorsResponse(`Something went wrong processing your message. Please try again.`);
              const sent = await sendWithRetry(jid, { text: errorMsg }, { quoted: msg });
              if (sent?.key?.id) {
                botSentIds.add(sent.key.id);
                storeMessage(sent.key.id, sent.message);
              }
            } catch {}
          }
          return;
        } finally {
          clearInterval(pulseInterval);
          sock.sendMessage(jid, { react: { key: msg.key, text: '' } })
            .then(() => console.log('[react] removed ⏳'))
            .catch(e => console.log('[react] remove failed:', e.message));
          setTimeout(() => processingIds.delete(msgId), 60_000);
        }

        if (!result) {
          console.log(`[wa:no_result] handleMessage returned null for ${msgId} from ${jid}`);
          try {
            const fallback = formatOutdoorsResponse('Something went wrong \u2014 I didn\'t get a response. Try again?');
            const sent = await sendWithRetry(jid, { text: fallback }, { quoted: msg });
            if (sent?.key?.id) { botSentIds.add(sent.key.id); storeMessage(sent.key.id, sent.message); }
          } catch {}
        } else if (result && !result.response) {
          try {
            const fallback = formatOutdoorsResponse('I processed your message but the response was empty. Try again?');
            const sent = await sendWithRetry(result.jid, { text: fallback }, { quoted: msg });
            if (sent?.key?.id) { botSentIds.add(sent.key.id); storeMessage(sent.key.id, sent.message); }
          } catch {}
        }

        if (result && result.response) {
          let sendSucceeded = false;
          try {
            const { images, cleanText } = extractImages(result.response);
            const quoteOpts = { quoted: msg };
            // Send each image first
            for (const imagePath of images) {
              try {
                const imageData = readFileSync(imagePath);
                const imgSent = await sendWithRetry(result.jid, { image: imageData }, quoteOpts);
                if (imgSent?.key?.id) {
                  botSentIds.add(imgSent.key.id);
                  storeMessage(imgSent.key.id, imgSent.message);
                }
              } catch (imgErr) {
                emitLog('send_image_error', { to: result.sender, path: imagePath, error: imgErr.message });
              }
            }
            // Send text in chunks (~4000 chars each) with Outdoors formatting
            if (cleanText) {
              const labeledText = result.conversationNumber != null
                ? `*#${result.conversationNumber}*\n${cleanText}`
                : cleanText;
              const formatted = formatOutdoorsResponse(labeledText);
              for (let i = 0; i < formatted.length; i += 4000) {
                const chunk = formatted.slice(i, i + 4000);
                const sent = await sendWithRetry(result.jid, { text: chunk }, quoteOpts);
                console.log('[wa:send] result:', JSON.stringify(sent?.key));
                if (sent?.key?.id) {
                  botSentIds.add(sent.key.id);
                  storeMessage(sent.key.id, sent.message);
                }
              }
            }
            if (!cleanText && images.length === 0) {
              // Response existed but was empty after processing — notify user
              emitLog('empty_response', { to: result.sender, rawLength: result.response.length });
              const fallback = formatOutdoorsResponse(`I processed your message but had nothing to say. Try rephrasing?`);
              const sent = await sendWithRetry(result.jid, { text: fallback }, quoteOpts);
              if (sent?.key?.id) {
                botSentIds.add(sent.key.id);
                storeMessage(sent.key.id, sent.message);
              }
            }
            sendSucceeded = true;
            emitLog('sent', { to: result.sender, responseLength: result.response.length, imageCount: images.length });
          } catch (err) {
            emitLog('send_error', { to: result.sender, error: err.message });
            // Last-resort: retry raw text without quoting or formatting
            try {
              const sent = await sendWithRetry(result.jid, { text: result.response.slice(0, 4000) });
              if (sent?.key?.id) { botSentIds.add(sent.key.id); storeMessage(sent.key.id, sent.message); }
              sendSucceeded = true;
              emitLog('sent_fallback', { to: result.sender, responseLength: result.response.length });
            } catch (retryErr) {
              emitLog('send_error_final', { to: result.sender, error: retryErr.message });
            }
          }

          // Persist conversation log
          try {
            mkdirSync(LOGS_DIR, { recursive: true });
            const filename = `${nextLogNumber()}_${result.sender}.json`;
            const convoLog = {
              sender: result.sender,
              prompt: result.prompt,
              jid: result.jid,
              conversationNumber: result.conversationNumber ?? null,
              sessionId: result.sessionId || null,
              timestamp: new Date().toISOString(),
              fullEvents: result.fullEvents || [],
              response: result.response,
              sendSucceeded,
              runtimeFingerprint: result.runtimeFingerprint || null,
              runtimeStaleDetected: !!result.runtimeStaleDetected,
              runtimeChangedFiles: result.runtimeChangedFiles || [],
            };
            writeFileSync(join(LOGS_DIR, filename), JSON.stringify(convoLog, null, 2));
            addToLogIndex(filename, convoLog);
            io?.emit('conversation_update', { sessionId: result.sessionId, conversationNumber: result.conversationNumber });
          } catch (e) {
            console.log('[whatsapp:log_write_error]', e.message);
          }
        }
      })().catch(err => console.error('[WhatsApp] Message handler error:', err));
    }
  });

  return sock;
}

function getLastQR() {
  return lastQR;
}

export { startWhatsApp, setSocketIO, getStatus, getLastQR };
