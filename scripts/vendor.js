// Copies supabase-js's single-file browser build into site/vendor, the only third-party
// code the site loads (the YouTube player script comes from YouTube when music plays).
// Run after changing the @supabase/supabase-js version in package.json: npm run vendor
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const from = (p) => fileURLToPath(new URL(`../node_modules/@supabase/supabase-js/${p}`, import.meta.url));
const to = (p) => fileURLToPath(new URL(`../site/vendor/${p}`, import.meta.url));

await mkdir(to(''), { recursive: true });
await copyFile(from('dist/umd/supabase.js'), to('supabase.js'));
const pkg = JSON.parse(await readFile(from('package.json'), 'utf8'));
const license = await readFile(from('LICENSE'), 'utf8').catch(() => 'MIT License, Copyright (c) Supabase. https://github.com/supabase/supabase-js');
await writeFile(to('supabase.LICENSE.txt'), `@supabase/supabase-js ${pkg.version}\n\n${license}`);
console.log(`Vendored @supabase/supabase-js ${pkg.version} into site/vendor/`);
