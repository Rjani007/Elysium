# Elysium

An online table for Vampire: The Masquerade 5th Edition chronicles, made to sit beside
MundusMaker (the local worldbuilding wiki whose V5 wizard builds the characters).
Everyone connects from a browser; the storyteller runs the night.

- **Chronicles and tables.** Accounts, chronicles with storytellers and players, and
  several tables per chronicle, each with its own players, rolls and reveals. Players join
  with an invite link.
- **Characters.** Import MundusMaker character files (⇩ Character file on any V5 sheet),
  Progeny save files (Save File) or PDFs (Download PDF), or the official fillable V5
  character sheet filled in as a PDF; PDFs are read in the browser and never uploaded. Or
  fill in a blank sheet. Damage, Hunger, Humanity, Stains and XP are tracked live, and a
  sheet exports back to MundusMaker after the session.
- **V5 dice, rolled by the server.** Click traits on the sheet to build a pool;
  specialties, Blood Surge, modifiers and Difficulty are one click each. Hunger dice,
  criticals, messy criticals and bestial failures are worked out by the database, so
  nobody can fake a roll. Willpower re-rolls, Rouse checks (with Blood Potency re-rolls),
  Remorse, Willpower and frenzy tests are built in. Private rolls reach only the storyteller.
- **NPCs and handouts.** The storyteller keeps a library and reveals entries to a whole
  table or one player; NPC secrets never leave the storyteller's side. A new NPC can be
  filled in from any character file or sheet PDF the character import takes. "Show everyone now"
  opens a handout on every screen at the table.
- **Music.** A YouTube playlist per chronicle; press play and everyone at the table hears
  the same track at the same moment, each at their own volume.

Elysium is a static site (plain JavaScript modules, no build step) on GitHub Pages, with
Supabase for accounts, data, files and live updates. **[SETUP.md](SETUP.md)** puts it
online.

## Running it on your computer

Needs Node 22+ and Docker Desktop.

```bash
npm install
```

```bash
npm run db:start
```

```bash
node scripts/seed-local.js
```

```bash
npm run serve
```

Then open http://localhost:4890. The seed script makes a demo chronicle with three test
accounts (storyteller, ana and ben `@example.test`); their passwords are in
`.local/test-users.json`, which never leaves your computer.

## Tests

```bash
npm test
```

```bash
npm run test:db
```

`npm test` checks the importers (official sheet PDFs included) and text handling. `npm run test:db` runs against the
local database and checks the privacy rules, the dice and live updates.

## License

MIT. supabase-js is vendored under its MIT license (`site/vendor/`).

Elysium is an unofficial fan tool for Vampire: The Masquerade. Portions of the materials
are the copyrights and trademarks of Paradox Interactive AB, and are used with
permission. All rights reserved. For more information please visit
[worldofdarkness.com](https://www.worldofdarkness.com). It bundles names and numbers
only; no rules text.
