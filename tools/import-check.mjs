// npm install --prefix tools --package-lock=false
// node tools/import-check.mjs [--no-crops] [--out directory] [pdf ...]
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { findQuestions, getImportDiagnostics, importPdf, renderQuestion } from '../site/import.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const renderCrops = !args.includes('--no-crops');
const outIndex = args.indexOf('--out');
const output = outIndex < 0 ? join(here, 'crops') : resolve(args[outIndex + 1]);
const files = args.filter((arg, i) => !arg.startsWith('--') && !(outIndex >= 0 && i === outIndex + 1));
// The four read-only fixtures are deliberately outside this repository.
const source = '/tmp/psy-src/pdf';
const samples = files.length ? files.map(f => resolve(f)) :
  (await readdir(source)).filter(f => /^psychometric_(spring_2026|winter_2025|autumn_2025|summer_2025)_acc\.pdf$/.test(f))
    .sort().map(f => join(source, f));
assert(samples.length, 'No sample PDFs found. Pass PDF paths explicitly.');

// Independently transcribed from the printed answer-key pages (1-based).
// Each sample spans both domains and both chapters, including two-digit numbers.
const expected = {
  psychometric_spring_2026_acc: { 'verbal-1-1': 4, 'verbal-1-17': 3, 'verbal-2-12': 3, 'quantitative-1-20': 2, 'quantitative-2-20': 1 },
  psychometric_autumn_2025_acc: { 'verbal-1-1': 1, 'verbal-1-17': 4, 'verbal-2-12': 4, 'quantitative-1-20': 4, 'quantitative-2-20': 1 },
  psychometric_summer_2025_acc: { 'verbal-1-1': 3, 'verbal-1-17': 2, 'verbal-2-12': 2, 'quantitative-1-20': 1, 'quantitative-2-16': 1 },
  psychometric_winter_2025_acc: { 'verbal-1-1': 2, 'verbal-1-17': 1, 'verbal-2-12': 4, 'quantitative-1-20': 1, 'quantitative-2-16': 1 },
};

// Embedded instead of creating a fourth source file. @napi-rs/canvas + Node 26
// can segfault on these fonts; keep PDF parsing in JS and render the JSON boxes
// with an isolated uv environment. Neither python nor pip is called directly.
const renderScript = String.raw`
import json, sys
from pathlib import Path
import pymupdf
source, directory = sys.argv[1:]
directory = Path(directory)
data = json.loads((directory / 'regions.json').read_text())
pdf = pymupdf.open(source)
for q in data['questions']:
    page = pdf[q['page'] - 1]
    b = q['box']
    # PDF user space -> MuPDF top-left space, then account for page rotation.
    rect = pymupdf.Rect(b['x'], b['y'], b['x'] + b['width'], b['y'] + b['height'])
    rect = rect * page.transformation_matrix * page.rotation_matrix
    page.get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5), clip=rect, alpha=False).save(directory / (q['id'] + '.png'))
for number in sorted({e['page'] for e in data['diagnostics']['answerKey']}):
    pdf[number - 1].get_pixmap(matrix=pymupdf.Matrix(1.5, 1.5)).save(directory / f'answer-key-page-{number}.png')
`;

