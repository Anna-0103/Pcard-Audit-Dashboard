import "dotenv/config";
import initSqlJs from "sql.js";
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { Pool } = pg;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sqlitePath = process.env.SQLITE_DB_PATH || path.join(root, "data", "pcards.db");
const replaceExisting = process.argv.includes("--replace");
const columns = ["Year", "Month", "FullName", "ID", "AgencyNumber", "AgencyName", "CardholderLastName", "CardholderFirstInitial", "Description", "Amount", "Vendor", "TransactionDate", "PostedDate", "MCC"];

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Put it in a local .env file for the import.");
if (!fs.existsSync(sqlitePath)) throw new Error(`SQLite file not found: ${sqlitePath}`);

const SQL = await initSqlJs({ locateFile: (file) => path.join(root, "node_modules", "sql.js", "dist", file) });
const sqlite = new SQL.Database(fs.readFileSync(sqlitePath));
const exported = sqlite.exec(`SELECT ${columns.map((column) => `"${column}"`).join(", ")} FROM pcards`);
if (!exported.length) throw new Error("The SQLite database has no pcards data.");
const rows = exported[0].values;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const quotedColumns = columns.map((column) => `"${column}"`).join(", ");
const types = '"Year" INTEGER, "Month" INTEGER, "FullName" TEXT, "ID" INTEGER, "AgencyNumber" INTEGER, "AgencyName" TEXT, "CardholderLastName" TEXT, "CardholderFirstInitial" TEXT, "Description" TEXT, "Amount" NUMERIC, "Vendor" TEXT, "TransactionDate" TEXT, "PostedDate" TEXT, "MCC" TEXT';

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS pcards (${types})`);
  const existing = Number((await pool.query('SELECT COUNT(*)::int AS count FROM pcards')).rows[0].count);
  if (existing && !replaceExisting) throw new Error(`The hosted table already has ${existing} rows. Run again with --replace only if you intend to overwrite it.`);
  if (existing) await pool.query('TRUNCATE TABLE pcards');
  const batchSize = 250;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const parameters = [];
    const values = batch.map((row, rowIndex) => {
      parameters.push(...row);
      return `(${row.map((_value, columnIndex) => `$${rowIndex * columns.length + columnIndex + 1}`).join(", ")})`;
    });
    await pool.query(`INSERT INTO pcards (${quotedColumns}) VALUES ${values.join(", ")}`, parameters);
    console.log(`Imported ${Math.min(start + batch.length, rows.length)} of ${rows.length} rows`);
  }
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pcards_year ON pcards ("Year")');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pcards_vendor ON pcards ("Vendor")');
  await pool.query('CREATE INDEX IF NOT EXISTS idx_pcards_description ON pcards ("Description")');
  console.log("Import complete. The hosted database is ready.");
} finally {
  sqlite.close();
  await pool.end();
}
