process.env.TURSO_DATABASE_URL = ":memory:";
process.env.API_KEY = "secret";
const assert = require("assert");
const app = require("./server");
app.ready.then(() => { const srv = app.listen(0, async () => {
  const base = `http://localhost:${srv.address().port}`;
  const H = { "Content-Type": "application/json", "x-api-key": "secret" };
  const f = (m, u, b, h = H) => fetch(base + u, { method: m, headers: h, body: b && JSON.stringify(b) });
  try {
    assert.equal((await f("GET", "/api/expenses", null, {})).status, 401);
    assert.equal((await f("GET", "/api/health", null, {})).status, 200);
    assert.equal((await f("POST", "/api/expenses", { amount: -5, category: "Food", date: "2026-10-01" })).status, 400);
    assert.equal((await f("POST", "/api/expenses", { amount: 5, category: "Nope", date: "2026-10-01" })).status, 400);
    const a = await (await f("POST", "/api/expenses", { amount: 250.5, category: "Food", note: "lunch", date: "2026-10-01" })).json();
    await f("POST", "/api/expenses", { amount: 1000, category: "Rent", date: "2026-10-02" });
    await f("POST", "/api/expenses", { amount: 99, category: "Fun", date: "2026-09-30" });
    const list = await (await f("GET", "/api/expenses?month=2026-10")).json();
    assert.equal(list.length, 2);
    const s = await (await f("GET", "/api/summary?month=2026-10")).json();
    assert.equal(s.total, 1250.5);
    assert.equal(s.left, 20000 - 1250.5);
    assert.equal(s.byCategory[0].category, "Rent");
    assert.equal((await f("PUT", "/api/budget", { amount: 5000 })).status, 200);
    assert.equal((await (await f("GET", "/api/budget")).json()).amount, 5000);
    assert.equal((await f("DELETE", `/api/expenses/${a.id}`)).status, 204);
    assert.equal((await f("DELETE", `/api/expenses/${a.id}`)).status, 404);
    assert.ok((await (await f("GET", "/api/export.csv")).text()).includes("Rent"));
    console.log("All tests passed");
  } catch (e) { console.error("FAIL", e); process.exitCode = 1; }
  srv.close();
});
});
