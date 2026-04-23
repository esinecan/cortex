import { readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createServer } from 'http';
import { parse as parseYaml } from 'yaml';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = process.env.CORTEX_TASKS_DIR || join(homedir(), '.cortex');
const PORT = process.env.CORTEX_DASH_PORT || 3456;

// --- Static config (loaded once) ---

function loadConfig() {
  const statesRaw = readFileSync(join(__dirname, 'states.yaml'), 'utf8');
  const pathwaysRaw = readFileSync(join(__dirname, 'pathways.yaml'), 'utf8');
  return { states: parseYaml(statesRaw), pathways: parseYaml(pathwaysRaw) };
}

const configCache = loadConfig();

// --- API handlers ---

function readState() {
  const p = join(TASKS_DIR, '_state.json');
  if (!existsSync(p)) return { current_state: 'base', current_level: null, active_task: null, previous_state: null, session_started: new Date().toISOString() };
  return JSON.parse(readFileSync(p, 'utf8'));
}

function readTasks() {
  if (!existsSync(TASKS_DIR)) return [];
  const files = readdirSync(TASKS_DIR).filter(f => f.startsWith('task-') && f.endsWith('.json'));
  return files.map(f => {
    try { return JSON.parse(readFileSync(join(TASKS_DIR, f), 'utf8')); }
    catch { return null; }
  }).filter(Boolean);
}

function readLog() {
  const p = join(TASKS_DIR, '_free_explore_log.jsonl');
  if (!existsSync(p)) return [];
  const lines = readFileSync(p, 'utf8').trim().split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, url, res) {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  if (req.method === 'GET') {
    switch (url) {
      case '/api/state': return res.end(JSON.stringify(readState()));
      case '/api/tasks': return res.end(JSON.stringify(readTasks()));
      case '/api/config': return res.end(JSON.stringify(configCache));
      case '/api/log': return res.end(JSON.stringify(readLog()));
      default: res.statusCode = 404; return res.end('{}');
    }
  }

  if (req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (url === '/api/write-task') {
        if (!body.id || !body.task) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id and task required' })); }
        if (!existsSync(TASKS_DIR)) mkdirSync(TASKS_DIR, { recursive: true });
        writeFileSync(join(TASKS_DIR, `task-${body.id}.json`), JSON.stringify(body.task, null, 2));
        return res.end(JSON.stringify({ ok: true }));
      }
      if (url === '/api/delete-task') {
        if (!body.id) { res.statusCode = 400; return res.end(JSON.stringify({ error: 'id required' })); }
        const p = join(TASKS_DIR, `task-${body.id}.json`);
        if (!existsSync(p)) { res.statusCode = 404; return res.end(JSON.stringify({ error: 'not found' })); }
        unlinkSync(p);
        return res.end(JSON.stringify({ ok: true }));
      }
    } catch (e) {
      res.statusCode = 400; return res.end(JSON.stringify({ error: 'invalid JSON' }));
    }
  }

  res.statusCode = 404; return res.end('{}');
}

