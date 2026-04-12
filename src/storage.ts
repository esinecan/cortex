/**
 * Persistence layer. Reads and writes tasks, state, and free explore logs to disk.
 * Default location is ~/.cortex/, overridable via CORTEX_TASKS_DIR.
 * @module
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, appendFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PersistentTask, CortexState, FreeExploreEntry } from './types.js';

let TASKS_DIR = process.env.CORTEX_TASKS_DIR || join(homedir(), '.cortex');

/** Override the tasks directory. Used by tests. */
export function setTasksDir(dir: string): void {
  TASKS_DIR = dir;
}

export function getTasksDir(): string {
  return TASKS_DIR;
}

function stateFile(): string {
  return join(TASKS_DIR, '_state.json');
}

function freeExploreLog(): string {
  return join(TASKS_DIR, '_free_explore_log.jsonl');
}

function ensureDir(): void {
  if (!existsSync(TASKS_DIR)) {
    mkdirSync(TASKS_DIR, { recursive: true });
  }
}

// -- Task storage --

function taskPath(id: string): string {
  return join(TASKS_DIR, `task-${id}.json`);
}

/** Load a task by ID, or null if it doesn't exist or is corrupted. */
export function loadTask(id: string): PersistentTask | null {
  const path = taskPath(id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[cortex] Failed to parse task ${id}: ${err}\n`);
    return null;
  }
}

/** Write a task to disk. Updates the `updated` timestamp automatically. */
export function saveTask(task: PersistentTask): void {
  ensureDir();
  task.updated = new Date().toISOString();
  writeFileSync(taskPath(task.id), JSON.stringify(task, null, 2));
}

/** List all tasks by scanning for task-*.json files in the tasks directory. */
export function listTasks(): PersistentTask[] {
  ensureDir();
  const files = readdirSync(TASKS_DIR).filter(f => f.startsWith('task-') && f.endsWith('.json'));
  const tasks: PersistentTask[] = [];
  for (const f of files) {
    try {
      tasks.push(JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf-8')));
    } catch (err) {
      process.stderr.write(`[cortex] Failed to parse ${f}: ${err}\n`);
    }
  }
  return tasks;
}

/** Permanently remove a task file from disk. */
export function deleteTask(id: string): boolean {
  const path = taskPath(id);
  if (!existsSync(path)) return false;
  unlinkSync(path);
  return true;
}

// -- State storage --

/** Load the persisted cortex state, or null on first run or if corrupted. */
export function loadState(): CortexState | null {
  ensureDir();
  const sf = stateFile();
  if (!existsSync(sf)) return null;
  try {
    return JSON.parse(readFileSync(sf, 'utf-8'));
  } catch (err) {
    process.stderr.write(`[cortex] Failed to parse state file: ${err}\n`);
    return null;
  }
}

/** Persist the current cortex state to disk. */
export function saveState(state: CortexState): void {
  ensureDir();
  writeFileSync(stateFile(), JSON.stringify(state, null, 2));
}

// -- Free explore log --

/** Append a free explore entry to the JSONL audit log. The log is append-only. */
export function appendFreeExploreEntry(entry: FreeExploreEntry): void {
  ensureDir();
  appendFileSync(freeExploreLog(), JSON.stringify(entry) + '\n');
}

/** Read all free explore entries from the JSONL log. */
export function loadFreeExploreLog(): FreeExploreEntry[] {
  const logFile = freeExploreLog();
  if (!existsSync(logFile)) return [];
  const content = readFileSync(logFile, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
}
