// Reads the form fields of a fillable PDF, so a filled-in character sheet can be imported.
// A reader-only copy of MundusMaker's public/js/sheets/pdfform.js (same author, MIT), plus
// each widget's caption and, for push buttons, its drawing (the official V5 sheet keeps
// Humanity in its buttons' captions), and pageImages() for pictures drawn on the pages
// (Progeny's export ticks Humanity that way). Fix a parsing bug in both copies.
//
// Pure module (no DOM): Uint8Array in, plain objects out. Compressed streams use the
// platform's DecompressionStream, which browsers and Node 18+ provide. Encrypted PDFs are
// refused with a plain explanation. Nothing is uploaded: the file is read where it was picked.

// ---------- object model ----------

export class Name { constructor(name) { this.name = name; } }
export class Ref { constructor(num, gen) { this.num = num; this.gen = gen; } }
export class Str { constructor(bytes, hex = false) { this.bytes = bytes; this.hex = hex; } }
export class Stream { constructor(dict, data) { this.dict = dict; this.data = data; } }
class Keyword { constructor(word) { this.word = word; } }

const nameOf = (v) => (v instanceof Name ? v.name : null);
const isDict = (v) => v instanceof Map;

// PDFDocEncoding differs from Latin-1 only in 0x18-0x1F and 0x80-0xA0
const PDFDOC_HIGH = { 0x80: 0x2022, 0x81: 0x2020, 0x82: 0x2021, 0x83: 0x2026, 0x84: 0x2014, 0x85: 0x2013, 0x86: 0x0192, 0x87: 0x2044, 0x88: 0x2039, 0x89: 0x203A, 0x8A: 0x2212, 0x8B: 0x2030, 0x8C: 0x201E, 0x8D: 0x201C, 0x8E: 0x201D, 0x8F: 0x2018, 0x90: 0x2019, 0x91: 0x201A, 0x92: 0x2122, 0x93: 0xFB01, 0x94: 0xFB02, 0x95: 0x0141, 0x96: 0x0152, 0x97: 0x0160, 0x98: 0x0178, 0x99: 0x017D, 0x9A: 0x0131, 0x9B: 0x0142, 0x9C: 0x0153, 0x9D: 0x0161, 0x9E: 0x017E, 0xA0: 0x20AC };

/** A PDF text string as JS text (UTF-16BE with BOM, UTF-8 with BOM, or PDFDocEncoding). */
export function strText(v) {
  if (!(v instanceof Str)) return v == null ? '' : String(v instanceof Name ? v.name : v);
  const b = v.bytes;
  if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    let s = '';
    for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i] << 8) | b[i + 1]);
    return s;
  }
  if (b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  let s = '';
  for (const c of b) s += String.fromCharCode(PDFDOC_HIGH[c] ?? c);
  return s;
}

// ---------- lexer ----------

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const isRegular = (c) => c !== undefined && !WS.has(c) && !DELIM.has(c);

