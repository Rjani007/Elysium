// Where the app finds its Supabase project.
//
// The publishable key is meant to be public: it only identifies the project. What each
// signed-in player may read or change is decided by the row level security policies in
// supabase/migrations, which the database enforces no matter what this page does.
//
// SETUP.md step 3 says where to find your project's URL and publishable key.

const production = {
  url: 'https://ohmarzyfmjpvbrnfcyvr.supabase.co',
  key: 'sb_publishable_5FWRy5sm33L7kS879W_apg_7RRjKtSw',
};

// The local stack started by `npm run db:start` (the Supabase CLI's standard local key).
const local = {
  url: 'http://127.0.0.1:56321',
  key: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH',
};

const onThisComputer = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);

export const config = onThisComputer ? local : production;
export const configured = !config.url.includes('YOUR-PROJECT-REF') && !config.key.startsWith('YOUR-');
