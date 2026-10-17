const express = require("express");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "ledger.db");
const API_KEY = process.env.API_KEY || "";
const CATEGORIES = ["Food", "Transport", "Rent", "Shopping", "Bills", "Health", "Fun", "Other"];

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS expenses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    amount     INTEGER NOT NULL CHECK (amount > 0),   -- stored in paise
    category   TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    date       TEXT NOT NULL,                         -- YYYY-MM-DD
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT OR IGNORE INTO settings (key, value) VALUES ('budget', '2000000');
`);

const toRupees = (p) => p / 100;
const row = (r) => ({ id: r.id, amount: toRupees(r.amount), category: r.category, note: r.note, date: r.date });
const validDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const validMonth = (s) => /^\d{4}-\d{2}$/.test(s);
const currentMonth = () => new Date().toISOString().slice(0, 7);
const getBudget = () => Number(db.prepare("SELECT value FROM settings WHERE key='budget'").get().value);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

// Optional API-key auth (set API_KEY env var when deploying publicly)
app.use("/api", (req, res, next) => {
  if (!API_KEY || req.path === "/health") return next();
  const given = Buffer.from(String(req.get("x-api-key") || ""));
  const want = Buffer.from(API_KEY);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.status(401).json({ error: "Invalid or missing API key" });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/categories", (_req, res) => res.json(CATEGORIES));

app.get("/api/expenses", (req, res) => {
  const month = req.query.month || currentMonth();
  if (!validMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const rows = db.prepare("SELECT * FROM expenses WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC").all(month);
  res.json(rows.map(row));
});

app.post("/api/expenses", (req, res) => {
  const { amount, category, note = "", date } = req.body || {};
  const paise = Math.round(Number(amount) * 100);
  if (!Number.isFinite(paise) || paise <= 0 || paise > 1e11) return res.status(400).json({ error: "amount must be a positive number" });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "invalid category" });
  if (!validDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  if (typeof note !== "string" || note.length > 200) return res.status(400).json({ error: "note too long (max 200)" });
  const info = db.prepare("INSERT INTO expenses (amount, category, note, date) VALUES (?,?,?,?)").run(paise, category, note.trim(), date);
  res.status(201).json(row(db.prepare("SELECT * FROM expenses WHERE id=?").get(info.lastInsertRowid)));
});

app.delete("/api/expenses/:id", (req, res) => {
  const info = db.prepare("DELETE FROM expenses WHERE id=?").run(Number(req.params.id));
  info.changes ? res.status(204).end() : res.status(404).json({ error: "not found" });
});

app.delete("/api/expenses", (_req, res) => {
  db.prepare("DELETE FROM expenses").run();
  res.status(204).end();
});

app.get("/api/budget", (_req, res) => res.json({ amount: toRupees(getBudget()) }));
app.put("/api/budget", (req, res) => {
  const paise = Math.round(Number(req.body && req.body.amount) * 100);
  if (!Number.isFinite(paise) || paise < 0) return res.status(400).json({ error: "amount must be >= 0" });
  db.prepare("UPDATE settings SET value=? WHERE key='budget'").run(String(paise));
  res.json({ amount: toRupees(paise) });
});

app.get("/api/summary", (req, res) => {
  const month = req.query.month || currentMonth();
  if (!validMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const cats = db.prepare("SELECT category, SUM(amount) t FROM expenses WHERE substr(date,1,7)=? GROUP BY category ORDER BY t DESC").all(month);
  const total = cats.reduce((s, c) => s + c.t, 0);
  const budget = getBudget();
  res.json({
    month, total: toRupees(total), budget: toRupees(budget), left: toRupees(budget - total),
    byCategory: cats.map((c) => ({ category: c.category, total: toRupees(c.t) })),
  });
});

app.get("/api/export.csv", (_req, res) => {
  const rows = db.prepare("SELECT * FROM expenses ORDER BY date, id").all();
  const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
  res.type("text/csv").attachment("expenses.csv")
    .send(["date,category,amount,note", ...rows.map((r) => [r.date, r.category, toRupees(r.amount), q(r.note)].join(","))].join("\n"));
});

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

if (require.main === module) app.listen(PORT, () => console.log(`Ledger running on http://localhost:${PORT}`));
module.exports = app;
