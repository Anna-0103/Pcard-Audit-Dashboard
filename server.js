import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const PAGE_SIZE = 100;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Add the private Supabase connection string to the server environment.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await pool.query("SELECT 1");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "30kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function getRows(sql, parameters = []) {
  return (await pool.query(sql, parameters)).rows;
}

function pageNumber(value) {
  const page = Number.parseInt(value, 10);
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

function validateSelect(sql) {
  const clean = String(sql || "").trim().replace(/;\s*$/, "");
  if (!clean || clean.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (!/^(select|with)\b/i.test(clean)) throw new Error("The generated query must be a read-only SELECT statement.");
  if (!/\bpcards\b/i.test(clean)) throw new Error("The query must use the pcards table.");
  if (/\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|create|replace|copy|grant|revoke)\b/i.test(clean)) throw new Error("The generated query contains a blocked SQL operation.");
  const withoutPageLimit = clean.replace(/\s+LIMIT\s+\d+(?:\s+OFFSET\s+\d+)?$/i, "");
  if (/\blimit\b|\boffset\b/i.test(withoutPageLimit)) throw new Error("The generated query contains unsupported pagination.");
  return withoutPageLimit;
}

async function paginatedQuery(sql, page) {
  const total = Number((await getRows(`SELECT COUNT(*)::int AS total FROM (${sql}) AS query_results`))[0].total);
  const rows = await getRows(`${sql} LIMIT $1 OFFSET $2`, [PAGE_SIZE, (page - 1) * PAGE_SIZE]);
  return { rows, total, page, pageSize: PAGE_SIZE };
}

app.get("/api/years", async (_request, response, next) => {
  try {
    const rows = await getRows('SELECT DISTINCT "Year" AS year FROM pcards WHERE "Year" IS NOT NULL ORDER BY "Year" DESC');
    response.json({ years: rows.map((row) => row.year) });
  } catch (error) { next(error); }
});

app.get("/api/transactions", async (request, response, next) => {
  const { year, field, keyword } = request.query;
  const page = pageNumber(request.query.page);
  const sortColumns = {
    transactionDate: 'TO_TIMESTAMP("TransactionDate", \'MM/DD/YYYY HH24:MI:SS\')', postedDate: 'TO_TIMESTAMP("PostedDate", \'MM/DD/YYYY HH24:MI:SS\')', fullName: '"FullName"',
    vendor: '"Vendor"', description: '"Description"', amount: '"Amount"', mcc: '"MCC"'
  };
  const sortBy = Object.hasOwn(sortColumns, request.query.sortBy) ? request.query.sortBy : 'transactionDate';
  const sortDirection = String(request.query.sortDirection).toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  if (!/^\d{4}$/.test(String(year || ""))) return response.status(400).json({ error: "Choose a four-digit year." });
  if (!['description', 'vendor'].includes(field)) return response.status(400).json({ error: "Choose Description search or Vendor search." });
  const safeKeyword = String(keyword || "").trim();
  if (!safeKeyword) return response.status(400).json({ error: "Enter a search keyword." });
  if (safeKeyword.length > 80) return response.status(400).json({ error: "Search keywords are limited to 80 characters." });
  const column = field === 'description' ? 'Description' : 'Vendor';
  const where = `FROM pcards WHERE "Year" = $1 AND LOWER(COALESCE("${column}", '')) LIKE LOWER($2)`;
  try {
    const total = Number((await getRows(`SELECT COUNT(*)::int AS total ${where}`, [Number(year), `%${safeKeyword}%`]))[0].total);
    const rows = await getRows(
      `SELECT "TransactionDate" AS "transactionDate", "PostedDate" AS "postedDate", "FullName" AS "fullName", "Vendor" AS vendor, "Description" AS description, "Amount" AS amount, "MCC" AS mcc
       ${where} ORDER BY ${sortColumns[sortBy]} ${sortDirection}, TO_TIMESTAMP("TransactionDate", 'MM/DD/YYYY HH24:MI:SS') DESC LIMIT $3 OFFSET $4`,
      [Number(year), `%${safeKeyword}%`, PAGE_SIZE, (page - 1) * PAGE_SIZE]
    );
    response.json({ rows, total, page, pageSize: PAGE_SIZE, sortBy, sortDirection: sortDirection.toLowerCase() });
  } catch (error) { next(error); }
});

app.post("/api/ask", async (request, response) => {
  const question = String(request.body?.question || "").trim();
  const page = pageNumber(request.body?.page);
  if (!question || question.length > 500) return response.status(400).json({ error: "Enter a question of up to 500 characters." });
  if (!process.env.GEMINI_API_KEY) return response.status(503).json({ error: "Natural-language search is not configured. Add GEMINI_API_KEY to the server environment." });
  try {
    let sql = request.body?.sql ? validateSelect(request.body.sql) : null;
    let explanation = request.body?.explanation || "";
    if (!sql) {
      const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      const result = await ai.models.generateContent({
        model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
        contents: question,
        config: {
          temperature: 0,
          systemInstruction: `You are a read-only PostgreSQL analyst for OSU P-card audit data. Return JSON only. The only table is pcards with these case-sensitive columns, which must be double-quoted: Year INTEGER, Month INTEGER (1-12), FullName TEXT, ID INTEGER, AgencyNumber INTEGER, AgencyName TEXT, CardholderLastName TEXT, CardholderFirstInitial TEXT, Description TEXT, Amount NUMERIC, Vendor TEXT, TransactionDate TEXT, PostedDate TEXT, MCC TEXT.

TransactionDate and PostedDate are text in M/D/YYYY H:MM:SS format. Whenever sorting, comparing, or grouping by calendar day, use TO_TIMESTAMP("TransactionDate", 'MM/DD/YYYY HH24:MI:SS') or TO_TIMESTAMP("PostedDate", 'MM/DD/YYYY HH24:MI:SS'); use CAST(... AS DATE) when the request says "same day".

Assignment audit rules: When the question is an OSU P-card / Part II / Part III style question and the user does not state a different scope, include BOTH "Year" = 2014 AND "AgencyName" = 'OKLAHOMA STATE UNIVERSITY'. For a spending, purchase, split-purchase, duplicate-purchase, or prohibited-purchase test, use "Amount" > 0 unless the user explicitly asks about credits, returns, or negative transactions. If a grouped purchase test uses "Amount" > 0, apply that same filter both inside the grouping query and again when returning the detailed transaction rows.

For the assigned split-purchase controls, preserve these precise rules when applicable: (1) same cardholder + same vendor + same calendar day: group positive transactions by "FullName", "Vendor", and CAST(TO_TIMESTAMP("TransactionDate", 'MM/DD/YYYY HH24:MI:SS') AS DATE); require COUNT(*) > 1 and SUM("Amount") > 5000; then return the matching positive detail rows. (2) two cardholders at one vendor: group positive transactions by "Vendor" and calendar day; require COUNT(*) = 2, COUNT(DISTINCT "FullName") = 2, and SUM("Amount") > 5000; then return the matching positive detail rows. (3) one cardholder at two vendors: group positive transactions by "FullName" and calendar day; require COUNT(*) = 2, COUNT(DISTINCT "Vendor") = 2, and SUM("Amount") > 5000; then return the matching positive detail rows. These are potential exceptions only, not proof of wrongdoing.

Write exactly one PostgreSQL SELECT or WITH query against pcards. Never change data. Prefer "Year" = 2014 when the user does not specify a year. Do not use query parameters, LIMIT, or OFFSET; the website handles pagination. Also give a short plain-language explanation of the result. Treat audit flags as potential exceptions, never proof of wrongdoing.`,
          responseMimeType: "application/json",
          responseJsonSchema: { type: "object", properties: { sql: { type: "string" }, explanation: { type: "string" } }, required: ["sql", "explanation"] }
        }
      });
      const proposed = JSON.parse(result.text);
      sql = validateSelect(proposed.sql);
      explanation = proposed.explanation;
    }
    response.json({ sql, explanation, ...(await paginatedQuery(sql, page)) });
  } catch (error) {
    console.error("Natural-language query failed:", error.message);
    response.status(400).json({ error: "I could not safely answer that question. Try a more specific audit question." });
  }
});

app.use((error, _request, response, _next) => {
  console.error("Server error:", error.message);
  response.status(500).json({ error: "The database request could not be completed. Please try again." });
});

app.listen(port, () => console.log(`P-card audit dashboard running at http://localhost:${port}`));
