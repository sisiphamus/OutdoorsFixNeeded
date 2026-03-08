import { readFileSync, writeFileSync, renameSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(__dirname, '..', 'config.json');

const defaults = {
  port: 3457,
  allowedNumbers: [],
  allowAllNumbers: false,
  claudeCommand: 'claude',
  claudeArgs: ['--print'],
  maxResponseLength: 4000,
  messageTimeout: 120000,
  rateLimitPerMinute: 10,
  workingDirectory: process.cwd(),
  codeClaudeArgs: ['--print'],
  codeWorkingDirectory: process.cwd(),
  prefix: '!claude ',
  authDir: join(__dirname, '..', 'auth_state'),
  outdoorsGroupJid: '',
};

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try {
      const file = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
      return { ...defaults, ...file };
    } catch {
      return { ...defaults };
    }
  }
  return { ...defaults };
}

function saveConfig(config) {
  const toSave = { ...config };
  delete toSave.authDir;
  const tmpPath = CONFIG_PATH + `.tmp.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmpPath, JSON.stringify(toSave, null, 2));
  renameSync(tmpPath, CONFIG_PATH);
}

const config = loadConfig();

export { config, saveConfig, loadConfig };
