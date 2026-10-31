# Dashboard มูลค่ายาคงคลัง

Production runtime is **Vercel Serverless Functions + Neon Postgres**. The static dashboard remains in `public/`; its API is `api/index.js`. `public/index.html` is unchanged.

## Deploy to Vercel / Neon

1. Create a Neon Postgres database and copy its pooled connection string.
2. In Vercel project settings, add `DATABASE_URL` as an encrypted environment variable for Production (and Preview if required). Never commit it or put it in a source file.
3. Install dependencies: `npm install`.
4. Migrate the existing local SQLite data (run once from a trusted machine):

   ```sh
   DATABASE_URL='postgresql://…' npm run migrate:neon -- ./data.db
   ```

   The migration applies `db/schema.sql`, upserts all dashboard tables and users, and deliberately does **not** copy browser sessions. It is safe to re-run after fixing a failed transfer. If the SQLite database has no users, supply `ADMIN_PASSWORD` (at least 8 characters) to create `admin`.
5. Deploy with Vercel. For local Vercel emulation, set `DATABASE_URL` in `.env.local` (gitignored) and run `npm run dev`.

Do not run the migration against an unknown database target. Take a restorable Neon backup before a production data migration.

## Schema and migration

- `db/schema.sql` is the PostgreSQL schema to apply to a clean Neon database.
- `scripts/migrate-sqlite-to-neon.mjs` reads only the selected SQLite file and uses `DATABASE_URL` exclusively for Neon.
- `npm run check` performs JavaScript syntax checks.

## API and access control

The existing client contract is preserved:

- `POST /api/login`, `POST /api/logout`, and `GET /api/me`
- Admin-only `/api/users` management
- `GET /api/export/<table>.csv`
- `GET/POST /api/<table>` and `GET/PUT/DELETE /api/<table>/<id>` for `units`, `transactions`, `insights`, `lessons`, `master_prompts`, and `kpi_targets`

All routes except login require a persistent Postgres-backed session. The cookie is `HttpOnly`, `Secure`, and `SameSite=Strict`; the database stores only a SHA-256 digest of each random session token. Passwords use a unique random salt and Node’s scrypt KDF. Viewer accounts have read-only access. Unit accounts (`role = 'unit'`, created under จัดการผู้ใช้) are tied to one service unit: they can read their own unit and its transactions, create/update/delete only those transactions, and read KPI targets; every other table is refused on the server.

To add or replace a user after migration:

```sh
DATABASE_URL='postgresql://…' node adduser.js <user> <password> [admin|viewer]
```

The API binds every data value as a PostgreSQL parameter. Table and column identifiers are defined in server-side allowlists only. CSV exports use UTF-8 BOM for Excel-compatible Thai text.
