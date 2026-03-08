#!/usr/bin/env node
// Agent evolution CLI — run N Outdoors pipelines with different genomes, rank, breed.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';
import { createInterface } from 'readline';
import { runPipeline } from '../pipeline/orchestrator.js';
import { evolvePopulation } from './mutate.js';

const GENOMES_DIR = join(import.meta.dirname, '../../outdoorsv1/backend/bot/memory/evolution/genomes');
const CURRENT_DIR = join(GENOMES_DIR, 'current');
const HISTORY_DIR = join(GENOMES_DIR, 'history');
const RESULTS_FILE = join(import.meta.dirname, '../../outdoorsv1/backend/bot/memory/evolution/results.jsonl');

const ARCHETYPES = [
  {
    name: 'agent-0',
    content: `# Methodical Engineer

You are a methodical, thorough software engineer. You:
- Plan before coding — outline the approach, identify edge cases, then implement
- Write clean, well-structured code with clear variable names
- Test your work mentally before presenting it
- Prefer correctness over speed
- Always consider error handling and boundary conditions

When given a task, first restate the requirements, then design the solution, then implement it step by step.`,
  },
  {
    name: 'agent-1',
    content: `# Fast Prototyper

You are a rapid prototyper who ships fast. You:
- Jump straight to implementation — working code beats perfect plans
- Use the simplest approach that solves the problem
- Iterate quickly — get something working, then refine
- Prefer concise code over verbose code
- Skip unnecessary abstractions

When given a task, immediately start coding the most direct solution.`,
  },
  {
    name: 'agent-2',
    content: `# Deep Thinker

You are a deep, analytical problem solver. You:
- Think carefully about the problem space before writing any code
- Consider multiple approaches and pick the best one
- Optimize for long-term maintainability and performance
- Use well-known algorithms and design patterns where appropriate
- Reason about time and space complexity

When given a task, analyze the problem deeply, consider trade-offs between approaches, then implement the optimal solution.`,
  },
];

