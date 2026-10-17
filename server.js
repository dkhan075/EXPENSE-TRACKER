const express = require("express");
const { createClient } = require("@libsql/client");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "";
const CATEGORIES = ["Food", "Transport", "Rent", "Shopping", "Bills", "Health", "Fun", "Other"];

// Cloud: set TURSO_DATABASE_URL + TURSO_AUTH_TOKEN. Local: falls back to a file.
const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:" + (process.env.DB_PATH || path.join(__dirname, "ledger.db")),
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function init() {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS expenses (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      amount     INTEGER NOT NULL CHECK (amount > 0),
      category   TEXT NOT NULL,
      note       TEXT NOT NULL DEFAULT '',
      date       TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT OR IGNORE INTO settings (key, value) VALUES ('budget', '2000000');
  `);
}

const q = (sql, args = []) => db.execute({ sql, args });
const toRupees = (p) => Number(p) / 100;
const row = (r) => ({ id: Number(r.id), amount: toRupees(r.amount), category: r.category, note: r.note, date: r.date });
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const validMonth = (s) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
const currentMonth = () => new Date().toISOString().slice(0, 7);
const getBudget = async () => Number((await q("SELECT value FROM settings WHERE key='budget'")).rows[0].value);
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "10kb" }));

app.use("/api", (req, res, next) => {
  if (!API_KEY || req.path === "/health") return next();
  const given = Buffer.from(String(req.get("x-api-key") || ""));
  const want = Buffer.from(API_KEY);
  if (given.length === want.length && crypto.timingSafeEqual(given, want)) return next();
  res.status(401).json({ error: "Invalid or missing API key" });
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/categories", (_req, res) => res.json(CATEGORIES));

app.get("/api/expenses", h(async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!validMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const r = await q("SELECT * FROM expenses WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC", [month]);
  res.json(r.rows.map(row));
}));

app.post("/api/expenses", h(async (req, res) => {
  const { amount, category, note = "", date } = req.body || {};
  const paise = Math.round(Number(amount) * 100);
  if (!Number.isFinite(paise) || paise <= 0 || paise > 1e11) return res.status(400).json({ error: "amount must be a positive number" });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "invalid category" });
  if (!validDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  if (typeof note !== "string" || note.length > 200) return res.status(400).json({ error: "note too long (max 200)" });
  const ins = await q("INSERT INTO expenses (amount, category, note, date) VALUES (?,?,?,?)", [paise, category, note.trim(), date]);
  const r = await q("SELECT * FROM expenses WHERE id=?", [Number(ins.lastInsertRowid)]);
  res.status(201).json(row(r.rows[0]));
}));

app.delete("/api/expenses/:id", h(async (req, res) => {
  const r = await q("DELETE FROM expenses WHERE id=?", [Number(req.params.id)]);
  r.rowsAffected ? res.status(204).end() : res.status(404).json({ error: "not found" });
}));

app.delete("/api/expenses", h(async (_req, res) => {
  await q("DELETE FROM expenses");
  res.status(204).end();
}));

app.get("/api/budget", h(async (_req, res) => res.json({ amount: toRupees(await getBudget()) })));
app.put("/api/budget", h(async (req, res) => {
  const paise = Math.round(Number(req.body && req.body.amount) * 100);
  if (!Number.isFinite(paise) || paise < 0) return res.status(400).json({ error: "amount must be >= 0" });
  await q("UPDATE settings SET value=? WHERE key='budget'", [String(paise)]);
  res.json({ amount: toRupees(paise) });
}));

app.get("/api/summary", h(async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!validMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const cats = (await q("SELECT category, SUM(amount) t FROM expenses WHERE substr(date,1,7)=? GROUP BY category ORDER BY t DESC", [month])).rows;
  const total = cats.reduce((s, c) => s + Number(c.t), 0);
  const budget = await getBudget();
  res.json({
    month, total: toRupees(total), budget: toRupees(budget), left: toRupees(budget - total),
    byCategory: cats.map((c) => ({ category: c.category, total: toRupees(c.t) })),
  });
}));

app.get("/api/export.csv", h(async (_req, res) => {
  const rows = (await q("SELECT * FROM expenses ORDER BY date, id")).rows;
  const esc = (s) => `"${String(s).replace(/"/g, '""')}"`;
  res.type("text/csv").attachment("expenses.csv")
    .send(["date,category,amount,note", ...rows.map((r) => [r.date, r.category, toRupees(r.amount), esc(r.note)].join(","))].join("\n"));
}));

app.use(express.static(path.join(__dirname, "public")));
app.use("/api", (_req, res) => res.status(404).json({ error: "not found" }));
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON" });
  console.error(err);
  res.status(500).json({ error: "server error" });
});

app.ready = init();
if (require.main === module) {
  app.ready.then(() => app.listen(PORT, () => console.log(`Ledger running on http://localhost:${PORT}`)))
    .catch((e) => { console.error("Database setup failed:", e.message); process.exit(1); });
}
module.exports = app;
