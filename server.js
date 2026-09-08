import "dotenv/config";
import express from "express";
import initSqlJs from "sql.js";
import { GoogleGenAI } from "@google/genai";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const databasePath = process.env.DB_PATH || path.join(__dirname, "data", "pcards.db");
const port = Number(process.env.PORT || 3000);
const MAX_ROWS = 200;

if (!fs.existsSync(databasePath)) {
  throw new Error(`Database not found at ${databasePath}. Copy pcards.db into the data folder or set DB_PATH.`);
}

const SQL = await initSqlJs({
  locateFile: (file) => path.join(__dirname, "node_modules", "sql.js", "dist", file)
});
const db = new SQL.Database(fs.readFileSync(databasePath));
const app = express();

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));

function rowsFrom(result) {
  if (!result.length) return [];
  const [{ columns, values }] = result;
  return values.map((valueRow) => Object.fromEntries(columns.map((column, i) => [column, valueRow[i]])));
}

function getRows(sql, parameters = []) {
  const statement = db.prepare(sql);
  statement.bind(parameters);
  const rows = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

function validateSelect(sql) {
  const clean = String(sql || "").trim().replace(/;\s*$/, "");
  if (!clean || clean.includes(";")) throw new Error("Only one SQL statement is allowed.");
  if (!/^(select|with)\b/i.test(clean)) throw new Error("The generated query must be a read-only SELECT statement.");
  if (!/\bpcards\b/i.test(clean)) throw new Error("The query must use the pcards table.");
  if (/\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|create|replace|load_extension)\b/i.test(clean)) {
    throw new Error("The generated query contains a blocked SQL operation.");
  }
  const limit = clean.match(/\blimit\s+(\d+)/i);
  if (limit && Number(limit[1]) > MAX_ROWS) throw new Error(`Queries may return at most ${MAX_ROWS} rows.`);
  return limit ? clean : `${clean} LIMIT ${MAX_ROWS}`;
}

app.get("/api/years", (_request, response) => {
  response.json({ years: getRows('SELECT DISTINCT "Year" AS year FROM pcards WHERE "Year" IS NOT NULL ORDER BY "Year" DESC').map((row) => row.year) });
});

app.get("/api/transactions", (request, response) => {
  const { year, field, keyword } = request.query;
  if (!/^\d{4}$/.test(String(year || ""))) return response.status(400).json({ error: "Choose a four-digit year." });
  if (!['description', 'vendor'].includes(field)) return response.status(400).json({ error: "Choose Description search or Vendor search." });
  const safeKeyword = String(keyword || "").trim();
  if (!safeKeyword) return response.status(400).json({ error: "Enter a search keyword." });
  if (safeKeyword.length > 80) return response.status(400).json({ error: "Search keywords are limited to 80 characters." });
  const column = field === 'description' ? 'Description' : 'Vendor';
  const rows = getRows(
    `SELECT "TransactionDate" AS transactionDate, "PostedDate" AS postedDate, "FullName" AS fullName,
            "Vendor" AS vendor, "Description" AS description, "Amount" AS amount, "MCC" AS mcc
     FROM pcards
     WHERE "Year" = ? AND LOWER(COALESCE("${column}", '')) LIKE LOWER(?)
     ORDER BY "TransactionDate" DESC, "Amount" DESC
     LIMIT ${MAX_ROWS}`,
    [Number(year), `%${safeKeyword}%`]
  );
  response.json({ rows, truncated: rows.length === MAX_ROWS });
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
        systemInstruction: `You are a read-only SQLite analyst for OSU P-card audit data. Return JSON only. The only table is pcards with these columns: Year INTEGER, Month INTEGER (1-12), FullName TEXT, ID INTEGER, AgencyNumber INTEGER, AgencyName TEXT, CardholderLastName TEXT, CardholderFirstInitial TEXT, Description TEXT, Amount REAL, Vendor TEXT, TransactionDate TEXT, PostedDate TEXT, MCC TEXT. Write exactly one SQLite SELECT or WITH query against pcards. Never change data. Prefer Year = 2014 when the user does not specify a year. Always include a LIMIT of 200 or fewer. Also give a short plain-language explanation of the result. Treat audit flags as potential exceptions, never proof of wrongdoing.`,
        responseMimeType: "application/json",
        responseJsonSchema: {
          type: "object",
          properties: {
            sql: { type: "string" },
            explanation: { type: "string" }
          },
          required: ["sql", "explanation"]
        }
      }
    });
    const proposed = JSON.parse(result.text);
    const sql = validateSelect(proposed.sql);
    const rows = rowsFrom(db.exec(sql));
    response.json({ sql, explanation: proposed.explanation, rows, truncated: rows.length === MAX_ROWS });
  } catch (error) {
    console.error("Natural-language query failed:", error.message);
    response.status(400).json({ error: "I could not safely answer that question. Try a more specific audit question." });
  }
});

app.listen(port, () => console.log(`P-card audit dashboard running at http://localhost:${port}`));
