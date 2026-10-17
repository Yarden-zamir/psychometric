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
// The five read-only fixtures are deliberately outside this repository.
const source = '/tmp/psy-src/pdf';
const samples = files.length ? files.map(f => resolve(f)) :
  ['spring_2026', 'winter_2025', 'autumn_2025', 'summer_2025'].map(f => join(source, `psychometric_${f}_acc.pdf`))
    .concat('/tmp/psy-src/pub/psychometric_autumn_2020_td.pdf');
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
import io, json, sys
from pathlib import Path
import pymupdf
from PIL import Image
source, directory = sys.argv[1:]
directory = Path(directory)
data = json.loads((directory / 'regions.json').read_text())
pdf = pymupdf.open(source)
for q in data['contexts'] + data['questions']:
    scale = 2
    for attempt in range(24):
        images = []
        for part in q['parts']:
            page = pdf[part['page'] - 1]
            b = part['box']
            # PDF user space -> MuPDF top-left space, including page rotation.
            rect = pymupdf.Rect(b['x'], b['y'], b['x'] + b['width'], b['y'] + b['height'])
            rect = rect * page.transformation_matrix * page.rotation_matrix
            pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), clip=rect, alpha=False)
            images.append(Image.frombytes('RGB', (pix.width, pix.height), pix.samples))
        height = sum(im.height for im in images)
        if height > 8000:
            scale *= (8000 - len(images)) / height
            continue
        stacked = Image.new('RGB', (max(im.width for im in images), height), 'white')
        offset = 0
        for image in images:
            x = 0 if q['section'] == 'english' else stacked.width - image.width
            stacked.paste(image, (x, offset))
            offset += image.height
        encoded = io.BytesIO()
        stacked.save(encoded, format='PNG', optimize=True)
        if len(encoded.getvalue()) <= 1_000_000:
            (directory / (q['id'] + '.png')).write_bytes(encoded.getvalue())
            break
        scale *= 0.8
    else:
        raise RuntimeError(f"PNG inspection crop could not fit: {q['id']}")
    assert stacked.height <= 8000
    assert (directory / (q['id'] + '.png')).stat().st_size <= 1_000_000
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
  assert.equal(twoColumns.questions.length, 2);
  assert(twoColumns.questions.every(q => q.box.width < 300));
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
  assert.deepEqual(wrapped.questions.find(q => q.number === 1).parts.map(p => p.page), [1, 2], 'Wrapped choice must be stacked');
  const splitChoices = await findQuestions(mock([[header, heading, ...question(1, 140, 520, 2)],
    [header, item('(3) המשך', 400, 744), item('(4) סוף', 400, 720), ...question(2, 660)], key]));
  assert.equal(splitChoices.questions[0].parts.length, 2, 'Choices may cross a page');
  const columnWrap = await findQuestions(mock([[header, heading, ...question(1, 140, 520, 2),
    item('(3) המשך', 140, 740), item('(4) סוף', 140, 720), ...question(2, 660, 260)], key]));
  assert.deepEqual(columnWrap.questions[0].parts.map(p => p.page), [1, 1]);
  assert(columnWrap.questions[0].parts[0].box.x > columnWrap.questions[0].parts[1].box.x, 'Hebrew columns flow RTL');
  // Unsampled English chapters: exercise LTR numbering and shared passages.
  const englishHeader = 'English - Section 1';
  const englishKey = key.map(i => i.str === chapter ? { ...i, str: englishHeader } : i);
  const english = await findQuestions(mock([[item(englishHeader, 300, 805),
    item('Sentence Completions (1-8)', 100, 740, 14), ...question(1, 700, 70)], englishKey]));
  assert.equal(english.questions[0]?.section, 'english');
  const englishReading = await findQuestions(mock([[item(englishHeader, 300, 805),
    item('Reading Comprehension (1-8)', 100, 740, 14), ...question(1, 700, 70)], englishKey]));
  assert.equal(englishReading.questions.length, 0);
  const passagePages = [[header, item('הבנת הנקרא (שאלות 1-2)', 350, 740, 14),
    item('קראו בעיון את הקטע', 350, 710), item('(1) תחילת קטע קריאה לדוגמה', 200, 680)],
  [header, item('(5) המשך קטע הקריאה בעמוד הבא', 200, 740), item('השאלות', 400, 690, 14),
    ...question(1, 650), ...question(2, 480)]];
  const passage = await findQuestions(mock([...passagePages, key]));
  assert.equal(passage.contexts.length, 1);
  assert.equal(passage.contexts[0].kind, 'passage');
  assert.deepEqual(passage.contexts[0].parts.map(p => p.page), [1, 2]);
  assert(passage.contexts[0].parts[1].box.y > 700, 'Passage excludes question heading and stems');
  assert.deepEqual(passage.contexts[0].questionIds, ['verbal-1-1', 'verbal-1-2']);
  assert(passage.questions.every(q => q.context === passage.contexts[0].id));
  const chart = await findQuestions(mock([[header, item('הסקה מתרשים (שאלות 1-2)', 350, 740, 14),
    item('עיינו בתרשים ובטבלה שלפניכם', 200, 710), item('תיאור תרשים משותף', 200, 680),
    item('השאלות', 400, 610, 14), ...question(1, 570), ...question(2, 400)], key]));
  assert.equal(chart.contexts[0].kind, 'chart');
  assert(chart.questions.every(q => q.context === chart.contexts[0].id));
  const shortShared = await findQuestions(mock([normal, [header,
    item('שאלות 2-3 נוגעות לקטע הבא:', 350, 740, 11),
    item('תיאור משותף לשתי השאלות', 200, 710), ...question(2, 650), ...question(3, 480)], key]));
  assert.equal(shortShared.questions[0].parts.length, 1, 'A new shared intro is not continuation of the preceding question');
  assert.deepEqual(shortShared.contexts[0].questionIds, ['verbal-1-2', 'verbal-1-3']);
  const displaced = await findQuestions(mock([[header, item('הסקה מתרשים (שאלות 1-2)', 350, 740, 14),
    item('הסבר התרשים המשותף', 200, 710)], [header, item('B', 200, 740, 10),
    item('השאלות', 400, 740, 14), ...question(1, 690), ...question(2, 500)], key]));
  assert.deepEqual(displaced.contexts[0].parts.map(p => p.page), [1], 'Displaced labels must not hide the Questions boundary');
  const columnPassage = await findQuestions(mock([[header,
    item('הבנת הנקרא (שאלות 1-2)', 330, 740, 14),
    ...[700, 675, 650].map(y => item('מילים בקטע הקריאה הימני', 330, y)),
    ...[740, 715, 690].map(y => item('מילים בקטע הקריאה השמאלי', 70, y))],
    [header, item('השאלות', 400, 740, 14), ...question(1, 690), ...question(2, 500)], key]));
  assert.equal(columnPassage.contexts[0].parts.length, 2, 'Passages can cross columns even without question markers on the passage page');
  assert(columnPassage.contexts[0].parts[0].box.x > columnPassage.contexts[0].parts[1].box.x);
  // Canvas contract, translated crop transform, PNG fallback, and resource
  // cleanup, without relying on Node's native canvas implementation.
  await assert.rejects(renderQuestion({}, valid.questions[0]), /browser canvas/);
  const originalDocument = globalThis.document;
  let destroyed = false, rendered = 0, failContext = false, encodeMode = 'fallback';
  const encodings = [], draws = [], canvases = [];
  globalThis.document = { createElement: () => {
    const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {},
      drawImage: (part, x, y) => draws.push({ width: part.width, height: part.height, x, y }) }),
    toBlob: (callback, type, quality) => {
      encodings.push({ width: canvas.width, height: canvas.height, type, quality });
      const size = encodeMode === 'oversize' || encodeMode === 'quality' && quality > 0.55 ||
        encodeMode === 'scale' && canvas.width > 700 ? 1_000_001 : 3;
      callback(type === 'image/webp' && encodeMode === 'fallback' ? null : new Blob([new Uint8Array(size)], { type }));
    } };
    canvases.push(canvas); return canvas;
  } };
  const renderingDocument = mock([normal, key]);
  const getPage = renderingDocument.getPage;
  renderingDocument.getPage = async number => ({ ...await getPage(number),
    getViewport: ({ scale }) => ({ convertToViewportPoint: (x, y) => [x * scale, (840 - y) * scale] }),
    render: ({ transform }) => { assert.equal(transform.length, 6); rendered++;
      return { promise: failContext && number === 1 ? Promise.reject(new Error('synthetic canvas failure')) : Promise.resolve() }; },
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
    await assert.rejects(renderQuestion(renderingDocument, { id: 'invalid', page: 1, box: { x: -1, y: 0, width: 10, height: 10 } }), /invalid/);
    draws.length = 0;
    await renderQuestion(renderingDocument, { ...wrapped.questions[0] });
    assert.equal(draws.length, 2);
    assert.equal(draws[1].y, draws[0].height, 'Stacking must preserve order with no overlap');
    encodeMode = 'quality'; encodings.length = 0;
    assert((await renderQuestion(renderingDocument, valid.questions[0])).size <= 1_000_000);
    assert.deepEqual(encodings.map(e => e.quality), [0.85, 0.7, 0.55]);
    encodeMode = 'scale'; encodings.length = 0;
    await renderQuestion(renderingDocument, valid.questions[0]);
    assert(encodings.at(-1).width <= 700, 'Lower scale after exhausting quality');
    encodeMode = 'normal'; encodings.length = 0;
    await renderQuestion(renderingDocument, { id: 'tall', parts: Array.from({ length: 12 }, () => valid.questions[0].parts[0]) });
    assert(encodings.at(-1).height <= 8000, 'Stacked height must be capped');
    encodeMode = 'oversize';
    await assert.rejects(renderQuestion(renderingDocument, valid.questions[0]), /image-size-limit/);
    encodeMode = 'normal';
    const contextDoc = mock([...passagePages, key]);
    const contextGetPage = contextDoc.getPage;
    contextDoc.getPage = async n => ({ ...await contextGetPage(n),
      getViewport: ({ scale }) => ({ convertToViewportPoint: (x, y) => [x * scale, (840 - y) * scale] }),
      render: () => ({ promise: failContext && n === 1 ? Promise.reject(new Error('synthetic context failure')) : Promise.resolve() }) });
    const contextModule = { getDocument: () => ({ promise: Promise.resolve(contextDoc), destroy: async () => {} }) };
    const contextImported = await importPdf(new ArrayBuffer(0), null, contextModule);
    assert.equal(contextImported.contexts.length, 1);
    assert(contextImported.questions.every(q => contextImported.contexts.some(c => c.id === q.context && c.questionIds.includes(q.id))));
    failContext = true;
    const missing = await importPdf(new ArrayBuffer(0), null, contextModule);
    assert.equal(missing.questions.length, 0, 'Never return questions with a failed context');
    assert.equal(missing.contexts.length, 0);
    assert(getImportDiagnostics(contextDoc).skipped.some(s => s.reason === 'missing-context'));
    assert(canvases.every(c => c.width === 0 && c.height === 0), 'Release all canvases, including after failures');
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
  }
  console.log('Synthetic regressions: verified keys, partial choices, page/column stacks, passage/chart links and boundaries, PNG fallback, quality/scale/height limits, failed-context exclusion and cleanup passed.');
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
      assert.deepEqual({ page: question.page, box: question.box }, question.parts[0], 'Legacy aliases must refer to the first part');
      counts[`${question.section}-${question.chapter}`]++;
      distribution[question.answer]++;
    }
    for (const s of diagnostic.skipped) skipped[s.reason] = (skipped[s.reason] ?? 0) + 1;
    assert.equal(ids.size + diagnostic.skipped.length, diagnostic.answerCount, 'Every key entry must be accounted for');
    const contextIds = new Set(result.contexts.map(c => c.id));
    assert.equal(contextIds.size, result.contexts.length);
    for (const context of result.contexts) {
      assert(['passage', 'chart'].includes(context.kind));
      const linked = result.questions.filter(q => q.context === context.id);
      assert.deepEqual(context.questionIds, linked.map(q => q.id), 'Context links must be bidirectional and in test order');
      assert(linked.length > 0);
    }
    for (const q of result.questions) {
      assert(q.context === null || contextIds.has(q.context), `Missing context: ${q.id}`);
    }
    const regions = [...result.questions, ...result.contexts];
    for (const region of regions) {
      assert(region.parts.length > 0);
      for (const { page: number, box: b } of region.parts) {
        const page = await document.getPage(number);
        assert(b.x >= page.view[0] && b.y >= page.view[1] && b.width > 0 && b.height > 0);
        assert(b.x + b.width <= page.view[2] + 0.01 && b.y + b.height <= page.view[3] + 0.01);
      }
    }
    // Shared English instructions may appear in multiple contexts. Questions,
    // including every continuation part, must overlap neither another question
    // nor any context (especially passage/question boundaries).
    for (const q of result.questions) {
      for (const other of regions) {
        if (q === other) continue;
        for (const part of q.parts) for (const next of other.parts) {
          if (part.page !== next.page) continue;
          const vertical = Math.min(part.box.y + part.box.height, next.box.y + next.box.height) - Math.max(part.box.y, next.box.y);
          const horizontal = Math.min(part.box.x + part.box.width, next.box.x + next.box.width) - Math.max(part.box.x, next.box.x);
          assert(vertical <= 0 || horizontal <= 0, `Overlapping crops: ${q.id}, ${other.id}`);
        }
      }
    }
    for (const [id, answer] of Object.entries(expected[name] ?? {})) {
      const q = result.questions.find(q => q.id === id);
      assert(q, `Spot-check question missing: ${id}`);
      assert.equal(q.answer + 1, answer, `${name}: ${id} disagrees with printed key`);
    }
    console.log(`\n${name}: ${result.questions.length} kept / ${diagnostic.skipped.length} skipped (${diagnostic.answerCount} keyed)`);
    console.log('  Chapters:', JSON.stringify(counts));
    console.log('  Kept:', JSON.stringify({ standalone: result.questions.filter(q => !q.context).length,
      passage: result.questions.filter(q => q.context?.includes('-passage-')).length,
      chart: result.questions.filter(q => q.context?.includes('-chart-')).length }));
    console.log('  Skipped:', JSON.stringify(skipped));
    console.log('  Ignored:', JSON.stringify(diagnostic.ignored));
    console.log('  Contexts:', JSON.stringify({ passage: result.contexts.filter(c => c.kind === 'passage').length,
      chart: result.contexts.filter(c => c.kind === 'chart').length }));
    console.log('  Questions per context:', JSON.stringify(Object.fromEntries(result.contexts.map(c => [c.id, c.questionIds.length]))));
    console.log('  Context skips:', JSON.stringify(diagnostic.contextSkipped));
    console.log('  Stacked questions:', JSON.stringify(result.questions.filter(q => q.parts.length > 1).map(q => ({ id: q.id, pages: q.parts.map(p => p.page) }))));
    console.log('  Stacked contexts:', JSON.stringify(result.contexts.filter(c => c.parts.length > 1).map(c => ({ id: c.id, pages: c.parts.map(p => p.page) }))));
    console.log('  Answers (choices 1–4):', JSON.stringify(distribution));
    console.log('  Spot checks:', Object.entries(expected[name] ?? {}).filter(([, a]) => a).map(([id, a]) => `${id}=${a}`).join(', ') || '(no fixture expectations)');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'regions.json'), JSON.stringify({ ...result, diagnostics: diagnostic }, null, 2) + '\n');
    if (renderCrops) {
      // Do not leave crops from an earlier parser version looking like current
      // imports (e.g. a reading question that is now correctly excluded).
      for (const entry of await readdir(directory)) {
        if (/^(verbal|quantitative|english)-[12]-(?:(?:passage|chart)-)?\d+\.png$/.test(entry) &&
          !ids.has(basename(entry, '.png')) && !contextIds.has(basename(entry, '.png'))) {
          await unlink(join(directory, entry));
        }
      }
      const render = spawnSync('uv', ['run', '--with', 'pymupdf', '--with', 'pillow', '-', file, directory],
        { input: renderScript, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      if (render.error || render.status !== 0) throw new Error(`uv crop renderer failed: ${render.error?.message ?? render.stderr}`);
      console.log(`  PNG crops + key page: ${directory}`);
    }
  } finally { await loading.destroy(); }
}
