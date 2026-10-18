const express = require("express");
const { createClient } = require("@libsql/client");
const { OAuth2Client } = require("google-auth-library");
const crypto = require("crypto");
const path = require("path");

const PORT = process.env.PORT || 3000;
const CATEGORIES = ["Food", "Transport", "Rent", "Shopping", "Bills", "Health", "Fun", "Other"];
const SESSION_MS = 30 * 24 * 3600 * 1000;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
const ALLOWED = (process.env.ALLOWED_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const db = createClient({
  url: process.env.TURSO_DATABASE_URL || "file:" + (process.env.DB_PATH || path.join(__dirname, "ledger.db")),
  authToken: process.env.TURSO_AUTH_TOKEN,
});
const q = (sql, args = []) => db.execute({ sql, args });
const cols = async (t) => (await q(`PRAGMA table_info(${t})`)).rows.map((r) => r.name);

async function init() {
  await q(`CREATE TABLE IF NOT EXISTS expenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount INTEGER NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    date TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    user_id INTEGER)`);
  if (!(await cols("expenses")).includes("user_id")) await q("ALTER TABLE expenses ADD COLUMN user_id INTEGER");
  // Databases from the phone/password versions: park old accounts, orphan their expenses
  // (the owner's first Google sign-in adopts them), and end all old sessions.
  if ((await cols("users")).includes("phone")) {
    await q("UPDATE expenses SET user_id=NULL");
    await q("DROP TABLE IF EXISTS sessions");
    await q("DROP TABLE IF EXISTS users_old");
    await q("ALTER TABLE users RENAME TO users_old");
  }
  await q(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT '',
    budget INTEGER NOT NULL DEFAULT 2000000,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  await q("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
  await q("CREATE INDEX IF NOT EXISTS idx_expenses_user_date ON expenses(user_id, date)");
}

const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const toRupees = (p) => Number(p) / 100;
const row = (r) => ({ id: Number(r.id), amount: toRupees(r.amount), category: r.category, note: r.note, date: r.date });
const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const validMonth = (s) => typeof s === "string" && /^\d{4}-\d{2}$/.test(s);
const currentMonth = () => new Date().toISOString().slice(0, 7);
const h = (fn) => (req, res, next) => fn(req, res, next).catch(next);

function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const n = Date.now(); for (const [k, e] of hits) if (e.reset < n) hits.delete(k); }, 60000).unref();
  return (req, res, next) => {
    const now = Date.now();
    let e = hits.get(req.ip);
    if (!e || e.reset < now) { e = { count: 0, reset: now + windowMs }; hits.set(req.ip, e); }
    if (++e.count > max) return res.status(429).json({ error: "Too many attempts, try again later" });
    next();
  };
}

const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use((_req, res, next) => { res.set({ "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer" }); next(); });
app.use(express.json({ limit: "10kb" }));
app.use("/api", (_req, res, next) => { res.set("Cache-Control", "no-store"); next(); });

const gclient = new OAuth2Client();
// Checks Google's signature, audience (our client ID) and expiry. Tests replace this.
app.verifyGoogle = async (credential) =>
  (await gclient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID })).getPayload();

async function newSession(uid) {
  const token = crypto.randomBytes(32).toString("hex");
  await q("DELETE FROM sessions WHERE expires_at < ?", [Date.now()]);
  await q("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)", [sha(token), uid, Date.now() + SESSION_MS]);
  return token;
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/config", (_req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID || null }));

app.post("/api/auth/google", limiter(30, 15 * 60 * 1000), h(async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return res.status(503).json({ error: "Google sign-in isn’t set up on this server yet" });
  const credential = req.body && req.body.credential;
  if (typeof credential !== "string" || credential.length > 4096) return res.status(400).json({ error: "Missing Google credential" });
  let p;
  try { p = await app.verifyGoogle(credential); }
  catch (e) { return res.status(401).json({ error: "Google sign-in failed. Please try again." }); }
  const email = String(p.email || "").toLowerCase();
  if (!p.sub || !email || p.email_verified !== true) return res.status(401).json({ error: "Your Google email isn’t verified" });
  if (ALLOWED.length && !ALLOWED.includes(email) && email !== OWNER_EMAIL)
    return res.status(403).json({ error: "This Google account isn’t allowed to use this tracker" });
  let u = (await q("SELECT id FROM users WHERE google_sub=?", [p.sub])).rows[0];
  if (!u) {
    const first = Number((await q("SELECT COUNT(*) c FROM users")).rows[0].c) === 0;
    await q("INSERT OR IGNORE INTO users (google_sub, email, name) VALUES (?,?,?)", [p.sub, email, p.name || ""]);
    u = (await q("SELECT id FROM users WHERE google_sub=?", [p.sub])).rows[0];
    // Expenses saved before Google login existed go to the owner (or, if OWNER_EMAIL isn't set, the first person to sign in)
    if (OWNER_EMAIL ? email === OWNER_EMAIL : first) await q("UPDATE expenses SET user_id=? WHERE user_id IS NULL", [Number(u.id)]);
  } else {
    await q("UPDATE users SET email=?, name=? WHERE id=?", [email, p.name || "", u.id]);
  }
  res.json({ token: await newSession(Number(u.id)), email, name: p.name || "" });
}));

