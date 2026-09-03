# OSU P-card Audit Workspace

A GitHub-ready submission for Part IV of the Analytics Mindset P-card assignment. It supplies both required tabs:

1. **Ask the data** — natural-language questions answered by a server-side Google Gemini assistant using the read-only SQLite database.
2. **Prohibited-purchase dashboard** — clearly separated Description and Vendor keyword searches, a year selector, instructions, and follow-up-ready transaction details.

The repository also includes `sql/assignment_queries.sql`, a complete starting set of Part II and III queries (including the seven extra control tests and four extra fraud tests). Copy each query and its results/conclusion into the assignment document before submission.

## Run locally

1. Install Node.js 20 or later.
2. In the project folder, run `npm install`.
3. Copy `.env.example` to `.env` and add your Gemini API key and an available model name.
4. Run `npm start`, then open `http://localhost:3000`.

The prohibited-purchase dashboard works without a key. The natural-language tab requires `GEMINI_API_KEY`.

## Deploy and submit

1. Create a new GitHub repository and upload all project files, including `data/pcards.db`.
2. Deploy the repository to a Node.js host such as Render, Railway, or Fly.io. Set the build command to `npm install` and start command to `npm start`.
3. In the host's **environment variables / secrets** settings, add `GEMINI_API_KEY` and optionally `GEMINI_MODEL`. Do **not** commit `.env`.
4. Add your deployed URL and GitHub repository URL to Part IV of the assignment document.

## Security

`.env` is excluded from Git. The Gemini API key is read only by `server.js` on the server; it is never sent to the browser, written to source code, or displayed in the dashboard. The assistant is limited to a single read-only `SELECT` query against `pcards`.

## Data fields

The `pcards` table contains `Year`, `Month`, `FullName`, `ID`, `AgencyNumber`, `AgencyName`, `CardholderLastName`, `CardholderFirstInitial`, `Description`, `Amount`, `Vendor`, `TransactionDate`, `PostedDate`, and `MCC`.
