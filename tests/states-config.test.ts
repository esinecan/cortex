import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const STATES_YAML = fileURLToPath(new URL('../states.yaml', import.meta.url));

const EXPECTED: Record<string, string> = {
  recon: 'superpowers:brainstorming',
  plan: 'superpowers:writing-plans',
  implement: 'superpowers:test-driven-development',
  debug: 'superpowers:systematic-debugging',
  validate: 'superpowers:verification-before-completion',
  review: 'superpowers:requesting-code-review',
};

describe('states.yaml skill suggestions', () => {
  const doc = parse(readFileSync(STATES_YAML, 'utf8'));
  for (const [state, skill] of Object.entries(EXPECTED)) {
    it(`${state} suggests ${skill}`, () => {
      expect(doc[state].skill_suggestions).toContain(skill);
    });
  }
});