// --- HTML ---

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cortex</title>
<style>
  :root {
    --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --border: #30363d;
    --fg: #c9d1d9; --fg2: #8b949e; --fg3: #484f58;
    --recon: #58a6ff; --plan: #bc8cff; --implement: #3fb950;
    --debug: #d29922; --validate: #39d353; --review: #6e7681;
    --browse: #79c0ff; --free: #f85149; --base: #484f58;
    --active: #58a6ff; --completed: #3fb950; --paused: #d29922;
    --abandoned: #f85149; --blocked: #f0883e;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: var(--bg); color: var(--fg);
    font-family: 'JetBrains Mono', 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    font-size: 13px; line-height: 1.5; padding: 16px;
  }
  .header {
    display: flex; align-items: center; gap: 12px;
    padding-bottom: 12px; border-bottom: 1px solid var(--border); margin-bottom: 16px;
  }
  .header h1 { font-size: 14px; font-weight: 600; letter-spacing: 2px; text-transform: uppercase; color: var(--fg2); }
  .header .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--base); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
  .full { grid-column: 1 / -1; }

  .panel {
    background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
    padding: 12px 16px; min-height: 60px; max-height: 70vh; overflow-y: auto;
  }
  .panel.no-scroll { max-height: none; overflow-y: visible; }
  .panel-title {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 1.5px;
    color: var(--fg3); margin-bottom: 8px;
  }

  /* State banner */
  .state-banner { display: flex; gap: 32px; align-items: baseline; flex-wrap: wrap; }
  .state-name { font-size: 28px; font-weight: 700; }
  .state-level { font-size: 16px; font-weight: 400; color: var(--fg2); }
  .state-meta { font-size: 12px; color: var(--fg2); }
  .state-meta span { margin-right: 16px; }
  .state-flash { animation: flash 0.4s ease-out; }
  @keyframes flash { 0% { background: var(--bg3); } 100% { background: var(--bg2); } }

  /* Pathway */
  .pathway-bar { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  .pathway-step {
    display: flex; align-items: center; gap: 4px; padding: 4px 10px;
    border-radius: 12px; font-size: 12px; font-weight: 500;
    background: var(--bg3); color: var(--fg2); transition: all 0.3s;
  }
  .pathway-step.visited { color: var(--fg); }
  .pathway-step.current { color: #fff; font-weight: 700; }
  .pathway-arrow { color: var(--fg3); font-size: 10px; }
  .pathway-none { color: var(--fg3); font-style: italic; font-size: 12px; }

  /* Tools */
  .tools-grid { display: flex; flex-wrap: wrap; gap: 6px; }
  .tool-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 3px 8px; border-radius: 4px; font-size: 11px;
    background: var(--bg3); color: var(--fg);
  }
  .tool-chip .src {
    font-size: 9px; color: var(--fg3); text-transform: uppercase;
    padding: 1px 4px; background: var(--bg); border-radius: 2px;
  }
  .tool-count { font-size: 11px; color: var(--fg2); }

  /* Timeline */
  .timeline { display: flex; align-items: center; gap: 0; flex-wrap: wrap; overflow-x: auto; }
  .tl-segment {
    display: flex; align-items: center; gap: 4px; padding: 4px 10px;
    border-radius: 4px; font-size: 11px; margin-right: 2px;
    white-space: nowrap;
  }
  .tl-segment .dur { color: var(--fg2); font-size: 10px; }
  .tl-arrow { color: var(--fg3); margin: 0 2px; font-size: 10px; }
  .tl-none { color: var(--fg3); font-style: italic; font-size: 12px; }

  /* Tasks */
  .task-row {
    display: flex; align-items: baseline; gap: 8px; padding: 5px 0;
    border-bottom: 1px solid var(--bg3); font-size: 12px;
  }
  .task-row:last-child { border-bottom: none; }
  .task-row.highlight { background: rgba(88, 166, 255, 0.06); margin: 0 -16px; padding: 5px 16px; }
  .task-icon { flex-shrink: 0; width: 16px; text-align: center; }
  .task-title { flex: 1; min-width: 0; }
  .task-badge {
    font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--bg3); color: var(--fg2); flex-shrink: 0;
  }
  .task-date { font-size: 11px; color: var(--fg3); flex-shrink: 0; }
  .task-disclosure {
    flex-shrink: 0; width: 14px; text-align: center; cursor: pointer;
    color: var(--fg3); font-size: 10px; user-select: none;
  }
  .task-disclosure.empty { cursor: default; color: transparent; }
  .task-children { border-left: 1px solid var(--bg3); margin-left: 11px; padding-left: 8px; }

  /* Findings */
  .finding {
    padding: 6px 0; border-bottom: 1px solid var(--bg3); font-size: 12px; cursor: pointer;
  }
  .finding:last-child { border-bottom: none; }
  .finding-header { display: flex; gap: 8px; align-items: baseline; margin-bottom: 2px; }
  .finding-state { font-size: 10px; font-weight: 600; text-transform: uppercase; }
  .finding-time { font-size: 10px; color: var(--fg3); }
  .finding-content { color: var(--fg2); white-space: pre-wrap; word-break: break-word; }
  .finding-content.collapsed { max-height: 2.5em; overflow: hidden; }
  .finding-expand { font-size: 10px; color: var(--fg3); cursor: pointer; margin-top: 2px; }

  /* Free explore log */
  .log-row { display: flex; gap: 12px; padding: 3px 0; font-size: 11px; }
  .log-time { color: var(--fg3); flex-shrink: 0; }
  .log-transition { flex-shrink: 0; }
  .log-reason { color: var(--fg2); flex: 1; word-break: break-word; }
  .log-dur { color: var(--fg3); flex-shrink: 0; }

  .empty { color: var(--fg3); font-style: italic; font-size: 12px; }

  /* Constraints */
  .constraints { margin-top: 8px; }
  .constraint {
    font-size: 11px; color: var(--fg2); padding: 2px 0;
    border-left: 2px solid var(--fg3); padding-left: 8px; margin-bottom: 4px;
  }

  /* Task write UI */
  .task-actions { display: flex; gap: 4px; flex-shrink: 0; }
  .task-actions button, .task-actions select {
    font-family: inherit; font-size: 10px; padding: 2px 6px;
    background: var(--bg3); color: var(--fg2); border: 1px solid var(--border);
    border-radius: 4px; cursor: pointer;
  }
  .task-actions button:hover { background: var(--border); color: var(--fg); }
  .task-actions select { appearance: none; padding-right: 4px; }
  .btn-delete { color: var(--abandoned) !important; }
  .btn-delete:hover { background: rgba(248, 81, 73, 0.15) !important; }

  .new-task-form {
    display: none; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border);
    margin-bottom: 8px; flex-wrap: wrap;
  }
  .new-task-form.visible { display: flex; }
  .new-task-form input {
    font-family: inherit; font-size: 12px; padding: 4px 8px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; flex: 1; min-width: 120px;
  }
  .new-task-form button {
    font-family: inherit; font-size: 11px; padding: 4px 12px;
    background: var(--active); color: #fff; border: none;
    border-radius: 4px; cursor: pointer; font-weight: 600;
  }

  .task-title[contenteditable] { outline: none; }
  .task-title[contenteditable]:focus { background: var(--bg); padding: 0 4px; border-radius: 2px; }

  .inline-note { display: none; gap: 6px; align-items: center; padding: 4px 0 4px 24px; }
  .inline-note.visible { display: flex; }
  .inline-note input {
    font-family: inherit; font-size: 11px; padding: 3px 6px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--border);
    border-radius: 4px; flex: 1;
  }
  .inline-note button {
    font-family: inherit; font-size: 10px; padding: 3px 8px;
    background: var(--bg3); color: var(--fg2); border: 1px solid var(--border);
    border-radius: 4px; cursor: pointer;
  }

  .toast {
    position: fixed; bottom: 20px; right: 20px; padding: 8px 16px;
    background: var(--bg2); color: var(--fg); border: 1px solid var(--border);
    border-radius: 6px; font-size: 12px; opacity: 0; transition: opacity 0.3s;
    z-index: 1000; pointer-events: none;
  }
  .toast.visible { opacity: 1; }
  .toast.success { border-color: var(--completed); }
  .toast.error { border-color: var(--abandoned); }