class Lexer {
  constructor(buf, pos = 0) { this.buf = buf; this.pos = pos; }
  skip() {
    const b = this.buf;
    for (;;) {
      while (this.pos < b.length && WS.has(b[this.pos])) this.pos++;
      if (b[this.pos] !== 37) return;
      while (this.pos < b.length && b[this.pos] !== 10 && b[this.pos] !== 13) this.pos++;
    }
  }
  word() {
    const start = this.pos;
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) this.pos++;
    return latin1(this.buf, start, this.pos);
  }
  peekWord() { const at = this.pos; this.skip(); const w = this.word(); this.pos = at; return w; }
  object() {
    this.skip();
    const b = this.buf, c = b[this.pos];
    if (c === undefined) throw new Error('unexpected end of PDF data');
    if (c === 47) return this.name();
    if (c === 40) return this.literal();
    if (c === 60) {
      if (b[this.pos + 1] === 60) return this.dict();
      return this.hexString();
    }
    if (c === 91) {
      this.pos++;
      const arr = [];
      for (;;) {
        this.skip();
        if (b[this.pos] === 93) { this.pos++; return arr; }
        if (this.pos >= b.length) throw new Error('unterminated array');
        arr.push(this.object());
      }
    }
    if ((c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) {
      const n = this.number();
      // "num gen R" is a reference
      if (Number.isInteger(n) && n >= 0) {
        const at = this.pos;
        this.skip();
        const c2 = b[this.pos];
        if (c2 >= 48 && c2 <= 57) {
          const gen = this.number();
          this.skip();
          if (b[this.pos] === 82 && !isRegular(b[this.pos + 1])) { this.pos++; return new Ref(n, gen); }
        }
        this.pos = at;
      }
      return n;
    }
    const w = this.word();
    if (!w) { this.pos++; return new Keyword(String.fromCharCode(c)); }
    if (w === 'true') return true;
    if (w === 'false') return false;
    if (w === 'null') return null;
    return new Keyword(w);
  }
  number() {
    const start = this.pos;
    while (this.pos < this.buf.length && /[0-9+\-.]/.test(String.fromCharCode(this.buf[this.pos]))) this.pos++;
    const v = Number(latin1(this.buf, start, this.pos));
    return Number.isFinite(v) ? v : 0;
  }
  name() {
    this.pos++;
    let s = '';
    while (this.pos < this.buf.length && isRegular(this.buf[this.pos])) {
      const c = this.buf[this.pos];
      if (c === 35 && /^[0-9A-Fa-f]{2}$/.test(latin1(this.buf, this.pos + 1, this.pos + 3))) {
        s += String.fromCharCode(parseInt(latin1(this.buf, this.pos + 1, this.pos + 3), 16));
        this.pos += 3;
      } else { s += String.fromCharCode(c); this.pos++; }
    }
    return new Name(s);
  }
  literal() {
    const b = this.buf, out = [];
    let depth = 1;
    this.pos++;
    while (this.pos < b.length) {
      const c = b[this.pos++];
      if (c === 92) {
        const e = b[this.pos++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
        if (map[e] !== undefined) out.push(map[e]);
        else if (e >= 48 && e <= 55) {
          let v = e - 48;
          for (let k = 0; k < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; k++) v = v * 8 + (b[this.pos++] - 48);
          out.push(v & 0xFF);
        } else if (e === 13) { if (b[this.pos] === 10) this.pos++; } else if (e !== 10) out.push(e);
        continue;
      }
      if (c === 40) depth++;
      if (c === 41 && --depth === 0) break;
      if (c === 13) { out.push(10); if (b[this.pos] === 10) this.pos++; continue; }
      out.push(c);
    }
    return new Str(Uint8Array.from(out));
  }
  hexString() {
    const b = this.buf;
    this.pos++;
    let hex = '';
    while (this.pos < b.length && b[this.pos] !== 62) { const ch = String.fromCharCode(b[this.pos++]); if (/[0-9A-Fa-f]/.test(ch)) hex += ch; }
    this.pos++;
    if (hex.length % 2) hex += '0';
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new Str(out, true);
  }
  dict() {
    this.pos += 2;
    const d = new Map();
    for (;;) {
      this.skip();
      if (this.buf[this.pos] === 62 && this.buf[this.pos + 1] === 62) { this.pos += 2; return d; }
      if (this.pos >= this.buf.length) throw new Error('unterminated dictionary');
      const key = this.object();
      if (!(key instanceof Name)) { if (key instanceof Keyword) continue; throw new Error('dictionary key is not a name'); }
      d.set(key.name, this.object());
    }
  }
}

function latin1(buf, start = 0, end = buf.length) {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode.apply(null, buf.subarray(i, Math.min(end, i + 8192)));
  return s;
}
function indexOf(buf, text, from = 0, to = buf.length) {
  const t = Uint8Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = from; i <= to - t.length; i++) {
    for (let k = 0; k < t.length; k++) if (buf[i + k] !== t[k]) continue outer;
    return i;
  }
  return -1;
}
function lastIndexOf(buf, text, from = buf.length - text.length) {
  const t = Uint8Array.from(text, (c) => c.charCodeAt(0));
  outer: for (let i = Math.min(from, buf.length - t.length); i >= 0; i--) {
    for (let k = 0; k < t.length; k++) if (buf[i + k] !== t[k]) continue outer;
    return i;
  }
  return -1;
}
function concat(chunks, total = chunks.reduce((n, c) => n + c.length, 0)) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

// ---------- filters ----------

async function inflate(bytes) {
  if (typeof DecompressionStream !== 'function') throw new Error('This browser cannot read compressed PDF data.');
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(bytes).catch(() => {});
  writer.close().catch(() => {});
  const reader = ds.readable.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); total += value.length; }
  } catch {
    // some producers leave junk after the compressed data; keep what decoded
    if (!total) throw new Error('A compressed part of this PDF could not be read.');
  }
  return concat(chunks, total);
}

