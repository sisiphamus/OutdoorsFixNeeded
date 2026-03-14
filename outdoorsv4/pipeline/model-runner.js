// Spawns a single Claude CLI subprocess with stream-json output parsing.
// Built from scratch using Node's child_process.spawn.

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from '../config.js';
import { register, unregister, emitActivity } from '../util/process-registry.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
// mcp-bot.json lives in outdoorsv4/ — minimal MCP config for bot subprocesses
// (only chrome + playwright). The full .mcp.json has all MCPs for interactive use.
const MCP_CONFIG_PATH = join(__dirname, '..', 'mcp-bot.json');
const EMPTY_MCP_PATH = join(__dirname, '..', 'empty-mcp.json');

const MODEL_MAP = {
  opus: 'claude-opus-4-20250514',
  sonnet: 'claude-sonnet-4-20250514',
  haiku: 'claude-haiku-4-5-20251001',
};

function resolveModel(shorthand) {
  if (!shorthand) return null;
  return MODEL_MAP[shorthand.toLowerCase()] || shorthand;
}

function extractText(message) {
  if (typeof message === 'string') return message;
  if (message && Array.isArray(message.content)) {
    return message.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(message || '');
}

function cleanEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('CLAUDE')) delete env[key];
  }
  return env;
}

export function runModel({
  userPrompt,
  systemPrompt,
  model,
  claudeArgs,
  onProgress,
  processKey,
  timeout,
  cwd,
  resumeSessionId,
  skipMcp,
  skipVerbose,
  allowBrowser = true,
  maxTurns,
}) {
  return new Promise((resolve, reject) => {
    const cmd = config.claudeCommand || 'claude';
    const args = [...(claudeArgs || config.claudeArgs || ['--print']), '--output-format', 'stream-json', '--verbose'];

    if (!args.includes('--max-turns')) {
      args.push('--max-turns', String(maxTurns || 25));
    }

    // MCP config: use --strict-mcp-config to prevent global MCPs (~100K tokens of
    // tool schemas from notion, google_workspace, context7, etc.) from bloating context.
    // Only load browser MCP servers (chrome + playwright) when the task needs them.
    if (!skipMcp && allowBrowser && existsSync(MCP_CONFIG_PATH)) {
      args.push('--mcp-config', MCP_CONFIG_PATH, '--strict-mcp-config');
    } else {
      // No MCP needed — pass an empty config file to block all global MCPs
      args.push('--mcp-config', EMPTY_MCP_PATH, '--strict-mcp-config');
    }

    // Explicitly allow tools — MCP tools aren't fully covered by
    // --dangerously-skip-permissions in --print mode.
    const BASE_TOOLS = 'Bash,Read,Write,Edit,Glob,Grep,WebSearch,WebFetch';
    const BROWSER_TOOLS =
        'mcp__playwright__browser_navigate,mcp__playwright__browser_snapshot,' +
        'mcp__playwright__browser_click,mcp__playwright__browser_type,' +
        'mcp__playwright__browser_press_key,mcp__playwright__browser_tabs,' +
        'mcp__playwright__browser_evaluate,mcp__playwright__browser_close,' +
        'mcp__playwright__browser_take_screenshot,mcp__playwright__browser_wait_for,' +
        'mcp__playwright__browser_fill_form,mcp__playwright__browser_select_option,' +
        'mcp__playwright__browser_hover,mcp__playwright__browser_drag,' +
        'mcp__playwright__browser_handle_dialog,mcp__playwright__browser_file_upload,' +
        'mcp__playwright__browser_navigate_back,mcp__playwright__browser_network_requests,' +
        'mcp__playwright__browser_console_messages,mcp__playwright__browser_resize,' +
        'mcp__playwright__browser_run_code,mcp__playwright__browser_install,' +
        'mcp__chrome__navigate_page,mcp__chrome__take_snapshot,' +
        'mcp__chrome__click,mcp__chrome__type_text,mcp__chrome__fill,' +
        'mcp__chrome__press_key,mcp__chrome__list_pages,mcp__chrome__select_page,' +
        'mcp__chrome__evaluate_script,mcp__chrome__take_screenshot';
    if (!args.includes('--allowedTools')) {
      args.push('--allowedTools', allowBrowser ? `${BASE_TOOLS},${BROWSER_TOOLS}` : BASE_TOOLS);
    }

    // Hard-block built-in tools that waste turns
    args.push('--disallowedTools',
      'ToolSearch,TodoWrite,TodoRead,TaskCreate,TaskStop,TaskGet,TaskList,TaskOutput,TaskUpdate,' +
      'CronCreate,CronDelete,CronList,EnterPlanMode,ExitPlanMode,' +
      'EnterWorktree,ExitWorktree,NotebookEdit,Skill,Agent,' +
      'ListMcpResourcesTool,ReadMcpResourceTool'
    );

    // For large system prompts, prepend instructions into the user prompt via stdin
    // instead of passing as a CLI arg to avoid Windows ENAMETOOLONG errors.
    // Windows limits total command line to ~8191 chars. We check the total args
    // length (not just systemPrompt) to avoid "The command line is too long" errors.
    let stdinPrefix = '';
    if (systemPrompt) {
      const currentArgsLen = args.reduce((sum, a) => sum + a.length + 1, cmd.length);
      if (currentArgsLen + systemPrompt.length > 7000) {
        stdinPrefix = `[SYSTEM INSTRUCTIONS — follow these carefully]\n${systemPrompt}\n[END SYSTEM INSTRUCTIONS]\n\n`;
      } else {
        args.push('--append-system-prompt', systemPrompt);
      }
    }

    const resolvedModel = resolveModel(model);
    if (resolvedModel) {
      args.push('--model', resolvedModel);
    }

    if (resumeSessionId) {
      args.push('--resume', resumeSessionId);
    }

    // On Windows, shell: true is needed so spawn resolves .cmd wrappers (e.g. claude.cmd).
    // Large system prompts are already routed through stdin (stdinPrefix) to avoid arg-length limits.
    const proc = spawn(cmd, args, {
      cwd: cwd || config.workingDirectory || process.cwd(),
      env: cleanEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    proc.stdin.on('error', (e) => { /* pipe closed — ignore */ });
    proc.stdout.on('error', (e) => { /* pipe closed — ignore */ });
    proc.stderr.on('error', (e) => { /* pipe closed — ignore */ });

    if (processKey) {
      register(processKey, proc, model || 'claude');
    }

    let response = '';
    let sessionId = null;
    const fullEvents = [];
    let buffer = '';
    let killedForQuestion = false; // true when we kill the process to pause for AskUserQuestion
    let killedAfterResult = false; // true after first result — kills process tree to stop background tasks from wasting API calls

    // Inactivity watchdog — if the subprocess produces no stdout for 5 minutes, kill it.
    // Resets on each data event, so long-running tasks that stream output are fine.
    let lastActivity = Date.now();
    const INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > INACTIVITY_TIMEOUT_MS) {
        clearInterval(watchdog);
        onProgress?.('stderr', { text: `[model-runner] Killing subprocess — no output for ${INACTIVITY_TIMEOUT_MS / 1000}s` });
        try {
          if (process.platform === 'win32') {
            const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
            spawn(taskkill, ['/T', '/F', '/PID', String(proc.pid)], { shell: false, stdio: 'ignore', detached: true });
          } else {
            process.kill(-proc.pid, 'SIGTERM');
          }
        } catch {}
      }
    }, 30_000);

    // Write prompt to stdin and close
    if (stdinPrefix) {
      proc.stdin.write(stdinPrefix);
    }
    if (userPrompt) {
      proc.stdin.write(userPrompt);
    }
    proc.stdin.end();

    proc.stdout.on('data', (chunk) => {
      lastActivity = Date.now();
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event;
        try { event = JSON.parse(trimmed); } catch { continue; }
        fullEvents.push(event);

        switch (event.type) {
          case 'system':
            if (event.session_id) sessionId = event.session_id;
            break;

          case 'assistant':
            if (event.subtype === 'tool_use') {
              // Legacy format: subtype at top level
              onProgress?.('tool_use', {
                tool: event.tool_name,
                input: event.input,
              });
              emitActivity(processKey, 'tool_use', event.tool_name);

              if (event.tool_name === 'AskUserQuestion') {
                fullEvents._questionRequest = event.input;
                // Kill immediately so Claude doesn't auto-resolve and keep building in --print mode
                killedForQuestion = true;
                proc.kill();
              }
            } else if (event.message) {
              const content = Array.isArray(event.message.content) ? event.message.content : [];

              // Extract tool_use blocks from message.content
              for (const block of content) {
                if (block.type === 'tool_use') {
                  const toolInput = typeof block.input === 'string'
                    ? (() => { try { return JSON.parse(block.input); } catch { return block.input; } })()
                    : block.input;
                  onProgress?.('tool_use', {
                    tool: block.name,
                    input: toolInput,
                  });
                  emitActivity(processKey, 'tool_use', block.name);

                  if (block.name === 'AskUserQuestion') {
                    fullEvents._questionRequest = toolInput;
                    killedForQuestion = true;
                    proc.kill();
                  }
                }
              }


            }
            break;

          case 'user':
            if (event.subtype === 'tool_result') {
              // Legacy format: subtype at top level
              onProgress?.('tool_result', {
                tool: event.tool_name,
                output: event.output,
              });
            } else if (event.message) {
              // Current format: tool_result inside message.content
              const content = Array.isArray(event.message.content) ? event.message.content : [];
              for (const block of content) {
                if (block.type === 'tool_result') {
                  onProgress?.('tool_result', {
                    tool: block.tool_use_id,
                    output: block.content || block.output || '',
                  });
                }
              }
            }
            break;

          case 'result': {
            const resultText = event.result ? (typeof event.result === 'string' ? event.result : extractText(event.result)) : null;
            if (resultText && !killedAfterResult) {
              response = resultText;
              // Always emit the final result as assistant_text (even if streamed earlier, this is the canonical output)
              onProgress?.('assistant_text', { text: resultText });
            }
            if (!killedAfterResult && event.session_id) sessionId = event.session_id;
            if (event.duration_ms !== undefined || event.total_cost_usd !== undefined) {
              onProgress?.('cost', {
                cost: event.total_cost_usd,
                duration: event.duration_ms,
                input_tokens: event.usage?.input_tokens,
                output_tokens: event.usage?.output_tokens,
                cache_read: event.usage?.cache_read_input_tokens,
              });
            }
            // After the first result, kill the process tree to prevent background
            // tasks (e.g. HTTP servers started with run_in_background) from
            // triggering additional model turns that waste API credits.
            if (!killedAfterResult && !killedForQuestion) {
              killedAfterResult = true;
              setTimeout(() => {
                try {
                  if (process.platform === 'win32') {
                    const taskkill = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`;
                    spawn(taskkill, ['/T', '/F', '/PID', String(proc.pid)], {
                      shell: false,
                      stdio: 'ignore',
                      detached: true,
                    });
                  } else {
                    process.kill(-proc.pid, 'SIGTERM');
                  }
                } catch {}
              }, 500);
            }
            break;
          }
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) onProgress?.('stderr', { text, model: model || 'default' });
    });

    proc.on('close', (code) => {
      clearInterval(watchdog);
      if (processKey) unregister(processKey);

      // Process any remaining buffer
      if (buffer.trim()) {
        try {
          const event = JSON.parse(buffer.trim());
          fullEvents.push(event);
          if (event.type === 'result' && event.result) response = event.result;
          if (event.session_id) sessionId = event.session_id;
        } catch {}
      }

      if (proc._stoppedByUser) {
        reject({ stopped: true, message: 'Process stopped by user' });
        return;
      }

      resolve({
        response,
        sessionId,
        fullEvents,
        questionRequest: fullEvents._questionRequest || null,
      });
    });

    proc.on('error', (err) => {
      if (processKey) unregister(processKey);
      reject(err);
    });
  });
}