</style>
</head>
<body>

<div class="header">
  <div class="dot" id="pulse-dot"></div>
  <h1>Cortex</h1>
</div>

<div class="grid">
  <div class="panel full no-scroll" id="state-panel">
    <div class="panel-title">State</div>
    <div class="state-banner">
      <div><span class="state-name" id="state-name">base</span> <span class="state-level" id="state-level"></span></div>
      <div class="state-meta" id="state-meta"></div>
    </div>
  </div>

  <div class="panel full no-scroll" id="pathway-panel">
    <div class="panel-title">Pathway <span id="pathway-name" style="color:var(--fg2);text-transform:none;letter-spacing:0"></span></div>
    <div class="pathway-bar" id="pathway-bar"></div>
  </div>

  <div class="panel full no-scroll" id="tools-panel">
    <div class="panel-title">Tools <span class="tool-count" id="tool-count"></span></div>
    <div class="tools-grid" id="tools-grid"></div>
  </div>

  <div class="panel full no-scroll" id="constraints-panel" style="display:none">
    <div class="panel-title">Constraints</div>
    <div class="constraints" id="constraints"></div>
  </div>

  <div class="panel full no-scroll" id="timeline-panel">
    <div class="panel-title">State History</div>
    <div class="timeline" id="timeline"></div>
  </div>

  <div class="panel" id="tasks-panel">
    <div class="panel-title" style="display:flex;justify-content:space-between;align-items:center">
      Tasks
      <button onclick="toggleNewTaskForm()" style="font-size:10px;padding:2px 8px;background:var(--bg3);color:var(--fg2);border:1px solid var(--border);border-radius:4px;cursor:pointer">+ New</button>
    </div>
    <div class="new-task-form" id="new-task-form">
      <input id="new-task-title" placeholder="Task title" onkeydown="if(event.key==='Enter')submitNewTask()" />
      <input id="new-task-desc" placeholder="Description (optional)" onkeydown="if(event.key==='Enter')submitNewTask()" />
      <button onclick="submitNewTask()">Create</button>
    </div>
    <div id="tasks-list"></div>
  </div>

  <div class="panel" id="findings-panel">
    <div class="panel-title">Findings</div>
    <div id="findings-list"></div>
  </div>

  <div class="panel full" id="log-panel">
    <div class="panel-title">Free Explore Log</div>
    <div id="log-list"></div>
  </div>
