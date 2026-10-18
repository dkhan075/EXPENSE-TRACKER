# Ledger backend
Node + Express + libSQL (Turso). Sign in with Google; every user only sees their own data.

Env vars:
- `GOOGLE_CLIENT_ID` (required) - OAuth Web client ID from Google Cloud
- `OWNER_EMAIL` (recommended) - your Gmail; only this account adopts expenses saved before Google login existed
- `ALLOWED_EMAILS` (optional) - comma-separated Gmail list; if set, only these (plus the owner) can sign in
- `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` - cloud database (local file fallback via `DB_PATH`)

`npm test` runs the API tests.
