// MundusMaker's own V5 sheet PDF, which it draws instead of filling in a form. The PDFs in
// tests/fixtures were drawn by MundusMaker's familiar.js from drawn-characters.json (invented
// characters; scripts/drawn-fixtures.cjs draws them again), so these check the reader against the
// real drawing rather than its own idea of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { importCharacterFile, normalizeSheet } from '../../site/js/importers.js';

const fixture = (file) => new Uint8Array(readFileSync(new URL(`../fixtures/${file}`, import.meta.url)));
const characters = JSON.parse(readFileSync(new URL('../fixtures/drawn-characters.json', import.meta.url), 'utf8'));
// specialties come back in the sheet's order of skills
const bySkill = (list) => [...list].sort((a, b) => `${a.skill}/${a.name}`.localeCompare(`${b.skill}/${b.name}`));

test('a MundusMaker sheet PDF imports with every dot, box, power, touchstone and note', async () => {
  const c = characters.neonate;
  const { name, data, source, warnings } = await importCharacterFile(fixture(c.file));
  const want = normalizeSheet(c.data).data;
  assert.equal(name, c.name);
  assert.equal(source, 'pdf');
  // the heading row cuts a long Desire to fit, and the import says so
  assert.equal(data.desire, 'Win back the house on the hill fro…');
  assert.deepEqual(warnings, ['Some text was cut short to fit the PDF, so check: Desire.']);
  for (const d of [data, want]) { delete d.desire; d.specialties = bySkill(d.specialties); }
  assert.deepEqual(data, want);
  // Presence has no power descriptions, so the sheet shows no levels: they come from the names
  assert.deepEqual(data.disciplines[1].powers.map((p) => p.level), [1, 1]);
});

test('past six disciplines, eleven advantages or a full text box, the continued details fill in the rest', async () => {
  const c = characters.elder;
  const { name, data, warnings } = await importCharacterFile(fixture(c.file));
  assert.equal(name, c.name);
  assert.deepEqual(warnings, []);
  assert.deepEqual(data, normalizeSheet(c.data).data);
  assert.equal(data.disciplines.length, 7);
  assert.equal(data.advantages.length, 12);
  assert.deepEqual(data.health, { superficial: 0, aggravated: 3 });
});

test('a MundusMaker sheet of another game is refused in plain words', async () => {
  await assert.rejects(importCharacterFile(fixture(characters.dnd.file)), /MundusMaker D&D sheet; only Vampire/);
});
