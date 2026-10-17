// Conservative, read-only extraction from pdf.js text AND drawing operators.
// Never normalize Unicode: Hebrew points and punctuation belong to the source.
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

const space = s => s.replace(/\s+/gu, ' ').trim();
const fail = reason => { throw new Error(reason); };
const intersects = (a, b) => a[0] < b[2] - 0.1 && a[2] > b[0] + 0.1 &&
  a[1] <= b[3] && a[3] >= b[1];
const bounds = (m, b) => {
  const points = [[b[0], b[1]], [b[0], b[3]], [b[2], b[1]], [b[2], b[3]]]
    .map(p => { Util.applyTransform(p, m); return p; });
  return [Math.min(...points.map(p => p[0])), Math.min(...points.map(p => p[1])),
    Math.max(...points.map(p => p[0])), Math.max(...points.map(p => p[1]))];
};

// pdf.js 6 constructPath contains the paint operation, DrawOPS and local bbox.
// Walk q/Q, cm and form matrices, not just raw coordinates. Unknown paint
// operators fail closed. Clipping is not painting; ignoring it over-rejects,
// rather than accidentally allowing a graphic.
export function graphicsOf(list) {
  let matrix = [1, 0, 0, 1, 0, 0], width = 1;
  const stack = [], graphics = [];
  const save = () => stack.push({ matrix: [...matrix], width });
  const restore = () => {
    if (!stack.length) fail('unbalanced-graphics-state');
    ({ matrix, width } = stack.pop());
  };
  for (let i = 0; i < list.fnArray.length; i++) {
    const op = list.fnArray[i], args = list.argsArray[i];
    if (op === OPS.save) save();
    else if (op === OPS.restore) restore();
    else if (op === OPS.transform) matrix = Util.transform(matrix, args);
    else if (op === OPS.setLineWidth) width = args[0];
    else if (op === OPS.paintFormXObjectBegin) {
      save();
      if (args[0]) matrix = Util.transform(matrix, args[0]);
    } else if (op === OPS.paintFormXObjectEnd) restore();
    else if (op === OPS.beginGroup) {
      save();
      if (args[0]?.matrix) matrix = Util.transform(matrix, args[0].matrix);
    } else if (op === OPS.endGroup) restore();
    else if (op === OPS.constructPath) {
      const [paint, data, box] = args;
      if (paint === OPS.endPath) continue;
      if (!box) { graphics.push({ box: [-Infinity, -Infinity, Infinity, Infinity], kind: 'unknown-path' }); continue; }
      const path = data[0], b = bounds(matrix, box);
      // Exactly one moveTo/lineTo pair, stroked, horizontal in page space.
      const horizontal = paint === OPS.stroke && path?.length === 6 && path[0] === 0 && path[3] === 1 &&
        b[3] - b[1] < 0.15 && width * Math.hypot(matrix[2], matrix[3]) <= 1.5;
      graphics.push({ box: b, kind: horizontal ? 'horizontal' : 'vector' });
    } else if (Object.keys(OPS).some(k => OPS[k] === op && /^(?:paint.*Image|shadingFill)/.test(k))) {
      // Normal image XObjects paint the unit square. Repeated/mask/grouped image
      // operators have additional transforms; conservatively reject the page.
      const simple = [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(op);
      graphics.push({ box: simple ? bounds(matrix, [0, 0, 1, 1]) : [-Infinity, -Infinity, Infinity, Infinity], kind: 'image' });
    } else if ([OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke,
      OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op)) {
      graphics.push({ box: [-Infinity, -Infinity, Infinity, Infinity], kind: 'unknown-paint' });
    } else if (op === OPS.setTextRenderingMode && args[0] !== 0) {
      // Outlined/clipping text is not represented faithfully by plain strings.
      graphics.push({ box: [-Infinity, -Infinity, Infinity, Infinity], kind: 'non-fill-text' });
    }
  }
  return graphics;
}

function linesOf(items) {
  const lines = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    let line = lines.find(l => Math.abs(l.y - item.y) < 1.8);
    if (!line) { line = { y: item.y, size: item.size, items: [], part: item.part }; lines.push(line); }
    line.items.push(item);
  }
  return lines.sort((a, b) => b.y - a.y);
}

