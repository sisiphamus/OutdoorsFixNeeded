#!/usr/bin/env node

/**
 * Outdoors Setup Script
 *
 * Autonomously configures everything needed to run Outdoors:
 * - .claude.json with MCP servers (Google Workspace, Playwright, Context7, Notion)
 * - outdoorsv1/backend/config.json from template
 * - npm + pip dependencies
 *
 * Usage: node setup.js
 */

const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const ROOT = __dirname;
const BACKEND = path.join(ROOT, 'outdoorsv1', 'backend');


const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise(resolve => rl.question(q, resolve));

function log(msg) { console.log(`\n  ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function warn(msg) { console.log(`  ! ${msg}`); }
function fail(msg) { console.log(`  ✗ ${msg}`); }

function commandExists(cmd) {
  try {
    execSync(`${cmd} --version`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function getCommandOutput(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

// ── Step 1: Check prerequisites ──────────────────────────────────────────────

async function checkPrerequisites() {
  log('Checking prerequisites...');
  let allGood = true;

  // Node.js — already running
  ok(`Node.js ${process.version}`);

  // Python
  const py = getCommandOutput('python3 --version') || getCommandOutput('python --version');
  if (py) {
    ok(py);
  } else {
    fail('Python not found. Install Python 3.9+ from https://python.org');
    allGood = false;
  }

  // uv or pip (for workspace-mcp)
  const hasUv = commandExists('uv') || commandExists('uvx');
  const hasPip = commandExists('pip') || commandExists('pip3');
  if (hasUv) {
    ok('uv (Python package manager)');
  } else if (hasPip) {
    warn('uv not found, installing via pip...');
    try {
      execSync('pip install uv', { stdio: 'pipe' });
      ok('Installed uv');
    } catch {
      try {
        execSync('pip3 install uv', { stdio: 'pipe' });
        ok('Installed uv');
      } catch {
        fail('Could not install uv. Install manually: pip install uv');
        allGood = false;
      }
    }
  } else {
    fail('Neither uv nor pip found. Install Python with pip.');
    allGood = false;
  }

  // Claude CLI
  const claude = getCommandOutput('claude --version');
  if (claude) {
    ok(`Claude CLI ${claude}`);
  } else {
    fail('Claude CLI not found. Install from: https://docs.anthropic.com/en/docs/claude-code/overview');
    allGood = false;
  }

  // npm
  const npm = getCommandOutput('npm --version');
  if (npm) {
    ok(`npm ${npm}`);
  } else {
    fail('npm not found. Should come with Node.js.');
    allGood = false;
  }

  return allGood;
}

// ── Step 2: Write .claude.json ───────────────────────────────────────────────

function writeClaudeConfig() {
  log('Configuring MCP servers...');

  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || DEFAULT_OAUTH.clientId;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || DEFAULT_OAUTH.clientSecret;

  // Detect uvx path — prefer system uvx, fall back to full path
  let uvxCommand = 'uvx';
  const uvxPath = getCommandOutput(process.platform === 'win32' ? 'where uvx' : 'which uvx');
  if (uvxPath) {
    // Use the first line if `where` returns multiple paths
    uvxCommand = uvxPath.split('\n')[0].trim();
  }

  const config = {
    mcpServers: {
      google_workspace: {
        type: 'stdio',
        command: uvxCommand,
        args: ['workspace-mcp'],
        env: {
          GOOGLE_OAUTH_CLIENT_ID: clientId,
          GOOGLE_OAUTH_CLIENT_SECRET: clientSecret
        }
      },
      playwright: {
        command: 'npx',
        args: [
          '@playwright/mcp@latest',
          '--cdp-endpoint', 'http://localhost:9222'
        ]
      },
      context7: {
        command: 'npx',
        args: ['-y', '@upstash/context7-mcp@latest']
      },
      notion: {
        command: 'npx',
        args: ['-y', '@notionhq/notion-mcp-server']
      }
    }
  };

  const configPath = path.join(ROOT, '.claude.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  ok(`Wrote ${configPath}`);
}

// ── Step 3: Write backend config.json ────────────────────────────────────────

async function writeBackendConfig() {
  const configPath = path.join(BACKEND, 'config.json');

  if (fs.existsSync(configPath)) {
    ok('outdoorsv1/backend/config.json already exists, skipping');
    return;
  }

  log('Configuring backend...');

  const phone = await ask('  Your phone number (digits only, e.g. 18031234567): ');

  const config = {
    port: 3457,
    allowedNumbers: [phone.replace(/\D/g, '')],
    allowAllNumbers: false,
    claudeCommand: 'claude',
    claudeArgs: ['--print', '--dangerously-skip-permissions'],
    maxResponseLength: 4000,
    messageTimeout: 120000,
    rateLimitPerMinute: 10,
    workingDirectory: ROOT.replace(/\//g, '\\\\'),
    codeWorkingDirectory: ROOT.replace(/\//g, '\\\\'),
    prefix: '!claude '
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  ok(`Wrote ${configPath}`);
}

// ── Step 4: Install dependencies ─────────────────────────────────────────────

function installDependencies() {
  log('Installing dependencies...');

  // npm
  try {
    execSync('npm install', { cwd: BACKEND, stdio: 'inherit' });
    ok('npm packages installed');
  } catch (e) {
    fail('npm install failed — run manually: cd outdoorsv1/backend && npm install');
  }

  // Python ML dependencies
  try {
    execSync('pip install scikit-learn joblib numpy', { stdio: 'inherit' });
    ok('Python ML packages installed');
  } catch {
    try {
      execSync('pip3 install scikit-learn joblib numpy', { stdio: 'inherit' });
      ok('Python ML packages installed');
    } catch {
      warn('pip install failed — run manually: pip install scikit-learn joblib numpy');
    }
  }

  // Pre-cache workspace-mcp
  try {
    execSync('uvx workspace-mcp --help', { stdio: 'pipe', timeout: 30000 });
    ok('workspace-mcp cached');
  } catch {
    // May fail if --help isn't supported, but uvx will have cached it
    ok('workspace-mcp downloaded');
  }
}

// ── Step 5: Update .gitignore ────────────────────────────────────────────────

function updateGitignore() {
  const gitignorePath = path.join(ROOT, '.gitignore');
  if (!fs.existsSync(gitignorePath)) return;

  const content = fs.readFileSync(gitignorePath, 'utf-8');
  if (!content.includes('.claude.json')) {
    fs.appendFileSync(gitignorePath, '\n# Claude MCP config (contains OAuth secrets)\n.claude.json\n');
    ok('Added .claude.json to .gitignore');
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n  ╔══════════════════════════════════╗');
  console.log('  ║       Outdoors Setup              ║');
  console.log('  ╚══════════════════════════════════╝');

  const prereqsOk = await checkPrerequisites();
  if (!prereqsOk) {
    log('Fix the issues above, then re-run: node setup.js\n');
    rl.close();
    process.exit(1);
  }

  writeClaudeConfig();
  await writeBackendConfig();
  updateGitignore();
  installDependencies();

  console.log('\n  ╔══════════════════════════════════╗');
  console.log('  ║       Setup complete!             ║');
  console.log('  ╚══════════════════════════════════╝');
  log('To start Outdoors:');
  log('  cd outdoorsv1/backend && node server.js');
  log('');
  log('First time using Gmail/Calendar/Drive:');
  log('  Claude will show a Google login URL.');
  log('  Click it → sign in → click "Allow" → done.\n');

  rl.close();
}

main().catch(err => {
  console.error('Setup failed:', err.message);
  rl.close();
  process.exit(1);
});
