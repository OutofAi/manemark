// Browser-DOM port of the input renderer and structural features in htmlsift's
// Apache-2.0 src/htmlsift/core/render.py and core/features.py.
// The model predicts which rendered lines to retain. This module is NOT a
// readability/rules-based extractor; it prepares the model's inputs.

export const TAG_VOCAB = [
  'main', 'article', 'section', 'nav', 'header', 'footer', 'aside',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'ul', 'ol', 'dl',
  'table', 'tr', 'td', 'th', 'blockquote', 'pre', 'code',
  'figure', 'figcaption', 'form', 'button', 'div'
];
const TAG_SET = new Set(TAG_VOCAB);
const SKIP = new Set(['head', 'script', 'style', 'title', 'meta', 'link', 'base']);
const SIMPLE_BLOCK = new Set([
  'p','div','section','article','header','footer','main','aside','figure','figcaption','fieldset'
]);
const WRAP = { em: '_', i: '_', strong: '**', b: '**', code: '`', del: '~~', s: '~~', strike: '~~' };
const BLOCKISH = new Set([
  ...SIMPLE_BLOCK,'h1','h2','h3','h4','h5','h6','ul','ol','table','blockquote'
]);
const ROW_GROUPS = new Set(['thead','tbody','tfoot']);
const norm = v => (v || '').replace(/\s+/gu, ' ');
const tagOf = node => node?.nodeType === 1 ? node.localName?.toLowerCase() || '' : '';
const childElements = node => Array.from(node.children || []);
const isHidden = node => /display\s*:\s*none/i.test(node.getAttribute('style') || '');

function tableRows(table) {
  const rows = [];
  const visit = node => {
    for (const c of childElements(node)) {
      const t = tagOf(c);
      if (ROW_GROUPS.has(t)) visit(c);
      else if (t === 'tr') rows.push(c);
    }
  };
  visit(table);
  return rows;
}
function layoutTable(table) {
  const cells = tableRows(table).flatMap(row => childElements(row).filter(c => ['td','th'].includes(tagOf(c))));
  if (cells.some(c => tagOf(c) === 'th')) return false;
  return cells.some(cell => Array.from(cell.querySelectorAll('*')).some(d => BLOCKISH.has(tagOf(d))));
}
function cellText(cell) {
  const nodes = new Set();
  const parts = [];
  const rec = el => {
    if (el.nodeType === 3) {
      parts.push(el.nodeValue || '');
      return;
    }
    if (el.nodeType !== 1 || SKIP.has(tagOf(el))) return;
    nodes.add(el);
    for (const child of el.childNodes) rec(child);
  };
  rec(cell);
  return { text: norm(parts.join('')).trim().replace(/\|/g, '\\|'), sources: nodes };
}