// Geometric ordering only between spans. Each span's str is already logical
// Unicode, including bidi text; never reverse its characters.
export function lineText(items, dir) {
  let spans = [...items];
  if (dir === 'rtl') {
    // Latin words can be split by font/style into several LTR spans (K / T,
    // or a multiword name). Keep their internal left-to-right order as one run;
    // only the placement of that run belongs to the enclosing Hebrew flow.
    const physical = spans.sort((a, b) => a.x - b.x), runs = [];
    for (let i = 0; i < physical.length;) {
      let end = i + 1;
      if (physical[i].dir === 'ltr') while (end < physical.length && physical[end].dir === 'ltr' &&
        physical[end].x - physical[end - 1].x - physical[end - 1].width < physical[end].size * 0.8) end++;
      const latin = physical.slice(i, end).map((s, n) => /[A-Za-z]/u.test(s.text) ? i + n : -1).filter(n => n >= 0);
      if (latin.length > 1) {
        const start = latin[0], last = latin.at(-1), parts = physical.slice(start, last + 1);
        runs.push(...physical.slice(i, start));
        const text = lineText(parts, 'ltr');
        runs.push({ ...parts[0], text, raw: text, width: parts.at(-1).x + parts.at(-1).width - parts[0].x });
        runs.push(...physical.slice(last + 1, end));
      } else runs.push(...physical.slice(i, end));
      i = end;
    }
    spans = runs;
  }
  const sorted = spans.sort((a, b) => dir === 'rtl' ? b.x - a.x : a.x - b.x);
  let text = '';
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i], prev = sorted[i - 1];
    const gap = prev && (dir === 'rtl' ? prev.x - item.x - item.width : item.x - prev.x - prev.width);
    // Neutral-only LTR spans are in physical order (e.g. the final '?)'
    // after a parenthesized Hebrew line reference). Order their glyphs in the
    // enclosing RTL flow, otherwise the browser displays the question mark
    // inside the parentheses. Letters, numbers and combining marks are NEVER
    // reversed or Unicode-normalized.
    const value = dir === 'rtl' && item.dir === 'ltr' && /^[\p{P}\p{S}]+$/u.test(item.text)
      ? [...item.text].reverse().join('') : item.text;
    text += (prev && (gap > 0.7 || /\s$/u.test(prev.raw) || /^\s/u.test(item.raw)) ? ' ' : '') + value;
  }
  return space(text);
}

function markerize(items) {
  const markers = [], rest = [];
  const used = new Set();
  for (const item of items) {
    const match = item.text.match(/^\(([1-9]\d*)\)$|^\)([1-9]\d*)\($/);
    const prefix = item.text.match(/^\(([1-4])\)\s+(.+)$/u);
    if (match) { markers.push({ n: +(match[1] ?? match[2]), x: item.x, width: item.width, y: item.y }); used.add(item); }
    else if (prefix) {
      markers.push({ n: +prefix[1], x: item.x, width: 16, y: item.y });
      rest.push({ ...item, x: item.x + 16, width: item.width - 16, text: prefix[2], raw: prefix[2] });
      used.add(item);
    } else if (/^\d{1,2}$/.test(item.text)) {
      const peers = items.filter(p => Math.abs(p.y - item.y) < 0.6);
      const left = peers.filter(p => /^[()]$/.test(p.text) && Math.abs(p.x + p.width - item.x) < 1.5);
      const right = peers.filter(p => /^[()]$/.test(p.text) && Math.abs(item.x + item.width - p.x) < 1.5);
      if (left.length === 1 && right.length === 1 && left[0].text !== right[0].text) {
        markers.push({ n: +item.text, x: left[0].x, width: right[0].x + right[0].width - left[0].x, y: item.y });
        [left[0], item, right[0]].forEach(p => used.add(p));
      }
    }
  }
  return { markers, items: [...items.filter(i => !used.has(i)), ...rest] };
}

