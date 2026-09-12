import "dotenv/config";
import express from "express";
import { GoogleGenAI } from "@google/genai";
import pg from "pg";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const MAX_ROWS = 200;

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set. Add the private Supabase connection string to the server environment.");

const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await pool.query("SELECT 1");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

async function getRows(sql, parameters = []) {
  return (await pool.query(sql, parameters)).rows;
}

function validateSelect(sql) {
  const clean = String(sql || "").trim().replace(/;\s*$/, "");
  if (!clean || clean.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (!/^(select|with)\b/i.test(clean)) throw new Error("The generated query must be a read-only SELECT statement.");
  if (!/\bpcards\b/i.test(clean)) throw new Error("The query must use the pcards table.");
  if (/\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|create|replace|copy|grant|revoke)\b/i.test(clean)) throw new Error("The generated query contains a blocked SQL operation.");
  const limit = clean.match(/\blimit\s+(\d+)/i);
  if (limit && Number(limit[1]) > MAX_ROWS) throw new Error(`Queries may return at most ${MAX_ROWS} rows.`);
  return limit ? clean : `${clean} LIMIT ${MAX_ROWS}`;
}

app.get("/api/years", async (_request, response, next) => {
  try {
    const rows = await getRows('SELECT DISTINCT "Year" AS year FROM pcards WHERE "Year" IS NOT NULL ORDER BY "Year" DESC');
    response.json({ years: rows.map((row) => row.year) });
  } catch (error) { next(error); }
});

app.get("/api/transactions", async (request, response, next) => {
  const { year, field, keyword } = request.query;
  if (!/^\d{4}$/.test(String(year || ""))) return response.status(400).json({ error: "Choose a four-digit year." });
  if (!['description', 'vendor'].includes(field)) return response.status(400).json({ error: "Choose Description search or Vendor search." });
  const safeKeyword = String(keyword || "").trim();
  if (!safeKeyword) return response.status(400).json({ error: "Enter a search keyword." });
  if (safeKeyword.length > 80) return response.status(400).json({ error: "Search keywords are limited to 80 characters." });
  const column = field === 'description' ? 'Description' : 'Vendor';
  try {
    const rows = await getRows(
      `SELECT "TransactionDate" AS "transactionDate", "PostedDate" AS "postedDate", "FullName" AS "fullName", "Vendor" AS vendor, "Description" AS description, "Amount" AS amount, "MCC" AS mcc
       FROM pcards WHERE "Year" = $1 AND LOWER(COALESCE("${column}", '')) LIKE LOWER($2)
       ORDER BY "TransactionDate" DESC, "Amount" DESC LIMIT ${MAX_ROWS}`,
      [Number(year), `%${safeKeyword}%`]
    );
    response.json({ rows, truncated: rows.length === MAX_ROWS });
  } catch (error) { next(error); }
});

app.post("/api/ask", async (request, response) => {
  const question = String(request.body?.question || "").trim();
  if (!question || question.length > 500) return response.status(400).json({ error: "Enter a question of up to 500 characters." });
  if (!process.env.GEMINI_API_KEY) return response.status(503).json({ error: "Natural-language search is not configured. Add GEMINI_API_KEY to the server environment." });
  try {
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const result = await ai.models.generateContent({
      model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
      contents: question,
      config: {
        temperature: 0,
        systemInstruction: `You are a read-only PostgreSQL analyst for OSU P-card audit data. Return JSON only. The only table is pcards with these case-sensitive columns, which must be double-quoted: Year INTEGER, Month INTEGER (1-12), FullName TEXT, ID INTEGER, AgencyNumber INTEGER, AgencyName TEXT, CardholderLastName TEXT, CardholderFirstInitial TEXT, Description TEXT, Amount NUMERIC, Vendor TEXT, TransactionDate TEXT, PostedDate TEXT, MCC TEXT. Write exactly one PostgreSQL SELECT or WITH query against pcards. Never change data. Prefer "Year" = 2014 when the user does not specify a year. Always include a LIMIT of 200 or fewer. Also give a short plain-language explanation of the result. Treat audit flags as potential exceptions, never proof of wrongdoing.`,
        responseMimeType: "application/json",
        responseJsonSchema: { type: "object", properties: { sql: { type: "string" }, explanation: { type: "string" } }, required: ["sql", "explanation"] }
      }
    });
    const proposed = JSON.parse(result.text);
    const sql = validateSelect(proposed.sql);
    const rows = await getRows(sql);
    response.json({ sql, explanation: proposed.explanation, rows, truncated: rows.length === MAX_ROWS });
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
