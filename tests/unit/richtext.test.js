import { test } from 'node:test';
import assert from 'node:assert/strict';
import { richHtml } from '../../site/js/util.js';

test('handout text can only ever produce p, br, strong and em', () => {
  const hostile = [
    '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '**<b onclick=x>bold</b>**',
    '*"><svg onload=alert(1)>*', '<a href="javascript:alert(1)">x</a>', '&lt;script&gt;',
  ].join('\n\n');
  const html = richHtml(hostile);
  const tags = new Set([...html.matchAll(/<\/?([a-z0-9]+)[^>]*>/gi)].map((m) => m[0]));
  for (const tag of tags) assert.match(tag, /^<\/?(p|br|strong|em)>$/, `unexpected markup ${tag}`);
  assert.ok(html.includes('&lt;script&gt;'), 'markup arrives as text');
});

test('formatting still works', () => {
  assert.equal(richHtml('The **Prince** knows.\n*A friend*'), '<p>The <strong>Prince</strong> knows.<br><em>A friend</em></p>');
  assert.equal(richHtml('one\n\ntwo'), '<p>one</p><p>two</p>');
});
