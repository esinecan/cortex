/**
 * Loads pathway definitions from pathways.yaml and provides query functions.
 * Pathways are named workflow sequences (golden, investigation, etc.)
 * with per-state guidance steps that the agent can follow.
 * @module
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { PathwayDefinition } from './types.js';

let pathwayDefinitions: Record<string, PathwayDefinition> = {};

/** Load pathway definitions from a YAML file. Called once at startup. */
export function loadPathways(configPath: string): void {
  const raw = readFileSync(configPath, 'utf-8');
  pathwayDefinitions = parseYaml(raw) as Record<string, PathwayDefinition>;
}

export function getPathwayNames(): string[] {
  return Object.keys(pathwayDefinitions);
}

export function getPathway(name: string): PathwayDefinition | null {
  return pathwayDefinitions[name] || null;
}

/**
 * Get guidance steps for a specific state within a pathway.
 * For leveled states, returns level-specific guidance if available.
 */
export function getGuidance(
  pathwayName: string,
  stateName: string,
  level?: number,
): string[] | null {
  const pathway = pathwayDefinitions[pathwayName];
  if (!pathway) return null;

  const stateGuidance = pathway.guidance[stateName];
  if (!stateGuidance) return null;

  // Flat guidance (array of strings)
  if (Array.isArray(stateGuidance)) {
    return stateGuidance;
  }

  // Leveled guidance (object with l1, l2, l3 keys)
  const levelKey = `l${level || 1}`;
  const levelGuidance = (stateGuidance as Record<string, string[]>)[levelKey];
  return levelGuidance || null;
}

/**
 * Get the next state suggested by the pathway after the current one.
 */
export function getNextState(pathwayName: string, currentState: string): string | null {
  const pathway = pathwayDefinitions[pathwayName];
  if (!pathway) return null;

  const idx = pathway.sequence.indexOf(currentState);
  if (idx === -1 || idx >= pathway.sequence.length - 1) return null;

  return pathway.sequence[idx + 1];
}

/**
 * Format pathway guidance as markdown for inclusion in tool responses.
 */
export function formatGuidance(
  pathwayName: string,
  stateName: string,
  level?: number,
): string {
  const pathway = pathwayDefinitions[pathwayName];
  if (!pathway) return '';

  const steps = getGuidance(pathwayName, stateName, level);
  if (!steps || steps.length === 0) return '';

  const lines: string[] = [
    `## Pathway: ${pathwayName}`,
    `*${pathway.description}*`,
    '',
    `### Guidance (${stateName}${level ? ` L${level}` : ''})`,
  ];

  for (let i = 0; i < steps.length; i++) {
    lines.push(`${i + 1}. ${steps[i]}`);
  }

  const next = getNextState(pathwayName, stateName);
  if (next) {
    lines.push('', `**Next state in pathway:** \`enter_state("${next}")\``);
  } else if (pathway.loop) {
    lines.push('', '**Stay in this state as long as needed.** When done, `task_update(status=\'completed\')` and `exit_state`.');
  } else {
    lines.push('', '**This is the final state in the pathway.**');
  }

  return lines.join('\n');
}