class Renderer {
  constructor({ links = false } = {}) {
    this.links = links;
    this.lines = [];
    this.sources = [];
    this.buf = [];
    this.bufSources = [];
    this.linePrefix = '';
    this.pending = null;
    this.swallow = false;
    this.keepLeading = false;
    this.quote = 0;
    this.listStack = [];
  }
  quotePrefix() { return '> '.repeat(this.quote); }
  append(line, sources) {
    this.swallow = false;
    if (this.pending !== null) {
      this.lines.push(this.pending);
      this.sources.push(new Set());
      this.pending = null;
    }
    this.lines.push(line);
    this.sources.push(sources);
  }
  flush() {
    if (!this.buf.length) return;
    const sources = new Set(this.bufSources.filter(Boolean));
    this.append((this.quotePrefix() + this.linePrefix + this.buf.join('')).trimEnd(), sources);
    this.buf = []; this.bufSources = []; this.linePrefix = '';
  }
  blank() {
    this.flush();
    if (!this.lines.length) return;
    this.pending = this.quote ? this.quotePrefix().trimEnd() : '';
  }
  emit(line, sources = new Set()) {
    this.flush();
    this.append(this.quotePrefix() + line, sources);
  }
  text(value, source) {
    if (!value) return;
    let s = norm(value);
    if (this.swallow) { s = s.trimStart(); this.swallow = false; }
    if (!this.buf.length && !this.keepLeading) s = s.trimStart();
    if (!s) return;
    this.buf.push(s); this.bufSources.push(source);
  }
  raw(text, source) { this.buf.push(text); this.bufSources.push(source); }
  children(el) {
    let prior = null;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) this.text(child.nodeValue, prior || el);
      else if (child.nodeType === 1) { this.walk(child); prior = child; }
    }
  }
  keepingLead(el) {
    const old = this.keepLeading;
    this.keepLeading = true; this.children(el); this.keepLeading = old;
  }
  subInline(el) {
    const r = new Renderer({ links: this.links });
    r.children(el); r.flush();
    return r.lines.filter(l => l.trim()).map(l => l.trim()).join(' ');
  }
  walk(el) {
    const tag = tagOf(el);
    if (!tag || SKIP.has(tag) || isHidden(el)) return;
    if (tag === 'br') this.flush();
    else if (tag === 'hr') { this.blank(); this.emit('* * *', new Set([el])); this.blank(); }
    else if (/^h[1-6]$/.test(tag)) {
      this.blank(); this.linePrefix = '#'.repeat(+tag[1]) + ' ';
      this.keepingLead(el); this.blank();
    } else if (tag === 'ul' || tag === 'ol') this.list(el, tag);
    else if (tag === 'li') this.item(el);
    else if (tag === 'blockquote') {
      this.blank(); this.quote++;
      this.children(el); this.flush(); this.quote--; this.blank();
    } else if (tag === 'pre') {
      this.blank(); this.append('```', new Set([el]));
      for (const l of (el.textContent || '').split('\n')) this.append(l, new Set([el]));
      this.append('```', new Set([el])); this.blank();
    } else if (tag === 'table') this.table(el);
    else if (tag === 'dt' || tag === 'option') { this.flush(); this.children(el); this.flush(); }
    else if (tag === 'dd') { this.flush(); this.linePrefix = '    '; this.keepingLead(el); this.flush(); }
    else if (SIMPLE_BLOCK.has(tag)) { this.blank(); this.children(el); this.blank(); }
    else if (Object.hasOwn(WRAP,tag)) {
      const inner = this.subInline(el);
      if (inner) this.raw(WRAP[tag] + inner + WRAP[tag], el);
      else this.swallow = true;
    } else if (tag === 'a' && this.links && el.getAttribute('href')) {
      const inner = this.subInline(el);
      if (inner) this.raw(`[${inner}](${el.getAttribute('href')})`, el);
    } else if (tag === 'img' && this.links && el.getAttribute('src')) {
      this.raw(`![${el.getAttribute('alt') || ''}](${el.getAttribute('src')})`, el);
    } else this.children(el);
  }
  list(el, kind) {
    this.flush();
    const start = parseInt(el.getAttribute('start') || '1', 10);
    this.listStack.push([kind, Number.isFinite(start) ? start : 1]);
    for (const child of el.childNodes) {
      if (child.nodeType === 3) this.text(child.nodeValue, el);
      else if (tagOf(child) === 'li') this.item(child);
      else if (child.nodeType === 1) this.walk(child);
    }
    this.listStack.pop(); this.flush(); this.blank();
  }
  item(el) {
    this.flush();
    const indent = '  '.repeat(Math.max(0, this.listStack.length - 1));
    if (this.listStack.length && this.listStack.at(-1)[0] === 'ol') {
      const current = this.listStack.at(-1);
      this.linePrefix += `${indent}${current[1]++}. `;
    } else this.linePrefix += `${indent}- `;
    this.children(el); this.flush();
  }
  table(el) {
    const rows = tableRows(el);
    if (layoutTable(el)) {
      this.blank();
      for (const row of rows) {
        for (const cell of childElements(row).filter(c => ['td','th'].includes(tagOf(c)))) {
          this.blank(); this.children(cell); this.blank();
        }
      }
      this.blank(); return;
    }
    this.blank(); let first = true;
    for (const row of rows) {
      const cells = childElements(row).filter(c => ['td','th'].includes(tagOf(c)));
      if (!cells.length) continue;
      const values = cells.map(cellText);
      if (!values.some(x => x.text)) continue;
      const sources = new Set([row]);
      for (const c of values) for (const e of c.sources) sources.add(e);
      this.emit('| ' + values.map(x=>x.text).join(' | ') + ' |', sources);
      if (first) {
        this.emit('| ' + cells.map(()=>'---').join(' | ') + ' |', sources);
        first = false;
      }
    }
    this.blank();
  }
}

function collectFeatures(blocks, sources) {
  // Columns: 30 tag booleans, average DOM depth, has_link, log1p(chars).
  const out = new Float32Array(blocks.length * 33);
  const cache = new Map();
  const chainInfo = el => {
    if (cache.has(el)) return cache.get(el);
    let stack = []; let node = el;
    while (node && node.nodeType === 1 && !cache.has(node)) {
      stack.push(node); node = node.parentNode;
    }
    let tags = new Set(), depth = 0, link = false;
    if (cache.has(node)) {
      const prev = cache.get(node); tags = prev.tags; depth = prev.depth; link = prev.link;
    }
    for (let i=stack.length-1;i>=0;i--) {
      const tag = tagOf(stack[i]);
      if (TAG_SET.has(tag) && !tags.has(tag)) tags = new Set([...tags,tag]);
      depth++; link = link || tag === 'a';
      cache.set(stack[i], {tags, depth, link});
    }
    return {tags,depth,link};
  };
  for (let i=0;i<blocks.length;i++) {
    const tags = new Set(); let d=0,n=0,hasLink=false;
    for (const element of sources[i]) {
      const info=chainInfo(element);
      for (const t of info.tags) tags.add(t);
      d+=info.depth; n++; hasLink ||= info.link;
    }
    for (let j=0;j<TAG_VOCAB.length;j++) if (tags.has(TAG_VOCAB[j])) out[33*i+j]=1;
    out[33*i+30] = n ? d/n : 0;
    out[33*i+31] = hasLink ? 1 : 0;
    out[33*i+32] = Math.log1p(blocks[i].length);
  }
  return out;
}

export function renderBlocks(html) {
  const root = new DOMParser().parseFromString(html, 'text/html').documentElement;
  const renderer = new Renderer(); renderer.walk(root); renderer.flush();
  const blocks = []; const sources = [];
  for (let i=0;i<renderer.lines.length;i++) {
    const line = renderer.lines[i];
    if (!line.trim()) continue;
    blocks.push(line.trimEnd());
    sources.push(renderer.sources[i]);
  }
  return { blocks, features: collectFeatures(blocks, sources) };
}
