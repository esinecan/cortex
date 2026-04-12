import { describe, it, expect, beforeEach } from 'vitest';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { loadStates, resolveState, getStateNames, formatStateInfo } from '../src/states.js';
import {
  loadPathways,
  getPathwayNames,
  getPathway,
  getGuidance,
  getNextState,
} from '../src/pathways.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

describe('States', () => {
  beforeEach(() => {
    loadStates(join(PROJECT_ROOT, 'states.yaml'));
  });

  describe('getStateNames', () => {
    it('returns all defined states', () => {
      const names = getStateNames();
      expect(names).toContain('base');
      expect(names).toContain('recon');
      expect(names).toContain('plan');
      expect(names).toContain('implement');
      expect(names).toContain('debug');
      expect(names).toContain('validate');
      expect(names).toContain('review');
      expect(names).toContain('browse');
    });
  });

  describe('resolveState', () => {
    it('resolves a non-leveled state', () => {
      const resolved = resolveState('recon');
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe('recon');
      expect(resolved!.description).toBeTruthy();
      expect(resolved!.tools).toBeInstanceOf(Array);
    });

    it('returns null for unknown state', () => {
      expect(resolveState('nonexistent')).toBeNull();
    });

    it('resolves a leveled state at L1', () => {
      const resolved = resolveState('validate', 1);
      expect(resolved).not.toBeNull();
      expect(resolved!.level).toBe(1);
      expect(resolved!.tools.length).toBeGreaterThan(0);
    });

    it('resolves a leveled state at L2 with inherited tools', () => {
      const l1 = resolveState('validate', 1);
      const l2 = resolveState('validate', 2);
      expect(l2).not.toBeNull();
      expect(l2!.level).toBe(2);
      // L2 should have at least as many tools as L1 (inheritance)
      expect(l2!.tools.length).toBeGreaterThanOrEqual(l1!.tools.length);
    });

    it('returns null for level beyond max', () => {
      expect(resolveState('validate', 99)).toBeNull();
    });

    it('includes external guidance', () => {
      const resolved = resolveState('recon');
      expect(resolved!.external_guidance).toBeDefined();
      expect(resolved!.external_guidance).toHaveProperty('use');
      expect(resolved!.external_guidance).toHaveProperty('avoid');
    });
  });

  describe('formatStateInfo', () => {
    it('renders markdown with state name', () => {
      const resolved = resolveState('debug')!;
      const md = formatStateInfo(resolved);
      expect(md).toContain('# State: debug');
    });

    it('includes level info for leveled states', () => {
      const resolved = resolveState('validate', 2)!;
      const md = formatStateInfo(resolved);
      expect(md).toContain('Level 2');
    });
  });
});

describe('Pathways', () => {
  beforeEach(() => {
    loadPathways(join(PROJECT_ROOT, 'pathways.yaml'));
  });

  describe('getPathwayNames', () => {
    it('returns all defined pathways', () => {
      const names = getPathwayNames();
      expect(names).toContain('golden');
      expect(names).toContain('investigation');
      expect(names).toContain('knowledge');
    });
  });

  describe('getPathway', () => {
    it('returns a pathway definition', () => {
      const pw = getPathway('golden');
      expect(pw).not.toBeNull();
      expect(pw!.description).toBeTruthy();
      expect(pw!.initial_state).toBeTruthy();
      expect(pw!.sequence).toBeInstanceOf(Array);
      expect(pw!.sequence.length).toBeGreaterThan(0);
    });

    it('returns null for unknown pathway', () => {
      expect(getPathway('nonexistent')).toBeNull();
    });
  });

  describe('getGuidance', () => {
    it('returns guidance steps for a valid state in a pathway', () => {
      const pw = getPathway('golden')!;
      const firstState = pw.sequence[0];
      const guidance = getGuidance('golden', firstState);
      expect(guidance).not.toBeNull();
      expect(guidance).toBeInstanceOf(Array);
      expect(guidance!.length).toBeGreaterThan(0);
    });

    it('returns null for invalid pathway', () => {
      expect(getGuidance('nonexistent', 'recon')).toBeNull();
    });

    it('returns null for state not in pathway', () => {
      expect(getGuidance('golden', 'browse')).toBeNull();
    });
  });

  describe('getNextState', () => {
    it('returns the next state in sequence', () => {
      const pw = getPathway('golden')!;
      const first = pw.sequence[0];
      const next = getNextState('golden', first);
      expect(next).toBe(pw.sequence[1]);
    });

    it('returns null at end of sequence', () => {
      const pw = getPathway('golden')!;
      const last = pw.sequence[pw.sequence.length - 1];
      expect(getNextState('golden', last)).toBeNull();
    });

    it('returns null for unknown pathway', () => {
      expect(getNextState('nonexistent', 'recon')).toBeNull();
    });
  });
});
