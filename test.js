process.env.TURSO_DATABASE_URL = ":memory:";
process.env.GOOGLE_CLIENT_ID = "test-client";
process.env.OWNER_EMAIL = "a@x.com";
process.env.ALLOWED_EMAILS = "b@x.com";
const assert = require("assert");
const app = require("./server");
// Stand-in for Google's check: "tok:<sub>:<email>[:no]"
app.verifyGoogle = async (c) => {
  if (!c.startsWith("tok:")) throw new Error("bad token");
  const [, sub, email, v] = c.split(":");
  return { sub, email, name: sub.toUpperCase(), email_verified: v !== "no" };
};
app.ready.then(() => {
  const srv = app.listen(0, async () => {
    const base = `http://localhost:${srv.address().port}`;
    const f = (m, u, b, t) => fetch(base + u, { method: m, headers: { "Content-Type": "application/json", ...(t ? { Authorization: "Bearer " + t } : {}) }, body: b && JSON.stringify(b) });
    const st = async (...a) => (await f(...a)).status;
    const google = async (cred) => f("POST", "/api/auth/google", { credential: cred });
    try {
      assert.equal((await (await f("GET", "/api/config")).json()).googleClientId, "test-client");
      assert.equal(await st("GET", "/api/expenses"), 401);
      assert.equal((await google("garbage")).status, 401, "fake Google token rejected");
      assert.equal((await google("tok:u1:a@x.com:no")).status, 401, "unverified email rejected");
      assert.equal((await google("tok:u9:c@x.com")).status, 403, "not on the allow-list");
      const a = await (await google("tok:u1:a@x.com")).json();
      const b = await (await google("tok:u2:b@x.com")).json();
      assert.equal(a.email, "a@x.com");
      await f("POST", "/api/expenses", { amount: 100, category: "Food", date: "2026-10-01" }, a.token);
      await f("POST", "/api/expenses", { amount: 999, category: "Fun", date: "2026-10-03" }, b.token);
      const la = await (await f("GET", "/api/expenses?month=2026-10", null, a.token)).json();
      const lb = await (await f("GET", "/api/expenses?month=2026-10", null, b.token)).json();
      assert.equal(la.length, 1); assert.equal(lb.length, 1);
      assert.equal(la[0].amount, 100); assert.equal(lb[0].amount, 999);
      assert.equal(await st("DELETE", `/api/expenses/${la[0].id}`, null, b.token), 404, "can't touch others' data");
      const a2 = await (await google("tok:u1:a@x.com")).json();
      assert.equal((await (await f("GET", "/api/expenses?month=2026-10", null, a2.token)).json()).length, 1, "same Google account = same data");
      await f("PUT", "/api/budget", { amount: 5000 }, a.token);
      assert.equal((await (await f("GET", "/api/budget", null, b.token)).json()).amount, 20000, "budgets are per user");
      assert.equal((await (await f("GET", "/api/me", null, a.token)).json()).email, "a@x.com");
      assert.equal(await st("POST", "/api/logout", null, a.token), 204);
      assert.equal(await st("GET", "/api/me", null, a.token), 401);
      console.log("All tests passed");
    } catch (e) { console.error("FAIL", e); process.exitCode = 1; }
    srv.close();
  });
});