function unpredict(data, parms) {
  const predictor = Number(parms?.get('Predictor') ?? 1);
  if (predictor < 10) return data;
  const colors = Number(parms.get('Colors') ?? 1), bpc = Number(parms.get('BitsPerComponent') ?? 8), columns = Number(parms.get('Columns') ?? 1);
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8)), rowLen = Math.ceil((columns * colors * bpc) / 8);
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)], row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1)), cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const left = i >= bpp ? cur[i - bpp] : 0, up = prev[i], ul = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += left;
      else if (type === 2) v += up;
      else if (type === 3) v += (left + up) >> 1;
      else if (type === 4) { const p = left + up - ul, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - ul); v += pa <= pb && pa <= pc ? left : pb <= pc ? up : ul; }
      cur[i] = v & 0xFF;
    }
    prev = cur;
  }
  return out;
}

async function decodeStream(stream) {
  const f = stream.dict.get('Filter'), p = stream.dict.get('DecodeParms');
  const filters = Array.isArray(f) ? f.map(nameOf) : f ? [nameOf(f)] : [];
  const parms = Array.isArray(p) ? p : [p];
  let data = stream.data;
  for (const [i, name] of filters.entries()) {
    if (name === 'FlateDecode' || name === 'Fl') data = unpredict(await inflate(data), isDict(parms[i]) ? parms[i] : null);
    else if (name === 'ASCIIHexDecode' || name === 'AHx') data = new Lexer(Uint8Array.from(`<${latin1(data)}`, (c) => c.charCodeAt(0))).hexString().bytes;
    else throw new Error(`This PDF uses a compression (${name}) that can't be read here.`);
  }
  return data;
}

// ---------- document ----------

export class PdfDoc {
  constructor(bytes) {
    this.bytes = bytes;
    this.xref = new Map(); // num -> { type: 1, offset, gen } | { type: 2, stm, index }
    this.cache = new Map();
    this.objStms = new Map();
    this.trailer = new Map();
    this.startxref = 0;
    this.xrefStream = false;
  }
  async resolve(v) { return v instanceof Ref ? this.object(v.num) : v; }
  async object(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    const entry = this.xref.get(num);
    let value = null;
    if (entry?.type === 1) value = await this.objectAt(entry.offset, num);
    else if (entry?.type === 2) value = await this.fromObjStm(entry.stm, entry.index, num);
    this.cache.set(num, value);
    return value;
  }
  genOf(num) { const e = this.xref.get(num); return e?.type === 1 ? e.gen : 0; }
  async objectAt(offset, expect) {
    const lx = new Lexer(this.bytes, offset);
    let num;
    try {
      num = lx.object(); lx.object();
      const kw = lx.object();
      if (!(kw instanceof Keyword) || kw.word !== 'obj' || (expect != null && num !== expect)) throw new Error('bad object header');
    } catch {
      // a stale offset: rebuild the table from the file itself once, then retry
      if (!this.rebuilt && expect != null) { this.rebuild(); const e = this.xref.get(expect); if (e?.type === 1 && e.offset !== offset) return this.objectAt(e.offset, expect); }
      return null;
    }
    const value = lx.object();
    lx.skip();
    if (isDict(value) && lx.peekWord() === 'stream') {
      lx.skip(); lx.word();
      if (this.bytes[lx.pos] === 13) lx.pos++;
      if (this.bytes[lx.pos] === 10) lx.pos++;
      const start = lx.pos;
      let length = value.get('Length');
      if (length instanceof Ref) length = await this.object(length.num);
      let end = Number.isInteger(length) ? start + length : -1;
      const tail = end >= 0 ? indexOf(this.bytes, 'endstream', end, Math.min(this.bytes.length, end + 64)) : -1;
      if (tail < 0) {
        end = indexOf(this.bytes, 'endstream', start);
        if (end < 0) throw new Error('A stream in this PDF has no end.');
        while (end > start && (this.bytes[end - 1] === 10 || this.bytes[end - 1] === 13)) end--;
      }
      return new Stream(value, this.bytes.subarray(start, end));
    }
    return value;
  }
  async fromObjStm(stmNum, index, num) {
    let stm = this.objStms.get(stmNum);
    if (!stm) {
      const s = await this.object(stmNum);
      if (!(s instanceof Stream)) return null;
      const data = await decodeStream(s);
      const n = Number(s.dict.get('N')), first = Number(s.dict.get('First'));
      const lx = new Lexer(data, 0), offsets = new Map();
      for (let i = 0; i < n; i++) { const on = lx.object(), off = lx.object(); offsets.set(on, first + off); }
      stm = { data, offsets };
      this.objStms.set(stmNum, stm);
    }
    const at = stm.offsets.get(num);
    return at == null ? null : new Lexer(stm.data, at).object();
  }
  rebuild() {
    this.rebuilt = true;
    const text = latin1(this.bytes);
    for (const m of text.matchAll(/(?:^|[\r\n\s])(\d+)\s+(\d+)\s+obj\b/g)) {
      const offset = m.index + m[0].length - m[0].trimStart().length;
      const num = Number(m[1]);
      const prev = this.xref.get(num);
      // the last definition in the file wins, as it would after updates
      if (!prev || prev.type !== 1 || prev.offset < offset) this.xref.set(num, { type: 1, offset, gen: Number(m[2]) });
    }
    this.cache.clear();
  }
}