</div>

<script>
// --- State colors ---
const STATE_COLORS = {
  recon: '#58a6ff', plan: '#bc8cff', implement: '#3fb950',
  debug: '#d29922', validate: '#39d353', review: '#6e7681',
  browse: '#79c0ff', free: '#f85149', base: '#484f58'
};

const STATUS_ICONS = {
  completed: '<span style="color:#3fb950">\\u2713</span>',
  active: '<span style="color:#58a6ff">\\u25c9</span>',
  paused: '<span style="color:#d29922">\\u23f8</span>',
  abandoned: '<span style="color:#f85149">\\u2717</span>',
  blocked: '<span style="color:#f0883e">\\u2298</span>'
};

// --- Tool source mapping ---
function toolSource(name) {
  if (name.startsWith('dd_')) return 'datadog';
  if (name.startsWith('kubectl_')) return 'kubectl';
  if (name.startsWith('mongo_')) return 'mongo';
  if (name.startsWith('browser_') || name === 'browse_capture') return 'playwright';
  if (name.startsWith('brave_')) return 'brave';
  if (name.startsWith('jira_')) return 'jira';
  if (name.startsWith('confluence_')) return 'confluence';
  if (name === 'run_command') return 'commands';
  if (name === 'run_pipeline' || name === 'rerun_workflow') return 'circleci';
  const ghTools = ['get_commit','list_commits','get_file_contents','list_branches','search_code',
    'search_repositories','search_users','get_me','get_teams','get_team_members',
    'list_pull_requests','pull_request_read','search_pull_requests'];
  if (ghTools.includes(name)) return 'github';
  const ciTools = ['get_build_failure_logs','find_flaky_tests','get_latest_pipeline_status',
    'get_job_test_results','list_artifacts','analyze_diff','config_helper',
    'list_followed_projects','download_usage_api_data','find_underused_resource_classes',
    'list_component_versions','create_prompt_template','recommend_prompt_template_tests',
    'run_evaluation_tests','run_rollback_pipeline'];
  if (ciTools.includes(name)) return 'circleci';
  return '';
}

// --- Config + state ---
let config = null;
let prevStateName = null;
let expandedFindings = new Set();
let expandedTasks = new Set(JSON.parse(localStorage.getItem('cortex.expandedTasks') || '[]'));

function toggleTaskExpansion(id) {
  if (expandedTasks.has(id)) expandedTasks.delete(id);
  else expandedTasks.add(id);
  localStorage.setItem('cortex.expandedTasks', JSON.stringify([...expandedTasks]));
  renderTasks(lastState, lastTasks);
}

async function fetchJSON(url) {
  try { const r = await fetch(url); return r.ok ? r.json() : null; } catch { return null; }
}

