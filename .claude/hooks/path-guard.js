#!/usr/bin/env node
// PreToolUse guard: blocks file tools from touching anything outside the project root.
// Exit code 2 = block the tool call and show stderr to Claude.
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..').toLowerCase();

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const ti = input.tool_input || {};
  const candidates = [ti.file_path, ti.path, ti.notebook_path].filter(
    (p) => typeof p === 'string' && p.length > 0,
  );
  for (const p of candidates) {
    const abs = path.resolve(input.cwd || ROOT, p).toLowerCase();
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) {
      process.stderr.write(
        `Blocked by workspace policy (CLAUDE.md): "${p}" is outside the project root ${ROOT}. ` +
          'Use ./.tmp for temporary files and ./.claude/memory for notes.\n',
      );
      process.exit(2);
    }
  }
  process.exit(0);
});
