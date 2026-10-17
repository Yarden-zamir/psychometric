// node tools/validate-bank-text.mjs [manifest path]
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function validateTextManifest(manifest) {
  const string = value => typeof value === 'string' && value.length > 0;
  for (const bank of manifest.banks) {
    for (const q of bank.questions) {
      assert(Object.hasOwn(q, 'text'), `Missing text field: ${bank.id}/${q.id}`);
      if (q.section === 'quantitative') assert.equal(q.text, null, `Quantitative text: ${q.id}`);
      if (q.text === null) continue;
      const t = q.text;
      assert.equal(t.dir, q.section === 'english' ? 'ltr' : 'rtl');
      assert(string(t.stem) && !/^\d{1,2}\s*\.|^\.\s*\d{1,2}/u.test(t.stem), `Invalid stem: ${q.id}`);
      assert(Array.isArray(t.choices) && t.choices.length === 4 && t.choices.every(string), `Invalid choices: ${q.id}`);
      assert.equal(new Set(t.choices).size, 4, `Choices lost distinguishing formatting: ${q.id}`);
      for (const s of [t.stem, ...t.choices]) {
        assert(!/[\u0000-\u0008\u000e-\u001f\ufffd]/u.test(s), `Invalid characters: ${q.id}`);
        assert(!/\([1-4]\)|\)[1-4]\(/u.test(s), `Choice marker left in text: ${q.id}`);
      }
    }
    for (const c of bank.contexts) {
      assert(Object.hasOwn(c, 'text'), `Missing context text: ${c.id}`);
      if (c.kind !== 'passage') assert.equal(c.text, null, `Chart text: ${c.id}`);
      if (c.text === null) continue;
      const t = c.text;
      assert(['rtl', 'ltr'].includes(t.dir));
      assert(t.title === null || string(t.title));
      assert(t.instructions === null || string(t.instructions));
      assert(t.lines.length && t.lines.some(l => string(l.text)));
      let last = 0;
      for (const line of t.lines) {
        assert(typeof line.text === 'string');
        assert(line.n === null || Number.isInteger(line.n) && line.n > last && (line.n === 1 || line.n % 5 === 0));
        if (line.n !== null) last = line.n;
        assert(!/^\s*\(?\d{1,2}\)\s|\s\(\d{1,2}\)\s*$/u.test(line.text), `Margin number left in line: ${c.id}`);
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = resolve(process.argv[2] ?? new URL('../site/banks/manifest.json', import.meta.url).pathname);
  const manifest = JSON.parse(await readFile(path));
  validateTextManifest(manifest);
  for (const bank of manifest.banks) {
    for (const item of [...bank.questions, ...bank.contexts]) assert((await stat(join(dirname(path), bank.id, item.file))).size > 0);
    console.log(`${bank.id}: questions text=${bank.questions.filter(q => q.text).length} image=${bank.questions.filter(q => !q.text).length}; passages text=${bank.contexts.filter(c => c.text).length}`);
  }
}
