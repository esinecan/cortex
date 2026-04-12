/**
 * Loads state definitions from states.yaml and resolves them at runtime.
 * For leveled states (validate), walks the inheritance chain to accumulate
 * tools, guidance, and constraints up to the requested level.
 * @module
 */
import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { StateDefinition, ResolvedState, ExternalGuidance } from './types.js';

let stateDefinitions: Record<string, StateDefinition> = {};

/** Load state definitions from a YAML file. Called once at startup. */
export function loadStates(configPath: string): void {
  const raw = readFileSync(configPath, 'utf-8');
  stateDefinitions = parseYaml(raw) as Record<string, StateDefinition>;
}

export function getStateNames(): string[] {
  return Object.keys(stateDefinitions);
}

/**
 * Resolve a state to its full tool/guidance/constraint set. For leveled states,
 * inherits from lower levels up to the requested one. Returns null if the state
 * doesn't exist or the level exceeds the max.
 */
export function resolveState(name: string, level?: number): ResolvedState | null {
  const def = stateDefinitions[name];
  if (!def) return null;

  // Non-leveled state
  if (!def.levels) {
    return {
      name,
      description: def.description,
      tools: def.tools || [],
      skill_suggestions: def.skill_suggestions || [],
      external_guidance: def.external_guidance || { use: [], avoid: [] },
      constraints: def.constraints || [],
    };
  }

  // Leveled state
  const targetLevel = level || 1;
  const maxLevel = Math.max(...Object.keys(def.levels).map(Number));
  if (targetLevel > maxLevel) return null;
  const resolvedTools: string[] = [];
  let resolvedGuidance: ExternalGuidance = { use: [], avoid: [] };
  const resolvedConstraints: string[] = [];

  // Walk the inheritance chain
  for (let l = 1; l <= targetLevel; l++) {
    const levelDef = def.levels[l];
    if (!levelDef) continue;

    if (levelDef.tools) {
      resolvedTools.push(...levelDef.tools);
    }
    if (levelDef.additional_tools) {
      resolvedTools.push(...levelDef.additional_tools);
    }

    if (levelDef.external_guidance) {
      resolvedGuidance = { ...levelDef.external_guidance };
    }
    if (levelDef.additional_external_guidance?.use) {
      resolvedGuidance.use = [...resolvedGuidance.use, ...levelDef.additional_external_guidance.use];
    }

    if (levelDef.constraints) {
      resolvedConstraints.push(...levelDef.constraints);
    }
  }

  return {
    name,
    description: def.description,
    tools: [...new Set(resolvedTools)],
    skill_suggestions: def.skill_suggestions || [],
    external_guidance: resolvedGuidance,
    constraints: resolvedConstraints,
    level: targetLevel,
    max_level: maxLevel,
  };
}

/** Render a resolved state as markdown for display in tool responses. */
export function formatStateInfo(state: ResolvedState): string {
  const lines: string[] = [
    `# State: ${state.name}${state.level ? ` (Level ${state.level}/${state.max_level})` : ''}`,
    '',
    state.description,
    '',
  ];

  if (state.tools.length > 0) {
    lines.push('## Available Tools');
    lines.push(state.tools.map(t => `- \`${t}\``).join('\n'));
    lines.push('');
  }

  if (state.skill_suggestions.length > 0) {
    lines.push('## Suggested Skills');
    lines.push(state.skill_suggestions.map(s => `- \`/${s}\``).join('\n'));
    lines.push('');
  }

  const guidance = state.external_guidance;
  if (guidance.use.length > 0) {
    lines.push('## External Tools to Use');
    lines.push(guidance.use.join(', '));
    lines.push('');
  }
  if (guidance.avoid.length > 0) {
    lines.push('## External Tools to Avoid');
    lines.push(guidance.avoid.join(', '));
    lines.push('');
  }

  if (state.constraints.length > 0) {
    lines.push('## Constraints');
    for (const c of state.constraints) {
      lines.push(`- ${c}`);
    }
  }

  return lines.join('\n');
}