async function selfTest() {
  const item = (str, x, y, size = 11) => ({ str, width: str.length * size * 0.45,
    height: size, fontName: 'f', transform: [size, 0, 0, size, x, y] });
  const chapter = 'חשיבה מילולית - פרק ראשון';
  const question = (number, y, x = 520, choices = 4) => [item(`${number}.`, x, y, 14),
    item('שאלה לדוגמה', x < 100 ? x + 28 : x - 160, y), ...Array.from({ length: choices }, (_, n) =>
      item(`(${n + 1}) תשובה`, x < 100 ? x + 28 : x - 120, y - 30 - n * 18))];
  const key = [item('מפתח תשובות נכונות', 100, 790, 30), item(chapter, 340, 700, 13),
    ...Array.from({ length: 8 }, (_, i) => item(String(i + 1), 490 - i * 24, 675, 10)),
    ...Array.from({ length: 8 }, (_, i) => item(String(i % 4 + 1), 490 - i * 24, 650, 10))];
  const mock = pageItems => ({ numPages: pageItems.length, getPage: async number => ({
    view: [0, 0, 600, 840], getTextContent: async () => ({ items: pageItems[number - 1],
      styles: { f: { ascent: 0.8, descent: -0.25 } } }),
  }) });
  const header = item(chapter, 350, 805);
  const heading = item('אנלוגיות (שאלות 1-8)', 350, 740, 14);
  const normal = [header, heading, ...question(1, 700)];
  const valid = await findQuestions(mock([normal, key]));
  assert.equal(valid.questions.length, 1);
  assert.equal(valid.questions[0].answer, 0);
  await assert.rejects(findQuestions(mock([normal])), /answer key/i);
  await assert.rejects(findQuestions(mock([[], key])), /chapters not found/i);
  const noFourth = await findQuestions(mock([[header, heading, ...question(1, 700, 520, 3)], key]));
  assert.equal(noFourth.questions.length, 0);
  const twoColumns = await findQuestions(mock([[header, heading, ...question(1, 700), ...question(2, 700, 260)], key]));
  assert.equal(twoColumns.questions.length, 0);
  const shared = await findQuestions(mock([[header, item('קטעי קריאה', 400, 750, 14),
    item('קטע א (שאלות 1-8)', 350, 720, 14), ...question(1, 680)], key]));
  assert.equal(shared.questions.length, 0);
  const instructions = await findQuestions(mock([[...normal, item('הוראות לשאלות 2-8:', 350, 550, 11),
    item('הוראות שאינן חלק מהשאלה הקודמת', 200, 530), ...question(2, 490)], key]));
  assert(instructions.questions[0].box.y > 558, 'Crop must end before the next instruction block');
  const grid = await findQuestions(mock([[header, heading, item('1.', 520, 700, 14), item('בחרו סרטוט', 300, 700),
    item('(1)', 490, 650), item('(2)', 260, 650), item('(3)', 490, 500), item('(4)', 260, 500),
    item('x', 200, 420, 10), ...question(2, 370)], key]));
  assert(grid.questions[0].box.y < 410, 'Graphical options below their labels must not be trimmed');
  const unkeyed = await findQuestions(mock([[header, heading, ...question(9, 700)], key]));
  assert.equal(unkeyed.questions.length, 0);
  const wrapped = await findQuestions(mock([normal, [header, item('המשך התשובה מהעמוד הקודם', 200, 744), ...question(2, 660)], key]));
  assert(!wrapped.questions.some(q => q.number === 1), 'Wrapped choice must not be imported');
  // Unsampled English chapters: exercise LTR numbering and shared passages.
  const englishHeader = 'English - Section 1';
  const englishKey = key.map(i => i.str === chapter ? { ...i, str: englishHeader } : i);
  const english = await findQuestions(mock([[item(englishHeader, 300, 805),
    item('Sentence Completions (1-8)', 100, 740, 14), ...question(1, 700, 70)], englishKey]));
  assert.equal(english.questions[0]?.section, 'english');
  const englishReading = await findQuestions(mock([[item(englishHeader, 300, 805),
    item('Reading Comprehension (1-8)', 100, 740, 14), ...question(1, 700, 70)], englishKey]));
  assert.equal(englishReading.questions.length, 0);
  // Canvas contract, translated crop transform, PNG fallback, and resource
  // cleanup, without relying on Node's native canvas implementation.
  await assert.rejects(renderQuestion({}, valid.questions[0]), /browser canvas/);
  const originalDocument = globalThis.document;
  let destroyed = false, rendered = 0;
  globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}),
    toBlob: (callback, type) => callback(type === 'image/webp' ? null : new Blob(['png'], { type })) }) };
  const renderingDocument = mock([normal, key]);
  const getPage = renderingDocument.getPage;
  renderingDocument.getPage = async number => ({ ...await getPage(number),
    getViewport: ({ scale }) => ({ convertToViewportPoint: (x, y) => [x * scale, (840 - y) * scale] }),
    render: ({ transform }) => { assert.equal(transform.length, 6); rendered++; return { promise: Promise.resolve() }; },
  });
  const progress = [];
  try {
    const imported = await importPdf(new ArrayBuffer(0), p => progress.push(p), {
      getDocument: () => ({ promise: Promise.resolve(renderingDocument), destroy: async () => { destroyed = true; } }),
    });
    assert.equal(imported.questions[0].image.type, 'image/png');
    assert.equal(rendered, 1);
    assert(destroyed);
    assert.equal(progress.at(-1).phase, 'render');
    await assert.rejects(renderQuestion(renderingDocument, { ...valid.questions[0], box: { x: -1, y: 0, width: 10, height: 10 } }), /invalid/);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
  console.log('Synthetic regressions: key/chapter errors, verified answers, partial/wrapped/column questions, Hebrew/English passages, injection and PNG fallback passed.');
}

