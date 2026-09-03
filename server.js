require("dotenv").config();

const path = require("path");
const express = require("express");
const Database = require("better-sqlite3");
const { GoogleGenAI } = require("@google/genai");

const app = express();
const db = new Database(path.join(__dirname, "data", "pcards.db"), { readonly: true });
const gemini = process.env.GEMINI_API_KEY ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const columns = ["Year", "Month", "FullName", "ID", "AgencyNumber", "AgencyName", "CardholderLastName", "CardholderFirstInitial", "Description", "Amount", "Vendor", "TransactionDate", "PostedDate", "MCC"];
const prohibited = ["alcohol", "cash", "cash advance", "atm", "decoration", "donation", "sponsorship", "gasoline", "gift", "gift card", "gift certificate", "insurance", "late fee", "mail", "postage", "moving", "personal", "membership", "dues", "salary", "wage", "benefit", "service award", "incentive award"];

function readOnlySql(sql) {
  const normalized = String(sql || "").trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(normalized) || /\b(insert|update|delete|drop|alter|attach|detach|pragma|vacuum|create|replace)\b/i.test(normalized)) {
    throw new Error("Only a single read-only SELECT query is allowed.");
  }
  if (!/\bpcards\b/i.test(normalized)) throw new Error("Queries must use the pcard transactions table.");
  return /\blimit\b/i.test(normalized) ? normalized : `${normalized} LIMIT 200`;
}

app.get("/api/years", (req, res) => {
  res.json(db.prepare('SELECT DISTINCT "Year" AS year FROM pcards ORDER BY "Year"').all());
});

app.get("/api/search", (req, res) => {
  const field = req.query.field === "Vendor" ? "Vendor" : "Description";
  const keyword = String(req.query.keyword || "").trim();
  const year = Number(req.query.year);
  if (!keyword) return res.status(400).json({ error: "Enter a keyword to search." });
  if (!Number.isInteger(year)) return res.status(400).json({ error: "Select a valid year." });
  const rows = db.prepare(`SELECT "TransactionDate", "PostedDate", "FullName", "Amount", "Vendor", "Description", "MCC"
    FROM pcards WHERE "Year" = ? AND lower("${field}") LIKE lower(?)
    ORDER BY date(substr("TransactionDate", 7, 4) || '-' || substr("TransactionDate", 1, instr("TransactionDate", '/') - 1) || '-' || substr("TransactionDate", instr("TransactionDate", '/') + 1, instr("TransactionDate", ' ') - instr("TransactionDate", '/') - 1)), "Amount" DESC LIMIT 500`).all(year, `%${keyword}%`);
  res.json({ field, keyword, year, count: rows.length, rows });
});

app.post("/api/ask", async (req, res) => {
  const question = String(req.body.question || "").trim();
  if (!question) return res.status(400).json({ error: "Ask a question about the P-card data." });
  if (!gemini) return res.status(503).json({ error: "The AI assistant is not configured. Add GEMINI_API_KEY to your hosting provider's secret settings." });

  const tool = {
    type: "function",
    name: "query_pcards",
    description: "Run one read-only SQLite SELECT query on the pcard transactions data. The table is pcards. Use quoted column names. Dates are text in M/D/YYYY format. Return no more than 200 rows.",
    parameters: {
      type: "object",
      properties: { sql: { type: "string", description: "A single SQLite SELECT statement." } },
      required: ["sql"]
    }
  };
  const instructions = `You are an audit-data assistant. Answer only from the SQLite table pcards, whose columns are: ${columns.join(", ")}. You MUST call query_pcards before answering factual questions about transactions. Restrict to 2014 unless the user asks otherwise. Explain that flags are leads for follow-up, not proof of misconduct. Never request or reveal API keys.`;
  try {
    const prompt = `${instructions}\n\nUser question: ${question}`;
    const history = [{ type: "user_input", content: [{ type: "text", text: prompt }] }];
    const first = await gemini.interactions.create({ model: process.env.GEMINI_MODEL || "gemini-3.7-flash", input: history, tools: [tool], store: false });
    history.push(...first.steps);
    const call = first.steps.find(step => step.type === "function_call" && step.name === "query_pcards");
    if (!call) return res.json({ answer: first.output_text || "No answer was returned." });
    const safeSql = readOnlySql(call.arguments.sql);
    const rows = db.prepare(safeSql).all();
    history.push({ type: "function_result", name: call.name, call_id: call.id, result: [{ type: "text", text: JSON.stringify({ sql: safeSql, row_count: rows.length, rows }) }] });
    const final = await gemini.interactions.create({ model: process.env.GEMINI_MODEL || "gemini-3.7-flash", input: history, tools: [tool], store: false });
    res.json({ answer: final.output_text || "No answer was returned." });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "The assistant could not complete that query. Try a more specific question." });
  }
});

app.listen(PORT, () => console.log(`P-card Audit Dashboard is running on port ${PORT}.`));
