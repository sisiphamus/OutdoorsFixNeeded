// Outdoors Web Dashboard
const socket = io();
let currentSessionId = null;
let currentMessageId = null;
let setupStep = 1;
const windowId = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2);

// ── Initialization ──
document.addEventListener('DOMContentLoaded', async () => {
  // Check if first run (no config or no Claude CLI)
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    if (cfg._setupDone || localStorage.getItem('outdoors_setup_done')) {
      showDashboard();
    } else {
      showSetup();
    }
  } catch {
    showDashboard(); // If API fails, show dashboard anyway
  }

  // Enable/disable send button based on input
  const input = document.getElementById('chat-input');
  input.addEventListener('input', () => {
    document.getElementById('send-btn').disabled = !input.value.trim();
  });
});

// ── Socket.IO Event Handlers ──
socket.on('connect', () => {
  updateIndicator('ind-server', 'green', 'Server');
});

socket.on('disconnect', () => {
  updateIndicator('ind-server', 'red', 'Server (offline)');
});

socket.on('status', (status) => {
  if (status === 'connected' || status === 'ready') {
    updateIndicator('ind-whatsapp', 'green', 'WhatsApp');
  } else if (status === 'waiting_for_qr') {
    updateIndicator('ind-whatsapp', 'yellow', 'WhatsApp (scan QR)');
  } else {
    updateIndicator('ind-whatsapp', 'gray', 'WhatsApp');
  }
});

socket.on('qr', (dataUrl) => {
  const qrDiv = document.getElementById('whatsapp-qr');
  if (qrDiv) {
    qrDiv.innerHTML = `<img src="${dataUrl}" alt="WhatsApp QR" style="width:200px;border-radius:8px;">`;
  }
});

socket.on('chat_response', (data) => {
  hideProgress();
  if (typeof data === 'string') {
    addMessage('assistant', data);
  } else {
    addMessage('assistant', data.response, data.sessionId);
    if (data.sessionId) currentSessionId = data.sessionId;
  }
});

socket.on('chat_progress', (data) => {
  showProgress(data);
});

socket.on('chat_error', (data) => {
  hideProgress();
  addMessage('assistant', `Error: ${data.error || 'Unknown error'}`);
});

socket.on('chat_questions', (data) => {
  hideProgress();
  const questions = data.questions?.questions || [];
  if (questions.length === 0) {
    addMessage('assistant', 'I need more details. Please provide additional context.');
    return;
  }
  let text = 'I need a few details:\n\n';
  questions.forEach((q, i) => {
    text += `${i + 1}. ${q.question || 'Please clarify'}\n`;
    if (q.options && q.options.length) {
      q.options.forEach(opt => {
        text += `   • ${opt.label}: ${opt.description || ''}\n`;
      });
    }
    text += '\n';
  });
  text += 'Reply with your answer(s) to continue.';
  addMessage('assistant', text);
});

socket.on('process_status', (processes) => {
  const container = document.getElementById('active-processes');
  if (!processes || Object.keys(processes).length === 0) {
    container.innerHTML = '<span style="color:var(--text-muted)">None</span>';
    return;
  }
  container.innerHTML = Object.entries(processes).map(([key, info]) => {
    return `<div class="indicator"><span class="dot dot-yellow"></span> ${key.split(':').pop()}</div>`;
  }).join('');
});

socket.on('log', (entry) => {
});

// ── Chat Functions ──
function sendMessage() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  // Hide welcome message
  const welcome = document.querySelector('.welcome-msg');
  if (welcome) welcome.remove();

  addMessage('user', text);
  input.value = '';
  input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;

  showProgress({ type: 'processing', data: {} });
  currentMessageId = Math.random().toString(36).slice(2);

  socket.emit('web_message', {
    text,
    sessionId: currentSessionId,
    windowId,
  });
}

function sendSuggestion(btn) {
  document.getElementById('chat-input').value = btn.textContent;
  sendMessage();
}

function newChat() {
  currentSessionId = null;
  socket.emit('web_message', { text: '/new', windowId });
  const msgs = document.getElementById('chat-messages');
  msgs.innerHTML = `
    <div class="welcome-msg">
      <div class="welcome-logo">🌶️</div>
      <h2>Outdoors</h2>
      <p>Your AI assistant. Send a message to get started.</p>
      <div class="suggestions">
        <button class="suggestion" onclick="sendSuggestion(this)">What can you do?</button>
        <button class="suggestion" onclick="sendSuggestion(this)">Check my calendar today</button>
        <button class="suggestion" onclick="sendSuggestion(this)">What tasks do I have?</button>
      </div>
    </div>
  `;
}

