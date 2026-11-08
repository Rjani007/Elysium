// Draws the invented characters in tests/fixtures/drawn-characters.json with MundusMaker's own
// familiar-layout code, the way its Player sheet PDF button does in the browser (jsPDF's text
// metrics, cp1252 text), into the PDFs tests/unit/drawnsheet.test.js imports. Compressed, to keep
// them small; MundusMaker's own PDFs are not, which the reader handles the same way.
//
// Run it with MundusMaker checked out beside this folder whenever familiar.js changes its V5
// layout (then change drawnsheet.js to match):  node scripts/drawn-fixtures.cjs
const fs = require('fs');
const path = require('path');

const MM = path.resolve(__dirname, '../../mundusmaker');
const FIXTURES = path.resolve(__dirname, '../tests/fixtures');
const lib = require(path.join(MM, 'node_modules/jspdf'));
const jsPDF = lib.jsPDF || lib.default || lib;
globalThis.window = { jspdf: { jsPDF } }; // familiar.js measures text with jsPDF, as in the browser
const load = require(path.join(MM, 'tests/module-loader.js'));

// what MundusMaker's pdfSafe keeps: Latin-1 and the rest of cp1252
const CP1252_HIGH = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');
const safe = (s) => [...String(s ?? '')].filter((c) => c.codePointAt(0) <= 0xFF || CP1252_HIGH.has(c)).join('');

(async () => {
  const { writeFamiliarSheet } = await load('sheets/familiar.js');
  const characters = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'drawn-characters.json'), 'utf8'));
  for (const c of Object.values(characters)) {
    const doc = new jsPDF({ unit: 'pt', format: c.format, orientation: 'portrait', compress: true });
    writeFamiliarSheet(doc, c.system || 'vtm5', c.data, { name: c.name, gm: false, secret: false, safe, firstPage: true, format: c.format });
    const bytes = Buffer.from(doc.output('arraybuffer'));
    fs.writeFileSync(path.join(FIXTURES, c.file), bytes);
    console.log(`${c.file}: ${bytes.length} bytes, ${doc.getNumberOfPages()} pages`);
  }
})().catch((e) => { console.error(e); process.exit(1); });