async function readXrefSection(doc, offset, seen) {
  if (seen.has(offset)) return;
  seen.add(offset);
  const lx = new Lexer(doc.bytes, offset);
  lx.skip();
  let trailer;
  if (lx.peekWord() === 'xref') {
    lx.word();
    for (;;) {
      lx.skip();
      if (lx.peekWord() === 'trailer') { lx.word(); trailer = lx.object(); break; }
      const start = lx.object(), count = lx.object();
      if (!Number.isInteger(start) || !Number.isInteger(count)) throw new Error('bad xref table');
      for (let i = 0; i < count; i++) {
        const off = lx.object(), gen = lx.object(), kind = lx.object();
        if (!doc.xref.has(start + i) && kind instanceof Keyword && kind.word === 'n') doc.xref.set(start + i, { type: 1, offset: off, gen });
        else if (!doc.xref.has(start + i)) doc.xref.set(start + i, { type: 0 });
      }
    }
    if (doc.startxref === offset) doc.xrefStream = false;
  } else {
    const s = await doc.objectAt(offset);
    if (!(s instanceof Stream) || nameOf(s.dict.get('Type')) !== 'XRef') throw new Error('bad xref stream');
    const data = await decodeStream(s);
    const w = s.dict.get('W').map(Number), index = s.dict.get('Index') || [0, Number(s.dict.get('Size'))];
    const rowLen = w[0] + w[1] + w[2];
    let at = 0;
    const field = (len, dflt) => { if (!len) return dflt; let v = 0; for (let k = 0; k < len; k++) v = v * 256 + data[at++]; return v; };
    for (let i = 0; i + 1 < index.length; i += 2) {
      for (let k = 0; k < index[i + 1] && at + rowLen <= data.length; k++) {
        const num = index[i] + k, type = field(w[0], 1), f2 = field(w[1], 0), f3 = field(w[2], 0);
        if (doc.xref.has(num)) continue;
        if (type === 1) doc.xref.set(num, { type: 1, offset: f2, gen: f3 });
        else if (type === 2) doc.xref.set(num, { type: 2, stm: f2, index: f3 });
        else doc.xref.set(num, { type: 0 });
      }
    }
    trailer = s.dict;
    if (doc.startxref === offset) doc.xrefStream = true;
  }
  for (const [k, v] of trailer) if (!doc.trailer.has(k) && k !== 'Prev' && k !== 'XRefStm' && k !== 'Length' && k !== 'Filter' && k !== 'DecodeParms' && k !== 'W' && k !== 'Index' && k !== 'Type') doc.trailer.set(k, v);
  if (Number.isInteger(trailer.get('XRefStm'))) await readXrefSection(doc, trailer.get('XRefStm'), seen).catch(() => {});
  if (Number.isInteger(trailer.get('Prev'))) await readXrefSection(doc, trailer.get('Prev'), seen);
}

/** Parse a PDF's structure. Throws a readable Error for files it cannot read. */
export async function readPdf(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (latin1(bytes, 0, 1024).indexOf('%PDF-') < 0) throw new Error('This file is not a PDF.');
  const doc = new PdfDoc(bytes);
  const at = lastIndexOf(bytes, 'startxref');
  try {
    if (at < 0) throw new Error('no startxref');
    const lx = new Lexer(bytes, at + 9);
    doc.startxref = lx.object();
    await readXrefSection(doc, doc.startxref, new Set());
    if (!doc.trailer.get('Root')) throw new Error('no root');
  } catch {
    // damaged cross-reference data: rebuild it from the objects themselves
    doc.xref.clear(); doc.trailer.clear(); doc.rebuild();
    const adopt = (d) => { for (const k of ['Root', 'Info', 'ID', 'Encrypt']) if (d.has(k)) doc.trailer.set(k, d.get(k)); };
    const tr = lastIndexOf(bytes, 'trailer');
    if (tr >= 0) { try { const d = new Lexer(bytes, tr + 7).object(); if (isDict(d)) adopt(d); } catch { /* keep looking */ } }
    for (const num of [...doc.xref.keys()].sort((a, b) => b - a)) {
      if (doc.trailer.get('Root')) break;
      const o = await doc.object(num);
      const d = o instanceof Stream ? o.dict : o;
      if (isDict(d) && d.get('Root')) { adopt(d); doc.xrefStream = nameOf(d.get('Type')) === 'XRef'; }
      else if (isDict(d) && nameOf(d.get('Type')) === 'Catalog') doc.trailer.set('Root', new Ref(num, doc.genOf(num)));
    }
    if (!doc.trailer.get('Root')) throw new Error('This PDF is damaged: its pages could not be found.');
    doc.startxref = 0;
  }
  if (doc.trailer.get('Encrypt')) throw new Error('This PDF is protected with encryption, so its fields can’t be read. Save an unprotected copy and import that.');
  doc.size = Math.max(Number(doc.trailer.get('Size')) || 0, ...[...doc.xref.keys()].map((n) => n + 1));
  return doc;
}

