// Portraits and handout files in the private "media" bucket.
//
// Egress matters on Supabase's free plan, so: images are shrunk in the browser before
// upload, files are stored under new names (never overwritten, so they can be cached
// for a day), and signed links are reused from localStorage until shortly before they
// expire, which lets the browser's cache answer repeat views instead of the server.

import { sb } from './supa.js';
import { stored } from './util.js';

const LINK_SECONDS = 24 * 60 * 60;
const memory = new Map();

export async function mediaUrl(path) {
  if (!path) return null;
  const now = Date.now();
  const hit = memory.get(path) || stored(`link:${path}`);
  if (hit && hit.expires - now > 10 * 60 * 1000) {
    memory.set(path, hit);
    return hit.url;
  }
  const { data, error } = await sb.storage.from('media').createSignedUrl(path, LINK_SECONDS);
  if (error) return null; // not visible to this user (any more)
  const entry = { url: data.signedUrl, expires: now + LINK_SECONDS * 1000 };
  memory.set(path, entry);
  stored(`link:${path}`, entry);
  return entry.url;
}

export function forgetMedia(path) {
  memory.delete(path);
  stored(`link:${path}`, null);
}

const RASTER = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const ACCEPT_IMAGES = RASTER.join(',');
export const ACCEPT_HANDOUTS = [...RASTER, 'application/pdf'].join(',');

/**
 * Shrinks a picture to at most maxSide pixels on its longer side, as WebP (or JPEG where
 * the browser can't write WebP). GIFs are kept as they are so animations survive.
 */
export async function prepareImage(file, maxSide = 1600) {
  if (!RASTER.includes(file.type)) throw new Error('Use a PNG, JPEG, WebP or GIF picture.');
  if (file.type === 'image/gif') return { blob: file, type: 'image/gif', ext: 'gif' };
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  for (const [type, ext] of [['image/webp', 'webp'], ['image/jpeg', 'jpg']]) {
    const blob = await new Promise((r) => canvas.toBlob(r, type, 0.85));
    if (blob && blob.type === type) {
      return blob.size < file.size || scale < 1 ? { blob, type, ext } : { blob: file, type: file.type, ext: file.type.split('/')[1].replace('jpeg', 'jpg') };
    }
  }
  return { blob: file, type: file.type, ext: file.type.split('/')[1] };
}

// Decoded by hand: the page's content policy (index.html) doesn't let fetch() read data: URLs.
export function dataUrlToFile(dataUrl, name = 'portrait') {
  const m = /^data:([\w/+.-]+);base64,(.*)$/s.exec(dataUrl);
  if (!m) throw new Error('That picture could not be read.');
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new File([bytes], name, { type: m[1] });
}

/** Uploads to <chronicle>/<kind>/<id>/<random>.<ext> and returns the path. */
export async function uploadMedia({ chronicle, kind, id, blob, type, ext }) {
  const name = `${crypto.randomUUID().slice(0, 8)}.${ext}`;
  const path = `${chronicle}/${kind}/${id}/${name}`;
  const { error } = await sb.storage.from('media').upload(path, blob, { contentType: type, cacheControl: '86400', upsert: false });
  if (error) throw new Error(/mime|type/i.test(error.message) ? 'That kind of file is not allowed.' : /size|large/i.test(error.message) ? 'That file is too large (10 MB at most).' : error.message);
  return path;
}

export async function removeMedia(path) {
  if (!path) return;
  forgetMedia(path);
  await sb.storage.from('media').remove([path]);
}

/** Every file under one item's folder (<chronicle>/<kind>/<id>/), e.g. before deleting the item. */
export async function removeMediaFolder(chronicle, kind, id) {
  const prefix = `${chronicle}/${kind}/${id}`;
  const { data } = await sb.storage.from('media').list(prefix, { limit: 1000 });
  const paths = (data || []).filter((f) => f.id).map((f) => `${prefix}/${f.name}`);
  for (const p of paths) forgetMedia(p);
  if (paths.length) await sb.storage.from('media').remove(paths);
}

/** Deleting rows never deletes files, so a deleted chronicle's files are removed first. */
export async function removeChronicleMedia(chronicle) {
  for (const kind of ['characters', 'npcs', 'handouts']) {
    const { data } = await sb.storage.from('media').list(`${chronicle}/${kind}`, { limit: 1000 });
    for (const folder of data || []) if (!folder.id) await removeMediaFolder(chronicle, kind, folder.name);
  }
}

/** <img> that fills in its signed link when it can. */
export function mediaImg(path, attrs = {}) {
  const img = document.createElement('img');
  for (const [k, v] of Object.entries(attrs)) img.setAttribute(k, v);
  if (path) mediaUrl(path).then((url) => { if (url) img.src = url; });
  return img;
}