// --- Write helpers ---
async function writeTask(id, task) {
  const r = await fetch('/api/write-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, task }) });
  if (!r.ok) throw new Error((await r.json()).error || 'write failed');
}

async function deleteTask(id) {
  const r = await fetch('/api/delete-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }) });
  if (!r.ok) throw new Error((await r.json()).error || 'delete failed');
}

function showToast(msg, type = 'success') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast visible ' + type;
  setTimeout(() => { el.className = 'toast'; }, 2500);
}

function genId() { return Math.random().toString(16).slice(2, 10); }

// --- Task actions ---
function toggleNewTaskForm() {
  const form = document.getElementById('new-task-form');
  form.classList.toggle('visible');
  if (form.classList.contains('visible')) document.getElementById('new-task-title').focus();
}

async function submitNewTask() {
  const titleEl = document.getElementById('new-task-title');
  const descEl = document.getElementById('new-task-desc');
  const title = titleEl.value.trim();
  if (!title) return;
  const active = lastTasks.filter(t => !t.parent && t.status === 'active');
  if (active.length >= 3) { showToast('Max 3 active root tasks', 'error'); return; }
  const id = genId();
  const now = new Date().toISOString();
  const task = { id, title, description: descEl.value.trim(), created: now, updated: now, status: 'active', parent: null, pathway: null, state_history: [], findings: [], subtasks: [] };
  try {
    await writeTask(id, task);
    showToast('Created: ' + title);
    titleEl.value = ''; descEl.value = '';
    document.getElementById('new-task-form').classList.remove('visible');
    pollTasks();
  } catch (e) { showToast(e.message, 'error'); }
}

async function changeTaskStatus(id, status) {
  const task = lastTasks.find(t => t.id === id);
  if (!task) return;
  task.status = status;
  task.updated = new Date().toISOString();
  try { await writeTask(id, task); showToast('Status: ' + status); pollTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}

async function saveTaskTitle(id, el) {
  const newTitle = el.textContent.trim();
  if (!newTitle) return;
  const task = lastTasks.find(t => t.id === id);
  if (!task || task.title === newTitle) return;
  task.title = newTitle;
  task.updated = new Date().toISOString();
  try { await writeTask(id, task); showToast('Title updated'); }
  catch (e) { showToast(e.message, 'error'); pollTasks(); }
}

async function deleteTaskAction(id) {
  if (!confirm('Delete this task?')) return;
  try { await deleteTask(id); showToast('Deleted'); pollTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}

function toggleNoteInput(id) {
  const el = document.getElementById('note-row-' + id);
  if (el) el.classList.toggle('visible');
}

async function addNote(id) {
  const input = document.getElementById('note-input-' + id);
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  const task = lastTasks.find(t => t.id === id);
  if (!task) return;
  task.findings.push({ ts: new Date().toISOString(), state: 'manual', content: '[note] ' + content });
  task.updated = new Date().toISOString();
  try { await writeTask(id, task); showToast('Note added'); input.value = ''; pollTasks(); }
  catch (e) { showToast(e.message, 'error'); }
}

// --- Resolve tools for state + level ---
function resolveTools(stateName, level) {
  if (!config) return [];
  const def = config.states[stateName];
  if (!def) return [];
  if (def.tools) return def.tools;
  if (!def.levels) return [];
  const targetLevel = level || 1;
  let tools = [];
  for (let l = 1; l <= targetLevel; l++) {
    const ld = def.levels[l];
    if (!ld) continue;
    if (ld.tools) tools = [...ld.tools];
    if (ld.additional_tools) tools = [...tools, ...ld.additional_tools];
  }
  return tools;
}

// --- Resolve constraints for state + level ---
function resolveConstraints(stateName, level) {
  if (!config) return [];
  const def = config.states[stateName];
  if (!def) return [];
  if (def.constraints && !def.levels) return def.constraints;
  if (!def.levels) return [];
  const targetLevel = level || 1;
  let constraints = [];
  for (let l = 1; l <= targetLevel; l++) {
    const ld = def.levels[l];
    if (!ld) continue;
    if (ld.constraints) constraints = [...constraints, ...ld.constraints];
  }
  return constraints;
}

// --- Time formatting ---
function fmtDuration(ms) {
  if (ms < 0) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return months[d.getMonth()] + ' ' + d.getDate();
}

function fmtDateTime(iso) {
  return fmtDate(iso) + ' ' + fmtTime(iso);
}

// --- Render functions ---

function renderState(state) {
  const el = document.getElementById('state-name');
  const stateName = state.current_state || 'base';
  const color = STATE_COLORS[stateName] || STATE_COLORS.base;

  if (prevStateName && prevStateName !== stateName) {
    document.getElementById('state-panel').classList.add('state-flash');
    setTimeout(() => document.getElementById('state-panel').classList.remove('state-flash'), 400);
  }
  prevStateName = stateName;

  el.textContent = stateName;
  el.style.color = color;
  document.getElementById('pulse-dot').style.background = color;

  const levelEl = document.getElementById('state-level');
  levelEl.textContent = state.current_level ? '(L' + state.current_level + ')' : '';

  const metaEl = document.getElementById('state-meta');
  let meta = '';
  if (state.previous_state) meta += '<span>prev: ' + state.previous_state + '</span>';
  if (state.session_started) {
    const uptime = Date.now() - new Date(state.session_started).getTime();
    meta += '<span>session: ' + fmtDuration(uptime) + '</span>';
  }
  metaEl.innerHTML = meta;
}

function renderPathway(state, tasks) {
  const bar = document.getElementById('pathway-bar');
  const nameEl = document.getElementById('pathway-name');

  const activeTask = state.active_task ? tasks.find(t => t.id === state.active_task) : null;
  const pathwayName = activeTask?.pathway;

  if (!pathwayName || !config?.pathways?.[pathwayName]) {
    nameEl.textContent = '';
    bar.innerHTML = '<span class="pathway-none">no active pathway</span>';
    return;
  }

  const pw = config.pathways[pathwayName];
  nameEl.textContent = '/ ' + pathwayName;

  const visitedStates = new Set((activeTask.state_history || []).map(h => h.state));
  const currentState = state.current_state;

  let html = '';
  pw.sequence.forEach((s, i) => {
    const color = STATE_COLORS[s] || STATE_COLORS.base;
    const isCurrent = s === currentState;
    const isVisited = visitedStates.has(s);
    let cls = 'pathway-step';
    if (isCurrent) cls += ' current';
    else if (isVisited) cls += ' visited';

    const bg = isCurrent ? color : (isVisited ? color + '22' : '');
    const border = isVisited || isCurrent ? '1px solid ' + color : '1px solid transparent';
    html += '<div class="' + cls + '" style="background:' + (bg || 'var(--bg3)') + ';border:' + border + '">' + s + '</div>';
    if (i < pw.sequence.length - 1) html += '<span class="pathway-arrow">&#9656;</span>';
  });

  bar.innerHTML = html;
}

function renderTools(state) {
  const tools = resolveTools(state.current_state, state.current_level);
  document.getElementById('tool-count').textContent = '(' + tools.length + ')';

  const grid = document.getElementById('tools-grid');
  if (!tools.length) { grid.innerHTML = '<span class="empty">no tools in this state</span>'; return; }

  grid.innerHTML = tools.map(t => {
    const src = toolSource(t);
    const srcHtml = src ? ' <span class="src">' + src + '</span>' : '';
    return '<span class="tool-chip">' + t + srcHtml + '</span>';
  }).join('');

  // Constraints
  const constraints = resolveConstraints(state.current_state, state.current_level);
  const cp = document.getElementById('constraints-panel');
  const ce = document.getElementById('constraints');
  if (constraints.length) {
    cp.style.display = '';
    const color = STATE_COLORS[state.current_state] || STATE_COLORS.base;
    ce.innerHTML = constraints.map(c =>
      '<div class="constraint" style="border-left-color:' + color + '">' + escHtml(c) + '</div>'
    ).join('');
  } else {
    cp.style.display = 'none';
  }
}

function renderTimeline(state, tasks) {
  const el = document.getElementById('timeline');
  const activeTask = state.active_task ? tasks.find(t => t.id === state.active_task) : null;
  const history = activeTask?.state_history || [];

  if (!history.length) { el.innerHTML = '<span class="tl-none">no state history</span>'; return; }

  // Deduplicate consecutive same-state entries by merging them
  const merged = [];
  for (const h of history) {
    const last = merged[merged.length - 1];
    if (last && last.state === h.state) {
      last.exited = h.exited;
    } else {
      merged.push({ ...h });
    }
  }

  el.innerHTML = merged.map((h, i) => {
    const color = STATE_COLORS[h.state] || STATE_COLORS.base;
    const entered = new Date(h.entered);
    const exited = h.exited ? new Date(h.exited) : new Date();
    const dur = fmtDuration(exited - entered);
    const isLast = i === merged.length - 1;
    const opacity = isLast && !h.exited ? '1' : '0.7';

    let html = '<div class="tl-segment" style="background:' + color + '18;color:' + color + ';opacity:' + opacity + '">'
      + h.state + ' <span class="dur">' + dur + '</span></div>';
    if (i < merged.length - 1) html += '<span class="tl-arrow">&#9656;</span>';
    return html;
  }).join('');
}

function renderTaskRow(t, activeId) {
  const statuses = ['active', 'paused', 'blocked', 'completed', 'abandoned'];
  const byParent = renderTaskRow._byParent;
  const children = byParent.get(t.id) || [];
  const isActive = t.id === activeId;
  const icon = STATUS_ICONS[t.status] || '';
  const badge = t.pathway ? '<span class="task-badge">' + t.pathway + '</span>' : '';
  const opts = statuses.map(s => '<option value="' + s + '"' + (s === t.status ? ' selected' : '') + '>' + s + '</option>').join('');
  const expanded = expandedTasks.has(t.id);
  const disclosure = children.length
    ? '<span class="task-disclosure" onclick="toggleTaskExpansion(\\'' + t.id + '\\')">' + (expanded ? '&#9662;' : '&#9656;') + '</span>'
    : '<span class="task-disclosure empty">&#9656;</span>';
  const childCount = children.length ? '<span class="task-badge">' + children.length + '</span>' : '';

  let html = '<div class="task-row' + (isActive ? ' highlight' : '') + '">'
    + disclosure
    + '<span class="task-icon">' + icon + '</span>'
    + '<span class="task-title" contenteditable="true" '
    + 'onblur="saveTaskTitle(\\'' + t.id + '\\', this)" '
    + 'onkeydown="if(event.key===\\'Enter\\'){event.preventDefault();this.blur()}"'
    + '>' + escHtml(t.title) + '</span>'
    + badge
    + childCount
    + '<div class="task-actions">'
    + '<select onchange="changeTaskStatus(\\'' + t.id + '\\', this.value)">' + opts + '</select>'
    + '<button onclick="toggleNoteInput(\\'' + t.id + '\\')" title="Add note">+</button>'
    + '<button class="btn-delete" onclick="deleteTaskAction(\\'' + t.id + '\\')" title="Delete">&times;</button>'
    + '</div>'
    + '<span class="task-date">' + fmtDate(t.updated) + '</span>'
    + '</div>'
    + '<div class="inline-note" id="note-row-' + t.id + '">'
    + '<input id="note-input-' + t.id + '" placeholder="Add a note..." '
    + 'onkeydown="if(event.key===\\'Enter\\')addNote(\\'' + t.id + '\\')" />'
    + '<button onclick="addNote(\\'' + t.id + '\\')">Save</button>'
    + '</div>';

  if (children.length && expanded) {
    const sortedKids = [...children].sort((a, b) => new Date(b.updated) - new Date(a.updated));
    html += '<div class="task-children">' + sortedKids.map(c => renderTaskRow(c, activeId)).join('') + '</div>';
  }
  return html;
}

function renderTasks(state, tasks) {
  const el = document.getElementById('tasks-list');
  if (!tasks.length) { el.innerHTML = '<span class="empty">no tasks</span>'; return; }

  const ids = new Set(tasks.map(t => t.id));
  const byParent = new Map();
  for (const t of tasks) {
    const p = t.parent && ids.has(t.parent) ? t.parent : null;
    if (!byParent.has(p)) byParent.set(p, []);
    byParent.get(p).push(t);
  }
  renderTaskRow._byParent = byParent;

  const roots = (byParent.get(null) || []).sort((a, b) => new Date(b.updated) - new Date(a.updated));
  el.innerHTML = roots.map(t => renderTaskRow(t, state.active_task)).join('');
}

function renderFindings(state, tasks) {
  const el = document.getElementById('findings-list');
  const activeTask = state.active_task ? tasks.find(t => t.id === state.active_task) : null;
  const findings = activeTask?.findings || [];

  if (!findings.length) { el.innerHTML = '<span class="empty">no findings</span>'; return; }

  const recent = [...findings].reverse();
  el.innerHTML = recent.map((f, i) => {
    const color = STATE_COLORS[f.state] || STATE_COLORS.base;
    const expanded = expandedFindings.has(i);
    const content = f.content || '';
    const truncated = content.length > 200 && !expanded;
    return '<div class="finding" data-idx="' + i + '">'
      + '<div class="finding-header">'
      + '<span class="finding-state" style="color:' + color + '">' + f.state + '</span>'
      + '<span class="finding-time">' + fmtTime(f.ts) + '</span>'
      + '</div>'
      + '<div class="finding-content' + (truncated ? ' collapsed' : '') + '">' + escHtml(truncated ? content.slice(0, 200) + '...' : content) + '</div>'
      + (content.length > 200 ? '<div class="finding-expand">' + (expanded ? '[ collapse ]' : '[ expand ]') + '</div>' : '')
      + '</div>';
  }).join('');

  el.querySelectorAll('.finding').forEach(f => {
    f.addEventListener('click', () => {
      const idx = parseInt(f.dataset.idx);
      if (expandedFindings.has(idx)) expandedFindings.delete(idx);
      else expandedFindings.add(idx);
      renderFindings(lastState, lastTasks);
    });
  });
}

function renderLog(log) {
  const el = document.getElementById('log-list');
  if (!log.length) { el.innerHTML = '<span class="empty">no free explore sessions</span>'; return; }

  // Pair entries: open (reason != null, duration == null) + close (reason == null, duration != null)
  const sessions = [];
  for (let i = 0; i < log.length; i++) {
    const entry = log[i];
    if (entry.reason !== null && entry.reason !== undefined) {
      // Look for matching close
      const close = log[i + 1]?.duration_seconds != null ? log[i + 1] : null;
      sessions.push({
        time: entry.timestamp,
        from: entry.from_state || entry.from_mode || '?',
        reason: entry.reason,
        duration: close?.duration_seconds,
        task: entry.task_id
      });
      if (close) i++;
    }
  }

  const recent = sessions.reverse();
  el.innerHTML = recent.map(s => {
    const fromColor = STATE_COLORS[s.from] || STATE_COLORS.base;
    return '<div class="log-row">'
      + '<span class="log-time">' + fmtDateTime(s.time) + '</span>'
      + '<span class="log-transition"><span style="color:' + fromColor + '">' + s.from + '</span> &#8594; free</span>'
      + (s.duration != null ? '<span class="log-dur">' + s.duration + 's</span>' : '')
      + '<span class="log-reason">' + escHtml(s.reason || '') + '</span>'
      + '</div>';
  }).join('');
}

function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Polling ---

let lastState = {};
let lastTasks = [];

async function pollState() {
  const state = await fetchJSON('/api/state');
  if (!state) return;
  lastState = state;
  renderState(state);
  renderPathway(state, lastTasks);
  renderTools(state);
  renderTimeline(state, lastTasks);
  renderFindings(state, lastTasks);
}

async function pollTasks() {
  const tasks = await fetchJSON('/api/tasks');
  if (!tasks) return;
  lastTasks = tasks;
  // Skip re-render if user is editing inside the tasks panel
  const active = document.activeElement;
  const tasksPanel = document.getElementById('tasks-panel');
  if (!(active && tasksPanel && tasksPanel.contains(active))) {
    renderTasks(lastState, tasks);
  }
  renderPathway(lastState, tasks);
  renderTimeline(lastState, tasks);
  renderFindings(lastState, tasks);
}

async function pollLog() {
  const log = await fetchJSON('/api/log');
  if (!log) return;
  renderLog(log);
}

// --- Init ---
async function init() {
  config = await fetchJSON('/api/config');
  await Promise.all([pollState(), pollTasks(), pollLog()]);
  setInterval(pollState, 1000);
  setInterval(pollTasks, 3000);
  setInterval(pollLog, 5000);
}

init();
</script>
<div class="toast" id="toast"></div>
</body>
</html>`;

// --- Server ---

const server = createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url.startsWith('/api/')) return handleApi(req, url, res);
  if (url === '/' || url === '/index.html') {
    res.setHeader('Content-Type', 'text/html');
    return res.end(HTML);
  }
  res.statusCode = 404;
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Cortex Dashboard: http://localhost:${PORT}`);
});
