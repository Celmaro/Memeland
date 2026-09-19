import fs from 'fs';
let dir = new URL('.', import.meta.url).pathname;
if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1);

const manifest = JSON.parse(fs.readFileSync(dir + 'source-manifest.json', 'utf8'));

// Build a short note per source from the subagent markdown files.
function collectNote(file) {
  const p = dir + 'notes/' + file;
  if (!fs.existsSync(p)) return {};
  const txt = fs.readFileSync(p, 'utf8');
  const blocks = txt.split(/^### SRC-/m).slice(1);
  const map = {};
  for (const b of blocks) {
    const idLine = '### SRC-' + b.split('\n')[0].trim();
    const m = idLine.match(/^### (SRC-\d+)\s+(\S.*)$/);
    if (!m) continue;
    const verdict = (b.match(/^- \*\*Verdict:\*\* (.*)$/m) || [])[1] || '';
    const sec = (b.match(/^- \*\*Security\/complexity flags:\*\* (.*)$/m) || [])[1] || '';
    map[m[1]] = { title: m[2], verdict: verdict.trim(), sec: sec.trim() };
  }
  return map;
}

const notes = Object.assign(
  {},
  collectNote('subagent-A.md'),
  collectNote('subagent-B.md'),
  collectNote('subagent-C.md'),
  collectNote('subagent-D.md'),
  collectNote('subagent-E.md'),
  collectNote('subagent-F.md'),
  collectNote('subagent-G.md'),
  collectNote('subagent-H.md'),
  collectNote('subagent-I.md'),
  collectNote('subagent-J.md'),
  collectNote('subagent-K.md')
);
let changed = 0;
for (const e of manifest) {
  if (!notes[e.id]) continue;
  const n = notes[e.id];
  e.status = 'reviewed';
  e.clonePath = null;
  const v = n.verdict ? 'Verdict: ' + n.verdict.replace(/\*\*/g, '') : '';
  const s = n.sec ? ' | flags: ' + n.sec.replace(/\*\*/g, '') : '';
  e.notes = n.title + '. ' + v + s;
  changed++;
}
fs.writeFileSync(dir + 'source-manifest.json', JSON.stringify(manifest, null, 2));
console.log('updated', changed, 'reviewed now =', manifest.filter(x => x.status === 'reviewed').length);
