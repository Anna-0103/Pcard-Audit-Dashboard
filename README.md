# OSU P-card Audit Dashboard

A two-tab audit website for the P-card assignment.

- **Ask the database:** Gemini converts an audit question into one read-only PostgreSQL query. The server rejects non-SELECT statements and limits results.
- **Prohibited purchases:** searches descriptions or vendors for potential prohibited purchases by year.

## Keep these private

The Gemini key and database connection string are read only by the server. Never commit `.env`, `data/pcards.db`, `node_modules`, a Gemini key, or a Supabase connection string to GitHub.

## One-time database import

1. Create a Supabase PostgreSQL project.
2. In Supabase, click **Connect** and copy the **Session pooler** connection string.
3. Copy `.env.example` to `.env` and replace the `DATABASE_URL` placeholder with that connection string. Replace `[YOUR-PASSWORD]` with your database password. Do not upload this file.
4. Keep the supplied SQLite file at `data/pcards.db`.
5. Run `npm install`, then run `npm run migrate:sqlite-to-postgres`.
6. Wait for `Import complete. The hosted database is ready.`

The importer creates the `pcards` table and transfers the supplied data. It refuses to overwrite an existing hosted table unless you explicitly use `npm run migrate:sqlite-to-postgres -- --replace`.

## Run locally after import

With the same local `.env` file in place, run:

```text
npm start
```

Then open `http://localhost:3000`.

## Render deployment

Create a Node web service from this GitHub repository. Use `npm install` as the build command and `npm start` as the start command. Add these environment variables in Render:

```text
DATABASE_URL=your private Supabase session-pooler connection string
GEMINI_API_KEY=your Gemini key
GEMINI_MODEL=gemini-2.5-flash
```

Do not add `PORT`; Render supplies it automatically. The public website can query the private hosted database, but neither secret is sent to the browser.

## Notes for assessment

Search results are potential exceptions, not confirmed control violations or fraud. The natural-language tab displays the read-only SQL used so auditors can review the logic.
