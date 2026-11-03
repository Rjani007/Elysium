# Putting Elysium online

Elysium is two free pieces: **GitHub Pages** serves the website, and a **Supabase**
project keeps the accounts, chronicles, sheets, rolls and handouts. Setting it up takes
about fifteen minutes, once.

## 1. Create the Supabase project

1. Sign up at [supabase.com](https://supabase.com) and press **New project**.
2. Pick a name (`elysium`), a strong database password (keep it somewhere safe; Elysium
   never needs it) and the region closest to your players. If the form shows security
   options, keep the defaults: Elysium reads the database through the Data API on the
   `public` schema.
3. Wait for the project to finish setting up.

## 2. Build the database

The whole database (tables, privacy rules, dice, file storage, live updates) is one
file: `supabase/migrations/20261103000000_elysium.sql`. Apply it one of two ways.

**With the Supabase CLI** (from this folder):

```bash
npx supabase login
```

```bash
npx supabase link --project-ref YOUR-PROJECT-REF
```

```bash
npx supabase db push --remote
```

The project ref is the part of your project URL before `.supabase.co`. The CLI asks for
no database password; `login` lets it in. Without `--remote`, `db push` updates the local
test database instead.

**Or by hand:** open **SQL Editor** in the Supabase dashboard, paste the whole migration
file, and press **Run**. Run it once only; it will complain if the tables already exist.

## 3. Point the website at your project

In the dashboard, open **Project Settings → API Keys** (and **Data API** for the URL).
Copy the **Project URL** and the **Publishable key** into the `production` block of
`site/config.js`:

```js
const production = {
  url: 'https://abcdefghijklmnop.supabase.co',
  key: 'sb_publishable_...',
};
```

The publishable key is meant to be public. Every rule about who may read what lives in
the database (row level security), so the key alone opens nothing. Never put the
**secret** key or the database password in this repository.

## 4. Sign-in settings

In **Authentication → Sign In / Providers → Email**:

- Turn **Confirm email** off, unless you set up your own email sender (below). Supabase's
  built-in sender only delivers to members of your Supabase team, so your players would
  never receive the confirmation mail.
- Leave the **Email** provider itself switched on: players sign in with an email address
  and a password, and nobody can sign in while it is off.

In **Authentication → URL Configuration**:

- **Site URL**: your site, for example `https://YOUR-NAME.github.io/elysium/`
- **Redirect URLs**: add the same address.

**Password resets** need an email sender. Supabase's free plan works with a free
[Resend](https://resend.com) account: **Authentication → Emails → SMTP Settings**. Until
then, a player who forgets their password can't reset it themselves.

## 5. Publish with GitHub Pages

1. Create a new repository on GitHub named `elysium`. Make it **public**: GitHub Pages
   needs a paid plan for private repositories. Nothing secret is in this code.
2. Push this folder to it:

   ```bash
   git remote add origin https://github.com/YOUR-NAME/elysium.git
   ```

   ```bash
   git push -u origin main
   ```

3. In the repository, open **Settings → Pages** and set **Source** to **GitHub Actions**.

The workflow in `.github/workflows/pages.yml` runs the tests and publishes `site/` on
every push to `main`. The site appears at `https://YOUR-NAME.github.io/elysium/`.

## 6. First night

1. Open the site, create your account, and **Start a chronicle**. You are its storyteller.
2. On the chronicle's **Tables** tab, **Copy invite link** and send it to your players.
   They create an account, take a seat, and import their characters (MundusMaker
   character files, Progeny save files, or the official V5 sheet filled in as a PDF), or
   fill in a blank sheet.
3. Add NPCs, handouts and music tracks in their tabs. Players see an NPC or handout only
   after you reveal it, to a table or to one player.

## Keeping it running

- **A free Supabase project pauses after a week with no activity.** If the site says it
  can't reach the server, open the Supabase dashboard and press **Restore project**; it
  wakes in a few minutes with everything intact.
- **Free plan limits** are generous for one group: 500 MB of database, 1 GB of files and
  5 GB of downloads a month. Elysium shrinks pictures before upload and the music streams
  from YouTube, so a weekly game uses a small part of that.
- **Updating the database:** future changes come as new files in `supabase/migrations/`.
  Apply them with `npx supabase db push --remote` (or paste each new file into the SQL
  Editor).
- **Changing the site:** push to `main` and GitHub Pages republishes it.
