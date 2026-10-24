// Results database on SQLite (built-in node:sqlite, Node 22.5+): a live DB and a separate backup DB.
// Each student has 5 subject marks. Every record carries a checksum. Latency/outages can be injected for chaos tests.
const fs = require("fs"),
  path = require("path"),
  crypto = require("crypto"),
  { DatabaseSync } = require("node:sqlite");
const D = path.join(__dirname, "data");
fs.mkdirSync(D, { recursive: true });
const SUBJECTS = [
  "Software Engineering",
  "Web Technologies",
  "Database Systems",
  "Operating Systems",
  "Computer Networks",
];
const live = new DatabaseSync(D + "/portal.db"),
  bk = new DatabaseSync(D + "/portal-backup.db");
const COLS = "(roll TEXT PRIMARY KEY,name TEXT,marks TEXT,grade TEXT,sum TEXT)";
live.exec(
  `CREATE TABLE IF NOT EXISTS results ${COLS};CREATE TABLE IF NOT EXISTS quarantine(at TEXT,roll TEXT,name TEXT,marks TEXT,grade TEXT,sum TEXT);CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT,action TEXT,detail TEXT);CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY,v TEXT)`,
);
bk.exec(`CREATE TABLE IF NOT EXISTS results ${COLS}`);
const L = {
  get: live.prepare("SELECT * FROM results WHERE roll=?"),
  put: live.prepare("INSERT OR REPLACE INTO results VALUES(?,?,?,?,?)"),
  del: live.prepare("DELETE FROM results WHERE roll=?"),
  all: live.prepare("SELECT * FROM results ORDER BY roll"),
  q: live.prepare("INSERT INTO quarantine VALUES(?,?,?,?,?,?)"),
};
const K = {
  get: bk.prepare("SELECT * FROM results WHERE roll=?"),
  put: bk.prepare("INSERT OR REPLACE INTO results VALUES(?,?,?,?,?)"),
  del: bk.prepare("DELETE FROM results WHERE roll=?"),
};
const gradeOf = (p) =>
  p >= 85 ? "A" : p >= 70 ? "B" : p >= 55 ? "C" : p >= 40 ? "D" : "F";
function calc(m) {
  if (!Array.isArray(m) || m.length !== 5)
    return { total: 0, percent: 0, grade: "F", pass: false };
  const total = m.reduce((a, b) => a + (+b || 0), 0),
    percent = Math.round((total / 5) * 100) / 100,
    pass = m.every((x) => x >= 40);
  return { total, percent, grade: pass ? gradeOf(percent) : "F", pass };
}
const parse = (s) => {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a : null;
  } catch {
    return null;
  }
};
const fromRow = (r) => (r ? { ...r, marks: parse(r.marks) } : null);
const sum = (r) =>
  crypto
    .createHash("sha256")
    .update([r.roll, r.name, JSON.stringify(r.marks), r.grade].join("|"))
    .digest("hex")
    .slice(0, 12);
const mk = (roll, name, marks) => {
  const r = { roll, name, marks, grade: calc(marks).grade };
  r.sum = sum(r);
  return r;
};
const valid = (r) =>
  !!r &&
  Array.isArray(r.marks) &&
  r.marks.length === 5 &&
  r.marks.every((x) => Number.isInteger(x) && x >= 0 && x <= 100) &&
  r.grade === calc(r.marks).grade &&
  r.sum === sum(r);
const put = (s, r) =>
    s.run(r.roll, r.name, JSON.stringify(r.marks), r.grade, r.sum),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const audit = (action, detail) =>
  live
    .prepare("INSERT INTO audit(at,action,detail) VALUES(?,?,?)")
    .run(new Date().toISOString(), action, detail);
const tx = (fn) => {
  live.exec("BEGIN");
  bk.exec("BEGIN");
  try {
    fn();
    live.exec("COMMIT");
    bk.exec("COMMIT");
  } catch (e) {
    live.exec("ROLLBACK");
    bk.exec("ROLLBACK");
    throw e;
  }
};
const state = { latencyMs: 0, down: false },
  held = new Set();
function seed() {
  held.clear();
  const n = [
    "Aarav",
    "Diya",
    "Rohan",
    "Meera",
    "Kabir",
    "Isha",
    "Vihaan",
    "Anaya",
    "Arjun",
    "Saanvi",
  ];
  tx(() => {
    live.exec("DELETE FROM results;DELETE FROM quarantine");
    bk.exec("DELETE FROM results");
    for (let i = 0; i < 200; i++) {
      const base = 45 + Math.random() * 47,
        m = SUBJECTS.map(() =>
          Math.max(
            20,
            Math.min(100, Math.round(base + Math.random() * 24 - 12)),
          ),
        );
      const r = mk(
        String(1001 + i),
        n[i % 10] + " " + String.fromCharCode(65 + (i % 26)) + ".",
        m,
      );
      put(L.put, r);
      put(K.put, r);
    }
  });
  audit("reset", "Demo data created: 200 students, 5 subjects each");
}
if (!L.all.all().length) seed();
async function query(roll) {
  await sleep(20 + state.latencyMs);
  if (state.down) throw new Error("DB connection refused");
  if (held.has(roll)) return { roll, held: true };
  return fromRow(L.get.get(roll));
}
const peek = (roll) => fromRow(L.get.get(roll)),
  all = () => L.all.all().map(fromRow);