// ---------- form fields ----------

const FLAG = { readOnly: 1, multiline: 1 << 12, password: 1 << 13, radio: 1 << 15, pushbutton: 1 << 16, combo: 1 << 17, comb: 1 << 24 };

async function pageList(doc) {
  const root = await doc.resolve(doc.trailer.get('Root'));
  const pages = [];
  const walk = async (ref, inherited, depth) => {
    if (depth > 64) return;
    const node = await doc.resolve(ref);
    if (!isDict(node)) return;
    const box = node.get('MediaBox') ?? inherited;
    if (nameOf(node.get('Type')) === 'Pages' || node.has('Kids')) {
      for (const kid of (await doc.resolve(node.get('Kids'))) || []) await walk(kid, box, depth + 1);
    } else pages.push({ ref, node, box: (await doc.resolve(box)) || [0, 0, 612, 792] });
  };
  await walk(root.get('Pages'), null, 0);
  return pages;
}

/**
 * The form: every terminal field with its widgets, pages and on-states.
 * Field `name` is the fully qualified name ("parent.child"). Each widget also carries
 * its `caption` (/MK /CA) and, on push buttons, `drawn`: its normal appearance's drawing
 * operators, which is all a filler that sets no caption leaves behind.
 */
export async function readForm(doc) {
  const root = await doc.resolve(doc.trailer.get('Root'));
  const acro = await doc.resolve(root?.get('AcroForm'));
  const pages = await pageList(doc);
  const annotPage = new Map();
  for (const [i, p] of pages.entries()) for (const a of (await doc.resolve(p.node.get('Annots'))) || []) if (a instanceof Ref) annotPage.set(a.num, i);
  const fields = [];
  const seen = new Set();
  const walk = async (ref, parentName, inh, depth) => {
    if (!(ref instanceof Ref) || seen.has(ref.num) || depth > 32) return;
    seen.add(ref.num);
    const node = await doc.resolve(ref);
    if (!isDict(node)) return;
    const partial = node.has('T') ? strText(await doc.resolve(node.get('T'))) : null;
    const name = partial == null ? parentName : parentName ? `${parentName}.${partial}` : partial;
    const own = {};
    for (const k of ['FT', 'Ff', 'V', 'DA', 'Q', 'Opt', 'MaxLen']) own[k] = node.has(k) ? await doc.resolve(node.get(k)) : inh[k];
    const kids = (await doc.resolve(node.get('Kids'))) || [];
    const fieldKids = [], widgetKids = [];
    for (const k of kids) { const kd = await doc.resolve(k); (isDict(kd) && kd.has('T') ? fieldKids : widgetKids).push(k); }
    for (const k of fieldKids) await walk(k, name, own, depth + 1);
    if (fieldKids.length && !widgetKids.length) return;
    const ft = nameOf(own.FT), ff = Number(own.Ff || 0);
    const type = ft === 'Tx' ? 'text' : ft === 'Ch' ? 'choice' : ft === 'Sig' ? 'signature'
      : ft === 'Btn' ? (ff & FLAG.pushbutton ? 'pushbutton' : ff & FLAG.radio ? 'radio' : 'checkbox') : 'unknown';
    const widgetRefs = widgetKids.length ? widgetKids.filter((k) => k instanceof Ref) : node.has('Rect') ? [ref] : [];
    const widgets = [];
    for (const wref of widgetRefs) {
      const w = await doc.resolve(wref);
      if (!isDict(w)) continue;
      const rect = ((await doc.resolve(w.get('Rect'))) || [0, 0, 0, 0]).map(Number);
      const ap = await doc.resolve(w.get('AP'));
      const normal = isDict(ap) ? await doc.resolve(ap.get('N')) : null;
      const onStates = isDict(normal) ? [...normal.keys()].filter((k) => k !== 'Off') : [];
      let page = annotPage.get(wref.num);
      if (page == null && w.get('P') instanceof Ref) page = pages.findIndex((p) => p.ref instanceof Ref && p.ref.num === w.get('P').num);
      const mk = await doc.resolve(w.get('MK'));
      const drawn = type === 'pushbutton' && normal instanceof Stream ? latin1(await decodeStream(normal).catch(() => new Uint8Array(0))).slice(0, 4000) : '';
      // `state` is the widget's own /AS: some producers tick a box there and leave the field's /V unset
      widgets.push({
        ref: wref, rect: [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])], page: page ?? -1, onStates,
        rotate: isDict(mk) ? Number(mk.get('R') || 0) : 0, state: nameOf(await doc.resolve(w.get('AS'))),
        caption: isDict(mk) ? strText(await doc.resolve(mk.get('CA'))) : '', drawn,
      });
    }
    fields.push({
      ref, name: name || `(unnamed ${ref.num})`, type, flags: ff,
      readOnly: !!(ff & FLAG.readOnly), multiline: !!(ff & FLAG.multiline), comb: !!(ff & FLAG.comb),
      maxLen: Number.isInteger(own.MaxLen) ? own.MaxLen : null, da: strText(own.DA ?? acro?.get('DA')), q: Number(own.Q ?? acro?.get('Q') ?? 0),
      value: own.V instanceof Name ? own.V.name : strText(own.V),
      options: Array.isArray(own.Opt) ? own.Opt.map((o) => strText(Array.isArray(o) ? o[1] : o)) : [],
      onStates: [...new Set(widgets.flatMap((w) => w.onStates))],
      widgets,
    });
  };
  for (const f of (await doc.resolve(acro?.get('Fields'))) || []) await walk(f, '', {}, 0);
  // Some producers put complete fields on the pages as widget annotations and never list
  // them in an AcroForm, which viewers still show. Read those from the top of each one's
  // /Parent chain.
  const listed = fields.length;
  for (const p of pages) {
    for (const a of (await doc.resolve(p.node.get('Annots'))) || []) {
      if (!(a instanceof Ref) || seen.has(a.num)) continue;
      const w = await doc.resolve(a);
      if (!isDict(w) || nameOf(w.get('Subtype')) !== 'Widget') continue;
      let top = a;
      for (let depth = 0, node = w; node.get('Parent') instanceof Ref && depth < 32; depth++) { top = node.get('Parent'); node = await doc.resolve(top); if (!isDict(node)) break; }
      await walk(top, '', {}, 0);
    }
  }
  return {
    fields,
    pages: pages.map((p) => { const b = p.box.map(Number); return { width: b[2] - b[0], height: b[3] - b[1] }; }),
    hasForm: !!acro || fields.length > listed,
    unlisted: fields.length - listed,
    xfa: !!acro?.get('XFA'),
  };
}