function addMessage(role, text, sessionId) {
  const container = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = `msg msg-${role}`;

  // Simple markdown-like rendering for assistant messages
  let rendered = escapeHtml(text);
  if (role === 'assistant') {
    // Code blocks
    rendered = rendered.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
    // Inline code
    rendered = rendered.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    rendered = rendered.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Links
    rendered = rendered.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  }

  const now = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `
    <div class="msg-bubble">${rendered}</div>
    <div class="msg-meta">${now}</div>
  `;

  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showProgress(data) {
  const bar = document.getElementById('progress-bar');
  const text = document.getElementById('progress-text');
  bar.classList.remove('hidden');

  if (data.type === 'tool_use') {
    const toolName = data.data?.tool || 'tool';
    text.textContent = `Using ${toolName}...`;
  } else if (data.type === 'assistant_text') {
    text.textContent = 'Generating response...';
  } else if (data.type === 'delegation') {
    text.textContent = `Delegating to ${data.data?.employee || 'specialist'}...`;
  } else if (data.type === 'cost') {
    text.textContent = `Complete ($${(data.data?.cost || 0).toFixed(4)})`;
    setTimeout(hideProgress, 3000);
  } else {
    text.textContent = 'Processing...';
  }
}

function hideProgress() {
  document.getElementById('progress-bar').classList.add('hidden');
}

function handleInputKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function updateIndicator(id, color, label) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = `<span class="dot dot-${color}"></span> ${label}`;
}

// ── Setup Wizard ──
function showSetup() {
  document.getElementById('setup-wizard').classList.remove('hidden');
  document.getElementById('dashboard').style.display = 'none';
  checkClaudeCli();
}

function showDashboard() {
  document.getElementById('setup-wizard').classList.add('hidden');
  document.getElementById('dashboard').style.display = 'flex';
  document.getElementById('chat-input').focus();
}

async function checkClaudeCli() {
  try {
    const res = await fetch('/api/health/claude');
    const data = await res.json();
    if (data.ok) {
      document.getElementById('claude-status').classList.add('hidden');
      document.getElementById('claude-ok').classList.remove('hidden');
    } else if (data.error === 'not_found') {
      document.getElementById('claude-status').classList.add('hidden');
      document.getElementById('claude-fix').classList.remove('hidden');
    } else if (data.error === 'not_authenticated') {
      document.getElementById('claude-status').classList.add('hidden');
      document.getElementById('claude-auth').classList.remove('hidden');
    }
  } catch {
    // API endpoint might not exist yet, just show OK
    document.getElementById('claude-status').classList.add('hidden');
    document.getElementById('claude-ok').classList.remove('hidden');
  }
}

function nextStep() {
  document.getElementById(`step-${setupStep}`).classList.remove('active');
  setupStep = Math.min(setupStep + 1, 3);
  document.getElementById(`step-${setupStep}`).classList.add('active');
  document.getElementById('btn-prev').classList.toggle('hidden', setupStep === 1);
  document.getElementById('btn-next').classList.toggle('hidden', setupStep === 3);
}

function prevStep() {
  document.getElementById(`step-${setupStep}`).classList.remove('active');
  setupStep = Math.max(setupStep - 1, 1);
  document.getElementById(`step-${setupStep}`).classList.add('active');
  document.getElementById('btn-prev').classList.toggle('hidden', setupStep === 1);
  document.getElementById('btn-next').classList.toggle('hidden', setupStep === 3);
}

function finishSetup() {
  localStorage.setItem('outdoors_setup_done', '1');
  showDashboard();
}

// ── Settings Modal ──
async function showSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  try {
    const res = await fetch('/api/config');
    const cfg = await res.json();
    document.getElementById('settings-rate-limit').value = cfg.rateLimitPerMinute || 10;
    document.getElementById('settings-max-response').value = cfg.maxResponseLength || 4000;
  } catch {}
}

function hideSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
}

async function saveSettings() {
  const rateLimit = parseInt(document.getElementById('settings-rate-limit').value) || 10;
  const maxResponse = parseInt(document.getElementById('settings-max-response').value) || 4000;

  const body = {
    rateLimitPerMinute: rateLimit,
    maxResponseLength: maxResponse,
  };

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    hideSettings();
  } catch (err) {
    alert('Failed to save settings: ' + err.message);
  }
}