// ---------- everything below needs a logged-in session ----------
app.use("/api", h(async (req, res, next) => {
  const m = /^Bearer (.+)$/.exec(req.get("authorization") || "");
  if (!m) return res.status(401).json({ error: "Please log in" });
  const r = await q("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?", [sha(m[1]), Date.now()]);
  if (!r.rows.length) return res.status(401).json({ error: "Please log in" });
  req.userId = Number(r.rows[0].user_id);
  req.tokenHash = sha(m[1]);
  next();
}));

app.get("/api/me", h(async (req, res) => {
  const u = (await q("SELECT email, name FROM users WHERE id=?", [req.userId])).rows[0];
  res.json({ email: u.email, name: u.name });
}));
app.post("/api/logout", h(async (req, res) => {
  await q("DELETE FROM sessions WHERE token_hash=?", [req.tokenHash]);
  res.status(204).end();
}));
app.get("/api/categories", (_req, res) => res.json(CATEGORIES));

app.get("/api/expenses", h(async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!validMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const r = await q("SELECT * FROM expenses WHERE user_id=? AND substr(date,1,7)=? ORDER BY date DESC, id DESC", [req.userId, month]);
  res.json(r.rows.map(row));
}));

app.post("/api/expenses", h(async (req, res) => {
  const { amount, category, note = "", date } = req.body || {};
  const paise = Math.round(Number(amount) * 100);
  if (!Number.isFinite(paise) || paise <= 0 || paise > 1e11) return res.status(400).json({ error: "amount must be a positive number" });
  if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "invalid category" });
  if (!validDate(date)) return res.status(400).json({ error: "date must be YYYY-MM-DD" });
  if (typeof note !== "string" || note.length > 200) return res.status(400).json({ error: "note too long (max 200)" });
  const ins = await q("INSERT INTO expenses (amount, category, note, date, user_id) VALUES (?,?,?,?,?)", [paise, category, note.trim(), date, req.userId]);
  res.status(201).json(row((await q("SELECT * FROM expenses WHERE id=?", [Number(ins.lastInsertRowid)])).rows[0]));
}));

app.delete("/api/expenses/:id", h(async (req, res) => {
  const r = await q("DELETE FROM expenses WHERE id=? AND user_id=?", [Number(req.params.id), req.userId]);
  r.rowsAffected ? res.status(204).end() : res.status(404).json({ error: "not found" });
}));
app.delete("/api/expenses", h(async (req, res) => {
  await q("DELETE FROM expenses WHERE user_id=?", [req.userId]);
  res.status(204).end();
}));

const getBudget = async (uid) => Number((await q("SELECT budget FROM users WHERE id=?", [uid])).rows[0].budget);
app.get("/api/budget", h(async (req, res) => res.json({ amount: toRupees(await getBudget(req.userId)) })));
app.put("/api/budget", h(async (req, res) => {
  const paise = Math.round(Number(req.body && req.body.amount) * 100);
  if (!Number.isFinite(paise) || paise < 0) return res.status(400).json({ error: "amount must be >= 0" });
  await q("UPDATE users SET budget=? WHERE id=?", [paise, req.userId]);
  res.json({ amount: toRupees(paise) });
}));

app.get("/api/summary", h(async (req, res) => {
  const month = req.query.month || currentMonth();
  if (!validMonth(month)) return res.status(400).json({ error: "month must be YYYY-MM" });
  const cats = (await q("SELECT category, SUM(amount) t FROM expenses WHERE user_id=? AND substr(date,1,7)=? GROUP BY category ORDER BY t DESC", [req.userId, month])).rows;
  const total = cats.reduce((s, c) => s + Number(c.t), 0);
  const budget = await getBudget(req.userId);
  res.json({ month, total: toRupees(total), budget: toRupees(budget), left: toRupees(budget - total),
    byCategory: cats.map((c) => ({ category: c.category, total: toRupees(c.t) })) });
}));

app.get("/api/export.csv", h(async (req, res) => {
  const rows = (await q("SELECT * FROM expenses WHERE user_id=? ORDER BY date, id", [req.userId])).rows;
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
  app.ready.then(() => app.listen(PORT, () => console.log(`Ledger running on http://localhost:${PORT}` + (GOOGLE_CLIENT_ID ? "" : " (GOOGLE_CLIENT_ID not set)"))))
    .catch((e) => { console.error("Database setup failed:", e.message); process.exit(1); });
}
module.exports = app;