// ---------- pictures drawn on the pages ----------

// [a b c d e f] matrices: m applied first, then n
const multiply = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];

async function resourcesOf(doc, node) {
  for (let depth = 0; isDict(node) && depth < 16; depth++) {
    const r = await doc.resolve(node.get('Resources'));
    if (isDict(r)) return r;
    node = await doc.resolve(node.get('Parent'));
  }
  return null;
}

/**
 * Where images are drawn on the pages: [{ page, rect: [x0, y0, x1, y1] }] in page space,
 * the same space as widget rects. Progeny's PDF export marks Humanity by drawing a tick
 * picture over each box. Follows only q, Q, cm and Do in the page content.
 */
export async function pageImages(doc) {
  const out = [];
  for (const [page, p] of (await pageList(doc)).entries()) {
    const xobjects = await doc.resolve((await resourcesOf(doc, p.node))?.get('XObject'));
    let contents = await doc.resolve(p.node.get('Contents'));
    contents = Array.isArray(contents) ? contents : contents ? [contents] : [];
    let ctm = [1, 0, 0, 1, 0, 0];
    const stack = [];
    for (const ref of contents) {
      const s = await doc.resolve(ref);
      if (!(s instanceof Stream)) continue;
      let data;
      try { data = await decodeStream(s); } catch { continue; }
      const lx = new Lexer(data, 0);
      const operands = [];
      try {
        for (;;) {
          lx.skip();
          if (lx.pos >= data.length) break;
          const t = lx.object();
          if (!(t instanceof Keyword)) { operands.push(t); continue; }
          if (t.word === 'q') stack.push(ctm);
          else if (t.word === 'Q') ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
          else if (t.word === 'cm' && operands.length >= 6 && operands.slice(-6).every((v) => typeof v === 'number')) ctm = multiply(operands.slice(-6), ctm);
          else if (t.word === 'Do' && operands[operands.length - 1] instanceof Name) {
            const x = isDict(xobjects) ? await doc.resolve(xobjects.get(operands[operands.length - 1].name)) : null;
            if (x instanceof Stream && nameOf(x.dict.get('Subtype')) === 'Image') {
              // the image fills the unit square, carried to the page by the current matrix
              const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]];
              const ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
              out.push({ page, rect: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] });
            }
          } else if (t.word === 'ID') {
            // an inline image's bytes run to the next "EI"
            const end = indexOf(data, 'EI', lx.pos);
            lx.pos = end < 0 ? data.length : end + 2;
          }
          operands.length = 0;
        }
      } catch { /* drawing this reader can't follow: keep what was found */ }
    }
  }
  return out;
}