function askQuestion(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function getGeneration() {
  if (!existsSync(HISTORY_DIR)) return 0;
  const dirs = readdirSync(HISTORY_DIR).filter(d => d.startsWith('gen-'));
  return dirs.length;
}

function loadGenomes() {
  const files = readdirSync(CURRENT_DIR).filter(f => f.endsWith('.md')).sort();
  return files.map(f => ({
    name: f.replace('.md', ''),
    content: readFileSync(join(CURRENT_DIR, f), 'utf-8'),
  }));
}

function saveGenomes(genomes) {
  for (const g of genomes) {
    writeFileSync(join(CURRENT_DIR, `${g.name}.md`), g.content);
  }
}

function archiveGeneration(gen) {
  const dir = join(HISTORY_DIR, `gen-${String(gen).padStart(3, '0')}`);
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(CURRENT_DIR).filter(f => f.endsWith('.md'));
  for (const f of files) {
    copyFileSync(join(CURRENT_DIR, f), join(dir, f));
  }
}

// ── Init command ──
async function init(poolSize) {
  mkdirSync(CURRENT_DIR, { recursive: true });
  mkdirSync(HISTORY_DIR, { recursive: true });

  const archetypes = ARCHETYPES.slice(0, poolSize);
  // If poolSize > archetypes, duplicate last with mutations
  while (archetypes.length < poolSize) {
    const base = ARCHETYPES[archetypes.length % ARCHETYPES.length];
    archetypes.push({
      name: `agent-${archetypes.length}`,
      content: base.content + `\n\nVariant ${archetypes.length}: Add your own twist to this approach.`,
    });
  }

  for (const a of archetypes) {
    writeFileSync(join(CURRENT_DIR, `${a.name}.md`), a.content);
  }

  console.log(`\nInitialized ${poolSize} genomes in ${CURRENT_DIR}/`);
  archetypes.forEach(a => console.log(`  ${a.name}: "${a.content.split('\n')[0].replace(/^#\s*/, '')}"`));
}

// ── Run command ──
async function run(poolSize, task, maxCost) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let currentTask = task;

  while (currentTask) {
  // Load genomes fresh each iteration (they evolve between rounds)
  let genomes = loadGenomes();
  if (genomes.length === 0) {
    console.log('No genomes found. Running --init first...');
    await init(poolSize);
    genomes = loadGenomes();
  }
  if (genomes.length !== poolSize) {
    console.log(`Warning: found ${genomes.length} genomes but pool is ${poolSize}. Using ${genomes.length}.`);
    poolSize = genomes.length;
  }

  const gen = getGeneration();
  console.log(`\n[1/4] Loading genomes from ${CURRENT_DIR}/`);
  genomes.forEach(g => console.log(`  ${g.name}: "${g.content.split('\n')[0].replace(/^#\s*/, '')}"`));

  // Archive current generation before evolving
  archiveGeneration(gen);

  // Run pipelines in parallel
  console.log(`\n[2/4] Running ${poolSize} Outdoors pipelines in parallel...`);
  const startTime = Date.now();

  const promises = genomes.map((g, i) => {
    const agentStart = Date.now();
    return runPipeline(task, {
      onProgress: (type, data) => {
        if (type === 'pipeline_phase') {
          process.stdout.write(`\r  ${g.name}: ${data.description || data.phase}                    `);
        }
      },
      processKey: `evo:gen-${gen}:agent-${i}`,
      genomeOverride: g.content,
      skipLearning: true,
    }).then(result => ({
      ...result,
      elapsed: ((Date.now() - agentStart) / 1000).toFixed(1),
      name: g.name,
    })).catch(err => ({
      status: 'error',
      response: `Error: ${err.message}`,
      elapsed: ((Date.now() - agentStart) / 1000).toFixed(1),
      name: g.name,
    }));
  });

  const results = await Promise.all(promises);
  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(`\n\n  All done in ${totalTime}s\n`);

  // Display outputs
  console.log('[3/4] Outputs:\n');
  const PREVIEW_LINES = 80;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const lines = (r.response || '(empty)').split('\n');
    const preview = lines.slice(0, PREVIEW_LINES).join('\n');
    const truncated = lines.length > PREVIEW_LINES ? `\n... (${lines.length - PREVIEW_LINES} more lines)` : '';
    console.log(`===== ${r.name.toUpperCase()} (${r.elapsed}s) =====`);
    console.log(preview + truncated);
    console.log();
  }

  // Check for all-identical outputs
  const uniqueOutputs = new Set(results.map(r => (r.response || '').trim()));
  const allIdentical = uniqueOutputs.size === 1;
  if (allIdentical) {
    console.log('WARNING: All outputs are identical. Increasing mutation rate.\n');
  }

  // Auto-rank failures last
  const failedIndices = new Set();
  results.forEach((r, i) => {
    if (r.status === 'error' || r.status === 'needs_user_input' || !r.response?.trim()) {
      failedIndices.add(i);
    }
  });

  // Prompt for ranking
  const validIndices = results.map((_, i) => i);

  let rankings;
  if (failedIndices.size === results.length) {
    console.log('All agents failed. Using original order.');
    rankings = validIndices;
  } else {
    const nonFailed = validIndices.filter(i => !failedIndices.has(i));
    if (nonFailed.length === 1) {
      console.log(`Only agent ${nonFailed[0]} succeeded. Auto-ranking.`);
      rankings = [...nonFailed, ...validIndices.filter(i => failedIndices.has(i))];
    } else {
      const answer = await askQuestion(
        rl,
        `Rank best to worst (e.g. "${nonFailed.join(' ')}"): `
      );
      const parsed = answer.trim().split(/\s+/).map(Number);
      if (parsed.length !== nonFailed.length || parsed.some(n => isNaN(n) || !nonFailed.includes(n))) {
        console.log('Invalid ranking. Using order as given with failures last.');
        rankings = [...nonFailed, ...validIndices.filter(i => failedIndices.has(i))];
      } else {
        rankings = [...parsed, ...validIndices.filter(i => failedIndices.has(i))];
      }
    }
  }
  // Evolve
  console.log('\n[4/4] Evolving...');
  const genomeContents = genomes.map(g => g.content);
  const nextContents = evolvePopulation(genomeContents, rankings, allIdentical);

  const nextGenomes = genomes.map((g, i) => ({ name: g.name, content: nextContents[i] }));

  // Describe what happened to each
  for (let ri = 0; ri < rankings.length; ri++) {
    const idx = rankings[ri];
    if (ri === 0) {
      console.log(`  ${genomes[idx].name}: preserved (elite)`);
    } else if (ri === 1 && genomes.length > 2) {
      console.log(`  ${genomes[idx].name}: crossover(${rankings[0]},${idx}) + mutation`);
    } else {
      console.log(`  ${genomes[idx].name}: mutation(${rankings[0]})`);
    }
  }

  saveGenomes(nextGenomes);
  console.log(`  Saved to genomes/history/gen-${String(gen).padStart(3, '0')}/`);

  // Log results
  const entry = {
    gen,
    task,
    rankings,
    agents: results.map(r => ({ name: r.name, elapsed: r.elapsed, status: r.status })),
    winner: genomes[rankings[0]].name,
    allIdentical,
    timestamp: new Date().toISOString(),
  };
  appendFileSync(RESULTS_FILE, JSON.stringify(entry) + '\n');
  console.log(`  Logged to results.jsonl`);

  console.log('\nDone. Enter a new task to continue evolving, or press Enter to quit.\n');
  const nextTask = await askQuestion(rl, 'Next task: ');
  currentTask = nextTask.trim() || null;

  } // end while

  rl.close();
  console.log('Goodbye.');
}

// ── CLI ──
const args = process.argv.slice(2);
const flags = {};
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].replace(/^--/, '');
    flags[key] = args[i + 1] || true;
    i++;
  }
}

if (flags.init) {
  await init(parseInt(flags.init) || 3);
} else if (flags.task) {
  const pool = parseInt(flags.pool) || 3;
  const maxCost = flags['max-cost'] ? parseFloat(flags['max-cost']) : Infinity;
  await run(pool, flags.task, maxCost);
} else {
  console.log(`Usage:
  node evolve.js --init 3              Create 3 initial genomes
  node evolve.js --pool 3 --task "..." Run one generation

Options:
  --init N       Initialize N archetype genomes
  --pool N       Number of agents to run (default: 3)
  --task "..."   The task prompt for this generation
  --max-cost N   Abort if estimated cost exceeds N dollars`);
}
