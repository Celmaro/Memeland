import fs from 'fs';
let dir = new URL('.', import.meta.url).pathname;
if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1);
const m = JSON.parse(fs.readFileSync(dir + 'source-manifest.json', 'utf8'));
const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"';
const rows = [['id','url','kind','category','priority','status','clonePath','notes'].join(',')];
for (const x of m) {
  rows.push([esc(x.id),esc(x.url),esc(x.kind),esc(x.category),esc(x.priority),esc(x.status),esc(x.clonePath||''),esc(x.notes||'')].join(','));
}
fs.writeFileSync(dir + 'source-manifest.csv', rows.join('\n'));
console.log('csv lines', rows.length, 'reviewed', m.filter(x=>x.status==='reviewed').length);