// ---------- what the pages draw ----------

// WinAnsiEncoding, which the standard fonts use: Latin-1 except 0x80-0x9F
const WINANSI_HIGH = { 0x80: 0x20AC, 0x82: 0x201A, 0x83: 0x0192, 0x84: 0x201E, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02C6, 0x89: 0x2030, 0x8A: 0x0160, 0x8B: 0x2039, 0x8C: 0x0152, 0x8E: 0x017D, 0x91: 0x2018, 0x92: 0x2019, 0x93: 0x201C, 0x94: 0x201D, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02DC, 0x99: 0x2122, 0x9A: 0x0161, 0x9B: 0x203A, 0x9C: 0x0153, 0x9E: 0x017E, 0x9F: 0x0178 };
const winAnsi = (bytes) => { let s = ''; for (const c of bytes) s += String.fromCharCode(WINANSI_HIGH[c] ?? c); return s; };
const PAINT = { S: 'stroke', s: 'stroke', f: 'fill', F: 'fill', 'f*': 'fill', B: 'both', 'B*': 'both', b: 'both', 'b*': 'both', n: 'none' };

/**
 * What each page draws, in page space (points, y up), for sheets that were drawn rather than
 * filled in (MundusMaker's own sheet PDFs): { width, height, texts: [{ x, y, size, font, text }],
 * circles: [{ x, y, r, fill }], rects: [{ x0, y0, x1, y1, fill }], lines: [{ x1, y1, x2, y2 }] },
 * `fill` being the [r, g, b] a shape is filled with, or null when it is only stroked. Text is
 * read as WinAnsi, the standard fonts' encoding, at the position its text matrix gives (no glyph
 * advances), and `font` is the font's BaseFont. Other shapes are left out.
 */
