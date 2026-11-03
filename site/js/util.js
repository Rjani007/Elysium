// DOM and small helpers. el() builds elements the way MundusMaker's does: null/false
// children are skipped and child arrays are flattened, so views can be written as trees.

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'value' && 'value' in node) node.value = v ?? '';
    else if (k === 'checked' || k === 'disabled' || k === 'selected') node[k] = !!v;
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const compareNames = (a, b) => collator.compare(String(a ?? ''), String(b ?? ''));

export function debounce(fn, ms) {
  let t = null;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => { t = null; fn(...args); }, ms);
  };
  wrapped.flush = (...args) => { if (t) { clearTimeout(t); t = null; fn(...args); } };
  return wrapped;
}

export function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDay(iso) {
  return new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
}

// Per-browser conveniences only (chosen character, volume); nothing that must be shared.
export function stored(key, value) {
  const k = `elysium.${key}`;
  try {
    if (value === undefined) return JSON.parse(localStorage.getItem(k) ?? 'null');
    if (value === null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(value));
  } catch { /* private mode: forget it */ }
  return value ?? null;
}

let toastHost = null;
export function toast(message, { tone = 'info', ms = 3600 } = {}) {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const t = el('div', { class: `toast toast-${tone}` }, message);
  toastHost.append(t);
  setTimeout(() => { t.classList.add('toast-out'); setTimeout(() => t.remove(), 300); }, ms);
}

export const fail = (err) => toast(err?.message || String(err), { tone: 'error', ms: 6000 });

/** A modal dialog. Returns { dialog, close }. body may be a node or an array of nodes. */
export function modal(title, body, { wide = false, onClose = null, actions = null } = {}) {
  const dialog = el('dialog', { class: `modal${wide ? ' modal-wide' : ''}` },
    el('div', { class: 'modal-head' },
      el('h2', {}, title),
      el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close() }, '✕')),
    el('div', { class: 'modal-body' }, body),
    actions ? el('div', { class: 'modal-actions' }, actions) : null);
  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    dialog.close();
    dialog.remove();
    onClose?.();
  }
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) close(); });
  document.body.append(dialog);
  dialog.showModal();
  return { dialog, close };
}

export function confirmDialog(message, { ok = 'OK', danger = false, title = 'Are you sure?' } = {}) {
  return new Promise((resolve) => {
    let answer = false;
    const { close } = modal(title, el('p', {}, message), {
      onClose: () => resolve(answer),
      actions: [
        el('button', { class: 'btn', onclick: () => close() }, 'Cancel'),
        el('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, onclick: () => { answer = true; close(); } }, ok),
      ],
    });
  });
}

export function promptDialog(title, { label = '', value = '', placeholder = '', ok = 'OK', maxlength = 80 } = {}) {
  return new Promise((resolve) => {
    let answer = null;
    const input = el('input', { type: 'text', value, placeholder, maxlength, 'aria-label': label || title });
    const form = el('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); answer = input.value.trim() || null; close(); } },
      label ? el('label', { class: 'field' }, el('span', {}, label), input) : input);
    const { close } = modal(title, form, {
      onClose: () => resolve(answer),
      actions: [
        el('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Cancel'),
        el('button', { class: 'btn btn-primary', type: 'button', onclick: () => form.requestSubmit() }, ok),
      ],
    });
    setTimeout(() => { input.focus(); input.select(); }, 30);
  });
}

export function downloadJson(obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied.');
  } catch {
    await promptDialog('Copy this', { value: text, ok: 'Done', maxlength: 2000 });
  }
}

export function readFileText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('Could not read that file.'));
    r.readAsText(file);
  });
}

/**
 * Light markdown for handouts and descriptions: paragraphs, **bold**, *italic*, line breaks.
 * Everything is escaped first, so the only tags that can come out are these four.
 */
export function richHtml(text) {
  const html = esc(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*(?!\s)(.+?)\*(?!\*)/g, '$1<em>$2</em>');
  return html.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
}

export function richText(text) {
  const wrap = el('div', { class: 'rich' });
  wrap.innerHTML = richHtml(text);
  return wrap;
}

export const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
