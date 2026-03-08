process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});

// outdoorsv4 bridge adapter — exports the claude-bridge API.
// Routes between fast-path (direct single Claude call) and full pipeline.

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { runModel } from './pipeline/model-runner.js';
import { runPipeline } from './pipeline/orchestrator.js';
import * as registry from './util/process-registry.js';
import * as clarifications from './memory/clarification-manager.js';
import { detectSiteContext } from './memory/memory-manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_ROOT = join(__dirname, '..', 'outdoorsv1', 'backend', 'bot', 'memory');

// Employee definitions — backward compat with outdoorsv1's delegation system
const EMPLOYEES = {
  coder: {
    mode: 'code',
    getArgs: () => config.codeClaudeArgs || config.claudeArgs,
    cwd: config.outputDirectory,
    skipSiteContext: true,
  },
  analyst: {
    mode: 'analyst',
    skillPath: join(MEMORY_ROOT, 'skills', 'data-analyst', 'SKILL.md'),
  },
  marketer: {
    mode: 'marketer',
    skillPath: join(MEMORY_ROOT, 'skills', 'marketing-expert', 'SKILL.md'),
  },
  ceo: {
    mode: 'ceo',
    skillPath: join(MEMORY_ROOT, 'skills', 'ceo-strategist', 'SKILL.md'),
  },
};

// ── Direct execution (single Claude call, no pipeline) ──

async function runDirectExecution(prompt, options) {
  const {
    onProgress,
    processKey,
    resumeSessionId,
    clarificationKey,
    sessionContext,
    _employee,
  } = options;

  // Build system prompt from employee skill + site context
  let systemPrompt = '';
  if (_employee && EMPLOYEES[_employee]?.skillPath) {
    try {
      if (existsSync(EMPLOYEES[_employee].skillPath)) {
        systemPrompt = readFileSync(EMPLOYEES[_employee].skillPath, 'utf-8');
      }
    } catch {}
  }

  if (!options._skipSiteContext) {
    const siteCtx = detectSiteContext(prompt);
    if (siteCtx.length > 0) {
      const siteSection = siteCtx.map(s => `## Site: ${s.name}\n${s.content}`).join('\n\n');
      systemPrompt += (systemPrompt ? '\n\n' : '') + siteSection;
    }
  }

  const cwd = options._cwd || config.outputDirectory;

  let result = await runModel({
    userPrompt: prompt,
    systemPrompt: systemPrompt || undefined,
    model: options._modelOverride || null,
    claudeArgs: options._claudeArgs || config.claudeArgs,
    onProgress,
    processKey,
    timeout: config.messageTimeout,
    cwd,
    resumeSessionId,
  });

  // If resumed session returned empty (stale/invalid session), retry without resume
  if (resumeSessionId && (!result.response || !result.response.trim())) {
    onProgress?.('warning', { message: 'Resumed session returned empty — retrying without resume' });
    result = await runModel({
      userPrompt: prompt,
      systemPrompt: systemPrompt || undefined,
      model: options._modelOverride || null,
      claudeArgs: options._claudeArgs || config.claudeArgs,
      onProgress,
      processKey,
      timeout: config.messageTimeout,
      cwd,
    });
  }

  // Check for delegation marker [DELEGATE:employee] or [DELEGATE:employee:model]
  if (options.detectDelegation && result.response) {
    const delegateMatch = result.response.match(/\[DELEGATE:(\w+)(?::(\w+))?\]/);
    if (delegateMatch) {
      const employee = delegateMatch[1];
      const model = delegateMatch[2] || null;
      if (EMPLOYEES[employee]) {
        return {
          status: 'completed',
          response: result.response,
          sessionId: result.sessionId,
          fullEvents: result.fullEvents,
          delegation: { employee, model },
        };
      }
    }
  }

  // Check for clarification request
  if (result.questionRequest) {
    const key = clarificationKey || processKey;
    if (key) {
      clarifications.setPending(key, {
        originalPrompt: prompt,
        pendingQuestions: result.questionRequest,
        sessionId: result.sessionId,
      });
    }
    return {
      status: 'needs_user_input',
      questions: result.questionRequest,
      sessionId: result.sessionId,
      fullEvents: result.fullEvents,
    };
  }

  return {
    status: 'completed',
    response: result.response,
    sessionId: result.sessionId,
    fullEvents: result.fullEvents,
  };
}

// ── Main API ──

export async function executeClaudePrompt(prompt, options = {}) {
  const { processKey, clarificationKey, onProgress, sessionContext } = options;
  const cKey = clarificationKey || processKey;

  // Check for pending clarification — if the user is answering a previous question
  if (cKey) {
    const pending = clarifications.get(cKey);
    if (pending) {
      clarifications.appendAnswer(cKey, prompt);
      const augmented = clarifications.buildAugmentedPrompt(pending);
      clarifications.clear(cKey);
      // Re-run with the augmented prompt
      return executeClaudePrompt(augmented, {
        ...options,
        resumeSessionId: pending.sessionId,
      });
    }
  }

  // Direct execution path (employee delegation, _directExecution flag)
  if (options._directExecution || options._employee) {
    return runDirectExecution(prompt, options);
  }

  // Default: always run the full pipeline (A → B → C → D → learn)
  const result = await runPipeline(prompt, {
    onProgress,
    processKey,
    timeout: config.messageTimeout,
    resumeSessionId: options.resumeSessionId,
    sessionContext,
  });

  // Handle clarification from pipeline
  if (result.status === 'needs_user_input' && cKey) {
    clarifications.setPending(cKey, {
      originalPrompt: prompt,
      pendingQuestions: result.questions,
      sessionId: result.sessionId,
    });
  }

  return result;
}

export function killProcess(key) {
  return registry.kill(key);
}

export function codeAgentOptions(baseOptions, modelOverride) {
  const emp = EMPLOYEES.coder;
  return {
    ...baseOptions,
    _directExecution: true,
    _employee: 'coder',
    _claudeArgs: emp.getArgs(),
    _cwd: emp.cwd,
    _skipSiteContext: emp.skipSiteContext,
    _modelOverride: modelOverride || null,
  };
}

export function employeeAgentOptions(employeeName, baseOptions, modelOverride) {
  const emp = EMPLOYEES[employeeName];
  if (!emp) return baseOptions;

  return {
    ...baseOptions,
    _directExecution: true,
    _employee: employeeName,
    _modelOverride: modelOverride || null,
  };
}

export function getEmployeeMode(employeeName) {
  return EMPLOYEES[employeeName]?.mode || 'assistant';
}

export function setProcessChangeListener(fn) {
  registry.setChangeListener(fn);
}

export function setProcessActivityListener(fn) {
  registry.setActivityListener(fn);
}

export function getActiveProcessSummary() {
  return registry.getSummary();
}

export function getClarificationState(key) {
  return clarifications.get(key);
}

export function clearClarificationState(key) {
  clarifications.clear(key);
}
