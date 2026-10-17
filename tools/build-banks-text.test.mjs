import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createTextExtractor, graphicsOf, lineText, isNiteWatermark, NITE_WATERMARK } from './build-banks-text.mjs';

const item = (str, x, y, width = str.length * 5) => ({ str, width, height: 11,
  transform: [11, 0, 0, 11, x, y], fontName: 'test' });
const region = { id: 'english-1-1', section: 'english', number: 1,
  parts: [{ page: 1, box: { x: 0, y: 0, width: 500, height: 500 } }] };
const question = () => [item('1.', 10, 450), item('A sentence', 50, 450),
  item('Another paragraph.', 50, 420),
  ...[1, 2, 3, 4].map((n, i) => item(`(${n}) choice ${n}`, 50, 380 - i * 20))];
async function extract(items, ops = [], r = region) {
  const fn = createTextExtractor({ getPage: async () => ({
    getTextContent: async () => ({ items, styles: { test: { ascent: 0.8, descent: -0.2 } } }),
    getOperatorList: async () => ({ fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) }),
  }) });
  return fn(r);
}

test('number removal, four markers and paragraph breaks', async () => {
  const { text, reason } = await extract(question());
  assert.equal(reason, null);
  assert.equal(text.stem, 'A sentence\nAnother paragraph.');
  assert.deepEqual(text.choices, ['choice 1', 'choice 2', 'choice 3', 'choice 4']);
});
test('duplicate/out-of-order markers fail closed', async () => {
  const items = question(); items[5].str = '(1) repeated';
  assert.equal((await extract(items)).text, null);
});
test('choices differing only in visual emphasis must keep their image', async () => {
  const items = question();
  for (let i = 3; i < 7; i++) items[i].str = `(${i - 2}) same sentence`;
  assert.equal((await extract(items)).reason, 'choices-differ-only-in-formatting');
});
test('wrapped choice joins; preserve Unicode niqqud and punctuation', async () => {
  const items = question(); items.push(item('שָׁלוֹם ״א״', 50, 368));
  const { text } = await extract(items);
  assert.equal(text.choices[0], 'choice 1 שָׁלוֹם ״א״');
});
const path = (x, y, w = 25) => [OPS.constructPath, [OPS.stroke,
  [new Float32Array([0, x, y, 1, x + w, y])], new Float32Array([x, y, x + w, y])]];
