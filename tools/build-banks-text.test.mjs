import test from 'node:test';
import assert from 'node:assert/strict';
import { OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createTextExtractor, graphicsOf, lineText } from './build-banks-text.mjs';

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