function paragraphs(lines, dir) {
  let text = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], prev = lines[i - 1];
    const paragraph = prev && line.part === prev.part && prev.y - line.y > Math.max(line.size, prev.size) * 1.4;
    text += (i ? paragraph ? '\n' : ' ' : '') + lineText(line.items, dir);
  }
  return text.trim();
}

export function createTextExtractor(document) {
  const cache = new Map();
  async function pageData(n) {
    if (!cache.has(n)) cache.set(n, (async () => {
      const page = await document.getPage(n), content = await page.getTextContent();
      const items = content.items.filter(i => typeof i.str === 'string' && space(i.str)).map(i => {
        const size = Math.hypot(i.transform[2], i.transform[3]) || i.height;
        const style = content.styles[i.fontName] ?? {};
        return { text: space(i.str), raw: i.str, dir: i.dir, x: i.transform[4], y: i.transform[5], width: i.width, size,
          rotated: Math.abs(i.transform[1]) > 0.01 || Math.abs(i.transform[2]) > 0.01,
          top: i.transform[5] + size * (style.ascent ?? 0.9), bottom: i.transform[5] + size * (style.descent ?? -0.25) };
      });
      return { items, graphics: graphicsOf(await page.getOperatorList()) };
    })());
    return cache.get(n);
  }
  async function regionLines(region, dir) {
    const all = [], seen = new Set();
    for (let part = 0; part < region.parts.length; part++) {
      const { page: n, box: b } = region.parts[part], page = await pageData(n);
      if (part) {
        const previous = region.parts[part - 1];
        // A passage can prepend the shared English instructions from an earlier
        // page. Question continuations must remain adjacent pages/columns.
        if (n < previous.page || region.kind !== 'passage' && n > previous.page + 1) fail('unorderable-parts');
        if (n === previous.page && Math.abs(b.x - previous.box.x) > 2 &&
          (dir === 'rtl' ? b.x >= previous.box.x : b.x <= previous.box.x)) fail('unorderable-columns');
      }
      const box = [b.x, b.y, b.x + b.width, b.y + b.height];
      const items = page.items.filter(i => intersects([i.x, i.bottom, i.x + Math.max(i.width, 0.1), i.top], box));
      for (const item of items) {
        if (seen.has(item)) fail('overlapping-parts');
        seen.add(item);
        if (item.rotated || item.size < 8 || item.size > 18 || /[\u0000-\u0008\u000e-\u001f\ufffd]/u.test(item.text)) fail('unplaceable-text-item');
        if (item.x < b.x - 1 || item.x + item.width > b.x + b.width + 1 || item.y < b.y || item.y > b.y + b.height) fail('clipped-text-item');
      }
      const lines = linesOf(items.map(i => ({ ...i, part })));
      for (const graphic of page.graphics.filter(g => intersects(g.box, box))) {
        const g = graphic.box, w = g[2] - g[0];
        if (graphic.kind !== 'horizontal' || w < 12 || w > 90) fail(`graphic-${graphic.kind}`);
        const line = lines.find(l => l.y - g[1] >= -0.3 && l.y - g[1] <= 4);
        if (!line || line.items.some(i => Math.min(i.x + i.width, g[2]) - Math.max(i.x, g[0]) > 1)) fail('non-blank-horizontal-line');
        // A blank must occupy empty horizontal space beside text on a baseline.
        line.items.push({ text: '______', raw: '______', x: g[0], width: w, y: line.y, size: line.size, part, blank: true });
      }
      all.push(...lines);
    }
    if (!all.length) fail('empty-region');
    return all;
  }
  return async function extract(region) {
    if (region.section === 'quantitative' || region.kind === 'chart') return { text: null, reason: region.kind === 'chart' ? 'chart-image-only' : 'quantitative-image-only' };
    const dir = region.section === 'english' ? 'ltr' : 'rtl';
    try {
      const lines = await regionLines(region, dir);
      if (region.kind === 'passage') {
        const passage = [], instructions = [];
        let title = null, started = false, previous = null, lastNumber = 0;
        for (const line of lines) {
          const raw = lineText(line.items, dir);
          if (!started && /^Reading Comprehension$/i.test(raw)) continue;
          if (!started && /^(?:Text\s+[IVX]+|קטע קריאה)/u.test(raw)) {
            const heading = raw.match(/^(Text\s+[IVX]+|קטע קריאה)/u)[1];
            if (title) fail('multiple-passage-headings');
            title = heading;
            continue;
          }
          if (!started && (/קראו בעיון|נוגעות לקטע הבא|מתייחסות לקטע הבא/u.test(raw) ||
            /^This part consists|^question,?\s|^Read the following/i.test(raw))) {
            instructions.push(raw); continue;
          }
          started = true;
          const { markers, items } = markerize(line.items);
          // Margin position, not the mere occurrence of '(5)', identifies a
          // printed line number. Parenthesized numbers in the body stay intact.
          const margin = markers.filter(m => dir === 'rtl'
            ? items.every(i => i.x + i.width < m.x - 5)
            : items.every(i => i.x > m.x + m.width + 5));
          if (margin.length > 1) fail('ambiguous-margin-number');
          let n = null, body = line.items;
          if (margin.length) {
            const m = margin[0]; n = m.n;
            if (n !== 1 && n % 5 !== 0 || n <= lastNumber) fail('invalid-margin-sequence');
            lastNumber = n;
            // markerize consumes every marker; only accept one marker on this
            // row, or use the image rather than silently deleting body text.
            if (markers.length !== 1) fail('ambiguous-parenthesized-body-number');
            body = items;
          }
          const text = lineText(body, dir);
          if (!text) fail('empty-passage-line');
          if (previous && line.part === previous.part && previous.y - line.y > Math.max(line.size, previous.size) * 1.4)
            passage.push({ n: null, text: '' });
          passage.push({ n, text }); previous = line;
        }
        if (!passage.length) fail('empty-passage');
        return { text: { dir, title, instructions: instructions.length ? instructions.join(' ') : null, lines: passage }, reason: null };
      }
      // Remove precisely the printed number (one combined span or number + dot).
      const first = lines[0], printed = first.items.filter(i => new RegExp(`^(?:${region.number}\\.|\\.${region.number})$`).test(i.text));
      if (printed.length === 1) first.items = first.items.filter(i => i !== printed[0]);
      else {
        const numbers = first.items.filter(i => i.text === String(region.number));
        const pairs = numbers.flatMap(number => first.items.filter(dot => dot.text === '.' &&
          (Math.abs(dot.x + dot.width - number.x) < 1 || Math.abs(number.x + number.width - dot.x) < 1)).map(dot => [number, dot]));
        if (pairs.length !== 1) fail('ambiguous-question-number');
        first.items = first.items.filter(i => !pairs[0].includes(i));
      }
      const stem = [], choices = [[], [], [], []];
      let current = 0;
      for (const line of lines) {
        const { markers, items } = markerize(line.items);
        if (markers.length) {
          if (markers.length !== 1 || markers[0].n !== current + 1 || current >= 4) fail('choice-markers-not-once-in-order');
          const m = markers[0];
          if (dir === 'rtl' ? items.some(i => i.x > m.x + 1) : items.some(i => i.x < m.x + m.width - 1)) fail('unplaceable-choice-text');
          current++;
        }
        if (!items.length) fail('unplaced-or-empty-line');
        (current ? choices[current - 1] : stem).push({ ...line, items });
      }
      if (current !== 4) fail('choice-markers-not-once-in-order');
      const text = { dir, stem: paragraphs(stem, dir), choices: choices.map(c => paragraphs(c, dir).replace(/\n/g, ' ')) };
      if (!text.stem || text.choices.some(c => !c)) fail('empty-stem-or-choice');
      // Some verbal questions distinguish otherwise identical choices ONLY by
      // which word is bold. The plain-text schema cannot convey that meaning.
      if (new Set(text.choices).size !== 4) fail('choices-differ-only-in-formatting');
      if (/^\d{1,2}\s*\.|^\.\s*\d{1,2}/u.test(text.stem)) fail('question-number-in-stem');
      return { text, reason: null };
    } catch (error) {
      return { text: null, reason: error.message };
    }
  };
}