await selfTest();

for (const file of samples) {
  const name = basename(file, '.pdf'), directory = join(output, name);
  const loading = getDocument({ data: new Uint8Array(await readFile(file)),
    standardFontDataUrl: join(here, 'node_modules/pdfjs-dist/standard_fonts/'),
    cMapUrl: join(here, 'node_modules/pdfjs-dist/cmaps/'), cMapPacked: true,
    wasmUrl: join(here, 'node_modules/pdfjs-dist/wasm/') });
  try {
    const document = await loading.promise;
    const result = await findQuestions(document);
    const diagnostic = getImportDiagnostics(document);
    const counts = {}, skipped = {}, distribution = [0, 0, 0, 0];
    for (const section of ['verbal', 'quantitative', 'english']) {
      for (const chapter of [1, 2]) counts[`${section}-${chapter}`] = 0;
    }
    const ids = new Set();
    for (const question of result.questions) {
      assert(!ids.has(question.id), `Duplicate ${question.id}`);
      ids.add(question.id);
      assert([0, 1, 2, 3].includes(question.answer), `Invalid answer ${question.id}`);
      assert(diagnostic.answerKey.some(e => e.id === question.id && e.value === question.answer + 1), `Unverified ${question.id}`);
      const page = await document.getPage(question.page), b = question.box;
      assert(b.x >= page.view[0] && b.y >= page.view[1] && b.width > 0 && b.height > 0);
      assert(b.x + b.width <= page.view[2] && b.y + b.height <= page.view[3]);
      counts[`${question.section}-${question.chapter}`]++;
      distribution[question.answer]++;
    }
    for (const s of diagnostic.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
    assert.equal(ids.size + diagnostic.skipped.length, diagnostic.answerCount, 'Every key entry must be accounted for');
    for (const q of result.questions) {
      for (const other of result.questions) {
        if (q === other || q.page !== other.page) continue;
        const vertical = Math.min(q.box.y + q.box.height, other.box.y + other.box.height) - Math.max(q.box.y, other.box.y);
        const horizontal = Math.min(q.box.x + q.box.width, other.box.x + other.box.width) - Math.max(q.box.x, other.box.x);
        assert(vertical <= 0 || horizontal <= 0, `Overlapping crops: ${q.id}, ${other.id}`);
      }
    }
    for (const [id, answer] of Object.entries(expected[name] ?? {})) {
      const q = result.questions.find(q => q.id === id);
      assert(q, `Spot-check question missing: ${id}`);
      assert.equal(q.answer + 1, answer, `${name}: ${id} disagrees with printed key`);
    }
    console.log(`\n${name}: ${result.questions.length} kept / ${diagnostic.skipped.length} skipped (${diagnostic.answerCount} keyed)`);
    console.log('  Chapters:', JSON.stringify(counts));
    console.log('  Skipped:', JSON.stringify(skipped));
    console.log('  Answers (choices 1–4):', JSON.stringify(distribution));
    console.log('  Spot checks:', Object.entries(expected[name] ?? {}).filter(([, a]) => a).map(([id, a]) => `${id}=${a}`).join(', ') || '(no fixture expectations)');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'regions.json'), JSON.stringify({ ...result, diagnostics: diagnostic }, null, 2) + '\n');
    if (renderCrops) {
      // Do not leave crops from an earlier parser version looking like current
      // imports (e.g. a reading question that is now correctly excluded).
      for (const entry of await readdir(directory)) {
        if (/^(verbal|quantitative|english)-[12]-\d+\.png$/.test(entry) && !ids.has(basename(entry, '.png'))) {
          await unlink(join(directory, entry));
        }
      }
      const render = spawnSync('uv', ['run', '--with', 'pymupdf', '-', file, directory],
        { input: renderScript, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (render.error || render.status !== 0) throw new Error(`uv crop renderer failed: ${render.error?.message ?? render.stderr}`);
      console.log(`  PNG crops + key page: ${directory}`);
    }
  } finally { await loading.destroy(); }
}
