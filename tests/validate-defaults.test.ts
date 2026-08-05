import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { defaultChecks } from '../src/tools/validate.js';

describe('defaultChecks', () => {
  it('detects a node project and a git worktree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-vd-'));
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run' } }));
    mkdirSync(join(dir, '.git'));
    const names = defaultChecks(dir).map((c) => c.name);
    expect(names).toContain('Node version');
    expect(names).toContain('Test suite');
    expect(names).toContain('Clean git worktree');
  });

  it('returns only universal checks outside a project', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-vd-empty-'));
    const names = defaultChecks(dir).map((c) => c.name);
    expect(names).toContain('Node version');
    expect(names).not.toContain('Test suite');
    expect(names).not.toContain('Clean git worktree');
  });

  it('skips project checks on unreadable package.json', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-vd-bad-'));
    writeFileSync(join(dir, 'package.json'), '{not json');
    const names = defaultChecks(dir).map((c) => c.name);
    expect(names).toContain('Node version');
    expect(names).not.toContain('Test suite');
  });
});
