#!/usr/bin/env node
// SessionStart hook: re-inject the heartbeat + decisions after startup/resume/compaction,
// so work continues from the recorded state instead of from a lossy summary.
const fs = require('fs');
const path = require('path');

const mem = path.resolve(__dirname, '..', 'memory');
const files = ['HEARTBEAT.md', 'DECISIONS.md'];
let out = '## Hangar session memory (auto-loaded from .claude/memory)\n\n';
out += 'Workspace boundary: only this project folder is usable. Temp files → ./.tmp\n\n';
for (const f of files) {
  const p = path.join(mem, f);
  if (fs.existsSync(p)) out += `### ${f}\n\n` + fs.readFileSync(p, 'utf8') + '\n\n';
}
process.stdout.write(out);
