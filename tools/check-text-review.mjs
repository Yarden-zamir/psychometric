// After personally comparing EVERY sheet: node tools/check-text-review.mjs --record-all-checked
// Otherwise: verify the recorded review still covers every non-null text.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateTextManifest } from './validate-bank-text.mjs';

const here = dirname(fileURLToPath(import.meta.url)), root = dirname(here);
const sha = data => createHash('sha256').update(data).digest('hex');
const manifestBytes = await readFile(join(root, 'site/banks/manifest.json'));
const manifest = JSON.parse(manifestBytes), hash = sha(manifestBytes);
validateTextManifest(manifest);
const index = JSON.parse(await readFile(join(here, 'text-review-sheets/index.local.json')));
const extraction = JSON.parse(await readFile(join(here, 'text-extraction.local.json')));
assert.equal(index.manifestSha256, hash, 'Review sheets are stale; regenerate them');
assert.equal(extraction.manifestSha256, hash, 'Extraction report is stale; rebuild');
for (const sheet of index.sheets) assert.equal(sha(await readFile(join(root, sheet.file))), sheet.sha256, `Sheet changed: ${sheet.file}`);
if (process.argv.includes('--record-all-checked')) {
  const review = { manifestSha256: hash,
    method: 'Every listed sheet was personally compared: source crop beside browser-shaped text. Only ids, reasons and hashes are stored here; sheets and source text stay gitignored.',
    constraints: [
      'Quantitative questions and chart contexts always use images.',
      'Any image overlapping a crop, including the large watermark in the autumn/winter 2020 PDFs, forces image fallback.',
      'Underlines, other graphics, invalid text controls and small math labels force image fallback; no Unicode repair or normalization.',
    ],
    banks: manifest.banks.map(bank => {
      const reasons = extraction.banks.find(b => b.id === bank.id);
      const group = kind => ({ withText: bank[kind].filter(i => i.text).map(i => i.id),
        nullText: bank[kind].filter(i => !i.text).map(i => {
          const reason = reasons[kind].find(r => r.id === i.id)?.reason;
          assert(reason, `No fallback reason for ${bank.id}/${i.id}`);
          return { id: i.id, reason };
        }) });
      return { id: bank.id, questions: group('questions'), contexts: group('contexts'),
        sheetsChecked: index.sheets.filter(s => s.bank === bank.id).map(({ file, ids, sha256 }) => ({ file, ids, sha256 })) };
    }) };
  await writeFile(join(here, 'text-review.json'), JSON.stringify(review, null, 2) + '\n');
}
const review = JSON.parse(await readFile(join(here, 'text-review.json')));
assert.equal(review.manifestSha256, hash, 'Recorded visual review is stale');
for (const bank of manifest.banks) {
  const r = review.banks.find(r => r.id === bank.id);
  assert(r, `Bank not reviewed: ${bank.id}`);
  for (const kind of ['questions', 'contexts']) {
    assert.deepEqual([...r[kind].withText].sort(), bank[kind].filter(i => i.text).map(i => i.id).sort());
    assert.deepEqual(r[kind].nullText.map(i => i.id).sort(), bank[kind].filter(i => !i.text).map(i => i.id).sort());
    assert(r[kind].nullText.every(i => i.reason));
  }
  const expected = [...bank.questions, ...bank.contexts].filter(i => i.text).map(i => i.id).sort();
  const checked = r.sheetsChecked.flatMap(s => s.ids).sort();
  assert.deepEqual(checked, expected, `Missing/duplicate visually reviewed text: ${bank.id}`);
  for (const sheet of r.sheetsChecked) assert(index.sheets.some(s => s.file === sheet.file && s.sha256 === sheet.sha256));
}
console.log(`Validated exhaustive visual-review coverage: ${review.banks.length} banks, ${index.sheets.length} checked sheets`);
