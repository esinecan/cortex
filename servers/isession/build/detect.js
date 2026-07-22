// State detection. Best guess, never the final word.
// Verdict: awaiting_input when quiescent AND (prompt matched OR idle beyond ceiling).
//          running when a busy marker is present or output is still evolving.
// The raw rendered screen is ALWAYS returned alongside so the model can overrule.

import { getProfile } from "./profiles.js";

export function lastNonEmptyLine(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i];
    if (t && t.trim() !== "") return t.replace(/\s+$/, "");
  }
  return "";
}

// last N non-empty lines joined with \n (for footer-style prompts that span multiple lines)
export function lastNonEmptyLines(lines, n = 3) {
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < n; i--) {
    const t = lines[i];
    if (t && t.trim() !== "") out.unshift(t.replace(/\s+$/, ""));
  }
  return out.join("\n");
}

// lines: array of rendered lines (current screen). idle: boolean (no change for idle_ms).
export function classify(lines, profile, idle) {
  const screen = (lines || []).join("\n");
  const prof = profile || getProfile("generic");
  const busy = (prof.busy_markers || []).some((rx) => rx.test(screen));
  const last = lastNonEmptyLine(lines);
  const hasContent = last.trim().length > 0;
  const tail = lastNonEmptyLines(lines, 3);
  const ready = prof.ready_prompt ? prof.ready_prompt.test(tail) : false;
  const question = prof.question_prompt ? prof.question_prompt.test(screen) : false;

  let state = "running";
  let reason = "producing output";
  if (!hasContent) {
    // blank screen -> still booting/drawing; never falsely hand back on empty output
    state = "running";
    reason = "empty screen (booting/drawing)";
  } else if (busy) {
    state = "running";
    reason = "busy marker matched";
  } else if (question && idle) {
    state = "awaiting_input";
    reason = "question prompt + quiescent";
  } else if (ready && idle) {
    state = "awaiting_input";
    reason = "ready prompt + quiescent";
  } else if (idle) {
    state = "awaiting_input";
    reason = "quiescent beyond ceiling (no prompt matched)";
  }
  return { state, reason, last_line: last, busy, ready, question, hasContent };
}