export async function pageDrawing(doc) {
  const out = [];
  for (const p of await pageList(doc)) {
    const fonts = new Map();
    const fontDict = await doc.resolve((await resourcesOf(doc, p.node))?.get('Font'));
    if (isDict(fontDict)) {
      for (const [key, ref] of fontDict) {
        const f = await doc.resolve(ref);
        fonts.set(key, isDict(f) ? nameOf(await doc.resolve(f.get('BaseFont'))) || '' : '');
      }
    }
    const box = p.box.map(Number);
    const page = { width: box[2] - box[0], height: box[3] - box[1], texts: [], circles: [], rects: [], lines: [] };
    out.push(page);
    let contents = await doc.resolve(p.node.get('Contents'));
    contents = Array.isArray(contents) ? contents : contents ? [contents] : [];
    const parts = [];
    for (const ref of contents) {
      const s = await doc.resolve(ref);
      if (!(s instanceof Stream)) continue;
      try { parts.push(await decodeStream(s), Uint8Array.of(10)); } catch { /* a part this reader can't decode */ }
    }
    const data = concat(parts);

    let gs = { ctm: [1, 0, 0, 1, 0, 0], fill: [0, 0, 0] };
    const stack = [];
    let font = '', size = 0, leading = 0, tm = [1, 0, 0, 1, 0, 0], tlm = tm;
    let path = [];
    const at = ([x, y]) => [gs.ctm[0] * x + gs.ctm[2] * y + gs.ctm[4], gs.ctm[1] * x + gs.ctm[3] * y + gs.ctm[5]];
    const moveText = (tx, ty) => { tlm = multiply([1, 0, 0, 1, tx, ty], tlm); tm = tlm; };
    const show = (str) => {
      if (!(str instanceof Str)) return;
      const m = multiply(tm, gs.ctm);
      page.texts.push({ x: m[4], y: m[5], size: size * Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])), font, text: /Symbol|Dingbats/i.test(font) ? latin1(str.bytes) : winAnsi(str.bytes) });
    };
    const paint = (how) => {
      const fill = how === 'fill' || how === 'both' ? gs.fill : null;
      for (const sp of how === 'none' ? [] : path) {
        if (sp.rect) {
          const [x, y, w, h] = sp.rect;
          const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(at);
          const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
          page.rects.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), fill });
        } else if (sp.segs.length === 4 && sp.segs.every((g) => g === 'c')) {
          // four curves round a point: a circle (or an ellipse, which isn't kept)
          const pts = sp.pts.map(at), xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
          const w = Math.max(...xs) - Math.min(...xs), h = Math.max(...ys) - Math.min(...ys);
          if (w > 0 && Math.abs(w - h) <= 0.05 * w) page.circles.push({ x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2, r: (w + h) / 4, fill });
        } else if (sp.segs.length === 1 && sp.segs[0] === 'l') {
          const [a, b] = sp.pts.map(at);
          page.lines.push({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] });
        }
      }
      path = [];
    };

    const lx = new Lexer(data, 0);
    const ops = [];
    const num = (i) => Number(ops[ops.length - i]) || 0; // the i-th operand from the end
    try {
      for (;;) {
        lx.skip();
        if (lx.pos >= data.length) break;
        const t = lx.object();
        if (!(t instanceof Keyword)) { ops.push(t); continue; }
        const w = t.word;
        if (w === 'q') stack.push(gs);
        else if (w === 'Q') gs = stack.pop() || gs;
        else if (w === 'cm' && ops.length >= 6) gs = { ...gs, ctm: multiply([num(6), num(5), num(4), num(3), num(2), num(1)], gs.ctm) };
        else if (w === 'g' || w === 'rg' || w === 'k' || w === 'sc' || w === 'scn') {
          const v = ops.filter((o) => typeof o === 'number');
          if (w === 'g' || v.length === 1) gs = { ...gs, fill: [v[0], v[0], v[0]] };
          else if (w === 'rg' || v.length === 3) gs = { ...gs, fill: v.slice(0, 3) };
          else if (v.length === 4) gs = { ...gs, fill: v.slice(0, 3).map((c) => 1 - Math.min(1, c + v[3])) };
        } else if (w === 'm') path.push({ pts: [[num(2), num(1)]], segs: [] });
        else if (w === 'l' && path.length) { const sp = path[path.length - 1]; sp.pts.push([num(2), num(1)]); sp.segs.push('l'); }
        else if ((w === 'c' || w === 'v' || w === 'y') && path.length) {
          const sp = path[path.length - 1], n = w === 'c' ? 6 : 4;
          for (let i = n; i >= 2; i -= 2) sp.pts.push([num(i), num(i - 1)]);
          sp.segs.push('c');
        } else if (w === 're') path.push({ rect: [num(4), num(3), num(2), num(1)] });
        else if (PAINT[w]) paint(PAINT[w]);
        else if (w === 'BT') { tm = [1, 0, 0, 1, 0, 0]; tlm = tm; }
        else if (w === 'Tf') { font = fonts.get(ops[ops.length - 2]?.name) ?? ''; size = num(1); }
        else if (w === 'TL') leading = num(1);
        else if (w === 'Td') moveText(num(2), num(1));
        else if (w === 'TD') { leading = -num(1); moveText(num(2), num(1)); }
        else if (w === 'Tm' && ops.length >= 6) { tlm = [num(6), num(5), num(4), num(3), num(2), num(1)]; tm = tlm; }
        else if (w === 'T*') moveText(0, -leading);
        else if (w === 'Tj') show(ops[ops.length - 1]);
        else if (w === "'" || w === '"') { moveText(0, -leading); show(ops[ops.length - 1]); }
        else if (w === 'TJ' && Array.isArray(ops[ops.length - 1])) {
          const parts = ops[ops.length - 1].filter((o) => o instanceof Str);
          show(new Str(concat(parts.map((s) => s.bytes))));
        } else if (w === 'ID') {
          // an inline image's bytes run to the next "EI"
          const end = indexOf(data, 'EI', lx.pos);
          lx.pos = end < 0 ? data.length : end + 2;
        }
        ops.length = 0;
      }
    } catch { /* drawing this reader can't follow: keep what was found */ }
  }
  return out;
}