const bad = () =>
  all()
    .filter((r) => !held.has(r.roll) && !valid(r))
    .map((r) => r.roll);
function restore(roll) {
  const c = L.get.get(roll);
  if (c)
    L.q.run(new Date().toISOString(), c.roll, c.name, c.marks, c.grade, c.sum);
  const b = fromRow(K.get.get(roll));
  if (valid(b)) {
    put(L.put, b);
    audit("self-repair", "Roll " + roll + " restored from backup");
    return b;
  }
  held.add(roll);
  audit(
    "self-repair failed",
    "Roll " + roll + " put on hold: backup is invalid too",
  );
  return null;
}
function corrupt(both, roll) {
  const ok = all()
      .filter((r) => valid(r) && !held.has(r.roll))
      .map((r) => r.roll),
    k = ok.includes(roll) ? roll : ok[Math.floor(Math.random() * ok.length)];
  const hit = (d, S) => {
    const r = fromRow(S.get(k));
    r.marks[0] = 999;
    d.prepare("UPDATE results SET marks=? WHERE roll=?").run(
      JSON.stringify(r.marks),
      k,
    );
  };
  hit(live, L.get);
  if (both) hit(bk, K.get);
  audit(
    "chaos",
    "Corruption injected on roll " + k + (both ? " and its backup" : ""),
  );
  return k;
}
function upsert(list) {
  const res = { added: 0, updated: 0, rejected: [], rolls: [] },
    seen = new Set();
  tx(() => {
    for (const x of list) {
      const roll = String(x.roll ?? "").trim(),
        name = String(x.name ?? "").trim();
      let why = null;
      const marks = Array.isArray(x.marks)
        ? x.marks.map((v) => {
            const t = String(v ?? "").trim();
            return t === "" ? NaN : Number(t);
          })
        : [];
      if (!/^\d{4}$/.test(roll)) why = "Roll must be 4 digits";
      else if (!name || name.length > 40) why = "Name missing or too long";
      else if (
        marks.length !== 5 ||
        !marks.every((v) => Number.isInteger(v) && v >= 0 && v <= 100)
      )
        why = "Needs 5 subject marks, each a whole number from 0 to 100";
      else if (seen.has(roll)) why = "Duplicate roll in this file";
      if (why) {
        res.rejected.push({ line: x.line, roll, reason: why });
        continue;
      }
      seen.add(roll);
      L.get.get(roll) ? res.updated++ : res.added++;
      const r = mk(roll, name, marks);
      put(L.put, r);
      put(K.put, r);
      held.delete(roll);
      res.rolls.push(roll);
    }
  });
  audit(
    "import",
    res.added +
      " added, " +
      res.updated +
      " updated, " +
      res.rejected.length +
      " rejected",
  );
  return res;
}
function remove(roll) {
  tx(() => {
    L.del.run(roll);
    K.del.run(roll);
  });
  held.delete(roll);
  audit("delete", "Roll " + roll + " deleted");
}
const getSetting = (k) => {
  const r = live.prepare("SELECT v FROM settings WHERE k=?").get(k);
  return r ? r.v : null;
};
const setSetting = (k, v) =>
  live.prepare("INSERT OR REPLACE INTO settings VALUES(?,?)").run(k, v);
function stats() {
  const a = all(),
    v = a.filter(valid),
    n = v.length,
    dist = { A: 0, B: 0, C: 0, D: 0, F: 0 },
    cs = v.map((r) => calc(r.marks));
  cs.forEach((c) => dist[c.grade]++);
  return {
    total: a.length,
    avg: n
      ? Math.round((cs.reduce((s, c) => s + c.percent, 0) / n) * 10) / 10
      : 0,
    pass: n ? Math.round((cs.filter((c) => c.pass).length / n) * 100) : 0,
    max: n ? Math.max(...cs.map((c) => c.percent)) : 0,
    dist,
    bad: bad().length,
    held: held.size,
    quarantined: live.prepare("SELECT COUNT(*) n FROM quarantine").get().n,
  };
}
const auditList = (n) =>
  live
    .prepare("SELECT at,action,detail FROM audit ORDER BY id DESC LIMIT ?")
    .all(n)
    .map((r) => ({ ...r }));
const quarantineList = (n) =>
  live
    .prepare(
      "SELECT at,roll,name,marks FROM quarantine ORDER BY at DESC LIMIT ?",
    )
    .all(n)
    .map((r) => ({ ...r }));
module.exports = {
  SUBJECTS,
  calc,
  query,
  peek,
  valid,
  bad,
  restore,
  corrupt,
  upsert,
  remove,
  reseed: seed,
  all,
  state,
  held,
  audit,
  getSetting,
  setSetting,
  stats,
  auditList,
  quarantineList,
};
