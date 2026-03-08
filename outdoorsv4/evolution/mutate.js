// Genome mutation operators — pure text manipulation, no API calls.

const HEURISTICS = [
  'Always verify your output before presenting it.',
  'Break complex problems into smaller steps before solving.',
  'Consider edge cases explicitly before writing code.',
  'Prefer simple, readable solutions over clever ones.',
  'Start with the hardest part first to de-risk early.',
  'Write tests or checks alongside your implementation.',
  'Think about what could go wrong before proceeding.',
  'Restate the problem in your own words before solving.',
  'Look for existing patterns in the codebase to follow.',
  'Validate assumptions before building on them.',
  'Prefer composition over inheritance.',
  'When stuck, step back and reconsider the approach entirely.',
  'Minimize side effects in your implementations.',
  'Document non-obvious decisions inline.',
  'Consider performance implications of your choices.',
];

function rand(n) {
  return Math.floor(Math.random() * n);
}

function splitBlocks(text) {
  return text.split(/\n\n+/).filter(b => b.trim());
}

function joinBlocks(blocks) {
  return blocks.join('\n\n');
}

// Preserve winner unchanged
export function elite(genome) {
  return genome;
}

// Combine paragraphs from two parents
export function crossover(parent1, parent2) {
  const blocks1 = splitBlocks(parent1);
  const blocks2 = splitBlocks(parent2);
  const maxLen = Math.max(blocks1.length, blocks2.length);
  const result = [];
  for (let i = 0; i < maxLen; i++) {
    const pick = Math.random() < 0.5;
    const block = pick ? (blocks1[i] || blocks2[i]) : (blocks2[i] || blocks1[i]);
    if (block) result.push(block);
  }
  return joinBlocks(result);
}

// Apply random perturbations to a genome
export function mutate(genome, count = 1) {
  let blocks = splitBlocks(genome);

  for (let i = 0; i < count; i++) {
    const op = rand(4);

    switch (op) {
      case 0: // Append a heuristic
        blocks.push(HEURISTICS[rand(HEURISTICS.length)]);
        break;

      case 1: // Swap two random blocks
        if (blocks.length >= 2) {
          const a = rand(blocks.length);
          let b = rand(blocks.length);
          while (b === a) b = rand(blocks.length);
          [blocks[a], blocks[b]] = [blocks[b], blocks[a]];
        }
        break;

      case 2: // Remove a random block (if enough remain)
        if (blocks.length > 3) {
          blocks.splice(rand(blocks.length), 1);
        }
        break;

      case 3: // Reorder numbered steps within a block
        {
          const idx = rand(blocks.length);
          const lines = blocks[idx].split('\n');
          const numbered = lines.filter(l => /^\s*\d+[\.\)]\s/.test(l));
          if (numbered.length >= 2) {
            // Fisher-Yates shuffle
            for (let j = numbered.length - 1; j > 0; j--) {
              const k = rand(j + 1);
              [numbered[j], numbered[k]] = [numbered[k], numbered[j]];
            }
            let ni = 0;
            blocks[idx] = lines.map(l => /^\s*\d+[\.\)]\s/.test(l) ? numbered[ni++] : l).join('\n');
          }
        }
        break;
    }
  }

  return joinBlocks(blocks);
}

// Evolve a population given rankings (indices best-to-worst)
export function evolvePopulation(genomes, rankings, allIdentical = false) {
  const mutationCount = allIdentical ? 2 : 1;
  const next = new Array(genomes.length);
  const winner = genomes[rankings[0]];

  // Elite: preserve winner
  next[rankings[0]] = elite(winner);

  // Others: crossover with winner + mutation, or just mutation of winner
  for (let i = 1; i < rankings.length; i++) {
    const idx = rankings[i];
    if (i === 1 && genomes.length > 2) {
      // Second place: crossover(winner, self) + mutation
      next[idx] = mutate(crossover(winner, genomes[idx]), mutationCount);
    } else {
      // Lower ranks: mutation of winner
      next[idx] = mutate(winner, mutationCount);
    }
  }

  return next;
}
