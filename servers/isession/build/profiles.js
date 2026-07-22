// Prompt profiles: where "knowing the target" lives.
// Each profile maps a target program to its interaction shape.
// The detector is a hint; the driving model is the arbiter (always see raw screen).

export const PROFILES = {
  generic: {
    name: "generic",
    // last rendered line matches one of these -> looks like a prompt
    ready_prompt: /(^|\S)[$#>]\s*$|>>>\s*$|\(y\/n\)\s*:?\s*$|^password:\s*$/i,
    question_prompt: /\(y\/n\)|\?\s*$|^password:/i,
    busy_markers: [],
    submit: "Enter",
    interrupt: "C-c",
  },

  pi: {
    name: "pi",
    // ready: pi's footer model line, e.g. "(zai) glm-5.2 • high"
    ready_prompt: /\(zai\)\s+\S+.*•\s+(low|medium|high)\s*$/,
    // a question pi/harness puts to the user mid-session
    question_prompt: /(Trust project folder\?|→\s*(Trust|Do not trust)|Do not trust|\(y\/n\))/,
    // markers that mean "pi is working, do NOT interrupt"
    busy_markers: [
      /MCP:\s*connecting/i,
      /Thinking\.\.\./,
      /Working\.\.\./i,
      /Running\.\.\./,
      /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/,          // braille spinner frames
      /^\s*●/,                 // legacy spinner dot frames
      /\bRunning tool\b/i,
    ],
    submit: "Enter",
    interrupt: "C-c",
  },
};

export function getProfile(name) {
  return PROFILES[name] || PROFILES.generic;
}

export function profileForCommand(command) {
  const base = String(command || "").split("/").pop();
  if (base === "pi") return PROFILES.pi;
  return PROFILES.generic;
}