test('two horizontal gaps become blanks, including a terminal blank', async () => {
  const items = question(); items[1] = item('A', 50, 450, 10); items.push(item('B', 100, 450, 10));
  const { text } = await extract(items, [path(65, 448), path(115, 448)]);
  assert.equal(text.stem, 'A ______ B ______\nAnother paragraph.');
});
test('images and non-blank vector strokes always fall back', async () => {
  assert.equal((await extract(question(), [[OPS.paintImageXObject, ['image', 1, 1]]])).text, null);
  assert.equal((await extract(question(), [path(50, 449)])).text, null);
});
test('only the known watermark pixels AND original placement are eligible', () => {
  const graphic = { kind: 'image', imageId: 'page-local-resource', matrix: [...NITE_WATERMARK.matrix] };
  const image = { kind: 2, width: 1090, height: 1650 };
  const check = (g = graphic, v = NITE_WATERMARK.page, im = image, hash = NITE_WATERMARK.sha256) => isNiteWatermark(g, v, im, hash);
  assert.equal(check(), true);
  assert.equal(check({ ...graphic, imageId: 'different-resource-same-pixels' }), true);
  assert.equal(check(graphic, NITE_WATERMARK.page, image, 'another-pale-image'), false);
  assert.equal(check({ ...graphic, matrix: [10, 0, 0, 10, 20, 20] }), false);
  assert.equal(check({ ...graphic, matrix: [-278.0777, 0, 0, 420.9433, 436.6763, 210.4725] }), false);
  assert.equal(check({ ...graphic, imageId: undefined }), false);
  assert.equal(check(graphic, [0, 0, 600, 850]), false);
  assert.equal(check(graphic, NITE_WATERMARK.page, { ...image, kind: 3 }), false);
  assert.equal(check(graphic, NITE_WATERMARK.page, { ...image, width: 100 }), false);
});
test('repeated pale image with the right geometry but different pixels is rejected', async () => {
  const ops = { fnArray: [OPS.transform, OPS.paintImageXObject], argsArray: [[...NITE_WATERMARK.matrix], ['image', 1090, 1650]] };
  const fn = createTextExtractor({ numPages: 12, getPage: async () => ({
    view: NITE_WATERMARK.page,
    objs: { get: (_, resolve) => resolve({ kind: 2, width: 1090, height: 1650, data: new Uint8Array(1090 * 1650 * 3).fill(250) }) },
    getTextContent: async () => ({ items: question(), styles: {} }), getOperatorList: async () => ops,
  }) });
  assert.equal((await fn(region)).reason, 'graphic-image');
  assert.equal(await fn.watermarkEvidence(), null);
});
test('real watermark: ten distinct pages required; other images and vectors still reject', async t => {
  // Optional read-only public fixture; no NITE pixels/text are committed.
  let bytes;
  try { bytes = await readFile(new URL('../../_shared/nite-public/psychometric_autumn_2020_td.pdf', import.meta.url)); }
  catch (error) { if (error.code === 'ENOENT') return t.skip('Public PDF fixture not installed'); throw error; }
  const loading = getDocument({ data: new Uint8Array(bytes) });
  try {
    const page = await (await loading.promise).getPage(3), list = await page.getOperatorList();
    const graphic = graphicsOf(list).find(g => g.imageId);
    const image = await new Promise(resolve => page.objs.get(graphic.imageId, resolve));
    const watermark = [[OPS.save, []], [OPS.transform, NITE_WATERMARK.matrix],
      [OPS.paintImageXObject, ['known', 1090, 1650]], [OPS.restore, []]];
    async function run(numPages, extra = [], copies = 1) {
      const ops = [...Array.from({ length: copies }, () => watermark).flat(), ...extra];
      const fn = createTextExtractor({ numPages, getPage: async () => ({
        view: page.view, objs: { get: (_, resolve) => resolve(image) },
        getTextContent: async () => ({ items: question(), styles: {} }),
        getOperatorList: async () => ({ fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) }),
      }) });
      return { result: await fn(region), evidence: await fn.watermarkEvidence() };
    }
    assert.equal((await run(9)).result.reason, 'graphic-image');
    assert.equal((await run(1, [], 10)).result.reason, 'graphic-image');
    const accepted = await run(10);
    assert(accepted.result.text);
    assert.equal(accepted.evidence.pages.length, 10);
    assert.equal(accepted.evidence.sha256, NITE_WATERMARK.sha256);
    assert.equal((await run(10, [[OPS.paintImageXObject, ['other', 1, 1]]])).result.reason, 'graphic-image');
    assert.equal((await run(10, [path(50, 449)])).result.reason, 'non-blank-horizontal-line');
  } finally { await loading.destroy(); }
});
test('graphics follow nested form and save/transform matrices', () => {
  const ops = [[OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 40, 50], null]],
    [OPS.save, []], [OPS.transform, [2, 0, 0, 2, 10, 20]], path(0, 0),
    [OPS.restore, []], [OPS.paintFormXObjectEnd, []]];
  const [g] = graphicsOf({ fnArray: ops.map(o => o[0]), argsArray: ops.map(o => o[1]) });
  assert.deepEqual(g.box, [50, 70, 100, 70]);
});
test('bad controls, small math labels, rotated or clipped text fail closed', async () => {
  for (const bad of [item('\u001a', 100, 450), { ...item('2', 100, 450), transform: [6, 0, 0, 6, 100, 450] },
    { ...item('label', 100, 450), transform: [0, 11, -11, 0, 100, 450] }, item('outside', 490, 450)]) {
    assert.equal((await extract([...question(), bad])).text, null);
  }
});
test('RTL fragments join touching niqqud spans without changing characters', () => {
  assert.equal(lineText([{ text: 'דָגֵרֹוטִי', raw: 'דָגֵרֹוטִי', x: 100, width: 45 },
    { text: 'ּפ', raw: 'ּפ', x: 95, width: 5 }, { text: 'ים', raw: 'ים', x: 85, width: 10 }], 'rtl'), 'דָגֵרֹוטִיּפים');
});
test('neutral LTR punctuation follows enclosing RTL reading order', () => {
  assert.equal(lineText([{ text: '?)', raw: '?)', dir: 'ltr', x: 10, width: 5 },
    { text: '5', raw: '5', dir: 'ltr', x: 15, width: 5 },
    { text: 'שורה', raw: 'שורה ', dir: 'rtl', x: 23, width: 20 }], 'rtl'), 'שורה 5)?');
});
test('embedded Latin runs keep LTR order across font spans', () => {
  const part = (text, x, width, dir = 'ltr') => ({ text, raw: text, x, width, dir, size: 11 });
  assert.equal(lineText([part('K', 10, 7), part('/', 17, 3), part('T', 20, 6),
    part('תקופה', 30, 30, 'rtl')], 'rtl'), 'תקופה K/T');
});
test('passage lines retain line numbers separately and paragraphs', async () => {
  const items = [item('Text I', 50, 470), item('(1)', 10, 430, 15), item('First line', 50, 430),
    item('Second line', 50, 415), item('New paragraph', 50, 390), item('(5)', 10, 375, 15), item('Last line', 50, 375)];
  const { text } = await extract(items, [], { ...region, kind: 'passage' });
  assert.equal(text.title, 'Text I');
  assert.deepEqual(text.lines, [{ n: 1, text: 'First line' }, { n: null, text: 'Second line' },
    { n: null, text: '' }, { n: null, text: 'New paragraph' }, { n: 5, text: 'Last line' }]);
});
test('quantitative questions and charts never use text', async () => {
  assert.equal((await extract(question(), [], { ...region, section: 'quantitative' })).reason, 'quantitative-image-only');
  assert.equal((await extract(question(), [], { ...region, kind: 'chart' })).reason, 'chart-image-only');
});
