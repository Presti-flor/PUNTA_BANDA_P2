// server.js (COMPLETO, AJUSTADO A TUS COLUMNAS)
// TABLAS:
// - variedades: id (ej: V01), nombre, activo
// - scans: id, ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b, variedad_nombre
//
// NUEVOS CÓDIGOS:
// - Bonchador (A):  B16 ... B25
// - Var/Grado/Tallos (B):  V01-60-25  => variedad_id=V01, grado_cm=60, tallos=25
//
// ORDEN LIBRE:
// - Puedes escanear A→B o B→A.
// - Si llega B primero SIN worker en body, se guarda en un “pendiente global” (limitación: si dos personas hacen B-primero al tiempo, puede cruzarse).

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({ origin: "*", methods: ["GET", "POST"], allowedHeaders: ["Content-Type"] }));

const DB_URL = process.env.DATABASE_URL || "";
const isRailwayLike =
  DB_URL.includes("proxy.rlwy.net") ||
  DB_URL.includes("railway") ||
  DB_URL.includes("rlwy");

const pool = new Pool({
  connectionString: DB_URL,
  ssl: isRailwayLike ? { rejectUnauthorized: false } : false,
});

async function dbQuery(text, params) {
  return pool.query(text, params);
}

// ====== Catálogo de bonchadores ======
const catalogs = {
  workers: ["B16","B17","B18","B19","B20","B21","B22","B23","B24","B25"],
};

// ====== Cache de Variedades: (id -> nombre) ======
let variedadMap = new Map();

async function refreshVariedadesCache() {
  const r = await dbQuery("SELECT id, nombre FROM variedades WHERE activo=true", []);
  const m = new Map();
  for (const row of r.rows) m.set(String(row.id).toUpperCase(), row.nombre);
  variedadMap = m;
  return m.size;
}

// ====== Memoria (para dashboard + SSE) ======
const scans = [];                 // registros ya completados (memoria)
const seqByWorker = new Map();     // secuencial por bonchador
const pendingByWorker = new Map(); // pendientes por bonchador
const workerNames = new Map();     // nombre editable
const sseClients = new Set();

// Pendiente GLOBAL para permitir B→A sin worker en body
let globalPendingB = null; // { variedad_id, variedad_nombre, grado_cm, tallos, raw_b, updatedAtIso }

for (const w of catalogs.workers) {
  seqByWorker.set(w, 0);
  pendingByWorker.set(w, {
    worker: w,
    tallos: null,
    grado_cm: null,
    variedad_id: null,
    variedad_nombre: null,
    updatedAtIso: null,
    raw_a: null,
    raw_b: null,
  });
  workerNames.set(w, `Bonchador ${w}`);
}

function nowIso() { return new Date().toISOString(); }

function sendSse(payload) {
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(data); }
    catch { sseClients.delete(res); }
  }
}

// ====== DB: leer scans (hoy por defecto) ======
async function fetchScansFromDb({ limit = 2000, onlyToday = true } = {}) {
  const where = onlyToday
    ? "WHERE (s.ts AT TIME ZONE 'America/Bogota')::date = (NOW() AT TIME ZONE 'America/Bogota')::date"
    : "";

  // Usamos variedad_id y variedad_nombre (columna REAL en scans).
  // Si variedad_nombre está null en scans, lo completamos con join (COALESCE).
  const q = `
    SELECT
      s.id         AS scan_id,
      s.ts         AS ts,
      s.worker     AS worker,
      s.tallos     AS tallos,
      s.grado_cm   AS grado_cm,
      s.variedad_id AS variedad_id,
      COALESCE(s.variedad_nombre, v.nombre) AS variedad_nombre
    FROM scans s
    LEFT JOIN variedades v ON v.id = s.variedad_id
    ${where}
    ORDER BY s.ts DESC
    LIMIT $1;
  `;

  const r = await dbQuery(q, [limit]);
  return r.rows.map((row) => ({
    ts: row.ts,
    scan_id: row.scan_id,
    worker: String(row.worker),
    worker_name: workerNames.get(String(row.worker)) || String(row.worker),
    seq: null,
    tallos: row.tallos,
    grado_cm: row.grado_cm,
    variedad_id: row.variedad_id,
    variedad_nombre: row.variedad_nombre || null,
  }));
}

// ====== DB: guardar scan COMPLETO ======
async function saveScanToDb({ worker, tallos, grado_cm, variedad_id, raw_a, raw_b }) {
  const w = String(worker || "").toUpperCase();
  const vid = String(variedad_id || "").toUpperCase();

  if (!catalogs.workers.includes(w)) {
    return { ok: false, status: "BAD_WORKER", message: `Worker ${w} no permitido` };
  }

  const v = await dbQuery(
    "SELECT id, nombre FROM variedades WHERE UPPER(id)=UPPER($1) AND activo=true",
    [vid]
  );
  if (!v.rows.length) {
    return { ok: false, status: "BAD_VARIETY", message: `Variedad ${vid} no existe o está inactiva` };
  }

  const vNombre = v.rows[0].nombre || null;

  const ins = await dbQuery(
    `INSERT INTO scans
      (worker, tallos, variedad_id, grado_cm, raw_a, raw_b, variedad_nombre)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id, ts`,
    [w, tallos ?? null, vid, grado_cm ?? null, raw_a ?? null, raw_b ?? null, vNombre]
  );

  return { ok: true, status: "COMPLETE", scan_id: ins.rows[0].id, ts: ins.rows[0].ts, variedad_nombre: vNombre };
}

// ====== Parser A/B ======
// A: B16..B25
// B: V01-60-25 => variedad_id=V01, grado_cm=60, tallos=25
function parseBarcode(barcode) {
  const s = String(barcode || "").trim();
  if (!s) return { type: "UNKNOWN" };
  const up = s.toUpperCase();

  // A (bonchador)
  if (/^B\d{2}$/.test(up)) {
    if (!catalogs.workers.includes(up)) return { type: "UNKNOWN", raw: s, reason: "WORKER_NOT_ALLOWED" };
    return { type: "A", worker: up };
  }

  // B (variedad-grado-tallos)
  // Formato: V01-60-25
  if (/^V\d{2}-\d{1,3}-\d{1,3}$/.test(up)) {
    const [vid, g, t] = up.split("-");
    const grado_cm = parseInt(g, 10);
    const tallos = parseInt(t, 10);

    if (!Number.isFinite(grado_cm) || grado_cm <= 0) return { type: "UNKNOWN", raw: s, reason: "BAD_GRADO" };
    if (!Number.isFinite(tallos) || tallos <= 0) return { type: "UNKNOWN", raw: s, reason: "BAD_TALLOS" };

    return { type: "B", variedad_id: vid, grado_cm, tallos, raw_b: up };
  }

  return { type: "UNKNOWN", raw: s };
}

// ====== Completar registro si ya está todo en pendingByWorker ======
async function maybeBuildRecord(worker) {
  const w = String(worker || "").toUpperCase();
  const p = pendingByWorker.get(w);
  if (!p) return null;

  if (p.variedad_id && p.grado_cm && p.tallos) {
    const seq = (seqByWorker.get(w) || 0) + 1;
    seqByWorker.set(w, seq);

    let dbOut;
    try {
      dbOut = await saveScanToDb({
        worker: w,
        tallos: p.tallos,
        grado_cm: p.grado_cm,
        variedad_id: p.variedad_id,
        raw_a: p.raw_a,
        raw_b: p.raw_b,
      });
      if (!dbOut.ok) return { error: true, status: dbOut.status, message: dbOut.message };
    } catch (e) {
      return { error: true, status: "DB_ERROR", message: String(e.message || e) };
    }

    const vid = String(p.variedad_id).toUpperCase();
    const variedad_nombre = dbOut.variedad_nombre || p.variedad_nombre || variedadMap.get(vid) || null;

    const reg = {
      ts: dbOut.ts || nowIso(),
      scan_id: dbOut.scan_id,
      worker: w,
      worker_name: workerNames.get(w) || w,
      seq: String(seq).padStart(6, "0"),
      tallos: p.tallos,
      grado_cm: p.grado_cm,
      variedad_id: p.variedad_id,
      variedad_nombre,
    };

    // reset pending del worker
    pendingByWorker.set(w, {
      worker: w,
      tallos: null,
      grado_cm: null,
      variedad_id: null,
      variedad_nombre: null,
      updatedAtIso: null,
      raw_a: null,
      raw_b: null,
    });   

    scans.push(reg);
    if (scans.length > 50000) scans.splice(0, scans.length - 50000);

    sendSse({ kind: "scan", reg });
    sendSse({ kind: "pendingAll", pending: Object.fromEntries([...pendingByWorker.entries()]) });
    sendSse({ kind: "globalPendingB", globalPendingB });

    return reg;
  }

  return null;
}

// ====== API ======
app.get("/api/workers", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(catalogs.workers.map((code) => ({ code, name: workerNames.get(code) || code })));
});

app.post("/api/workers", (req, res) => {
  const { code, name } = req.body || {};
  const c = String(code || "").trim().toUpperCase();
  if (!catalogs.workers.includes(c)) return res.status(400).json({ error: "Worker inválido" });

  const n = String(name || "").trim();
  if (n.length < 1 || n.length > 40) return res.status(400).json({ error: "Nombre inválido (1-40 chars)" });

  workerNames.set(c, n);

  // refresca nombres en memoria
  for (let i = 0; i < scans.length; i++) if (String(scans[i].worker).toUpperCase() === c) scans[i].worker_name = n;

  sendSse({
    kind: "workers",
    workers: catalogs.workers.map((code) => ({ code, name: workerNames.get(code) || code })),
  });

  res.json({ ok: true, code: c, name: n });
});

app.get("/api/pendingAll", (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(Object.fromEntries([...pendingByWorker.entries()]));
});

app.get("/api/scans", async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const onlyToday = String(req.query.today || "1") !== "0";
    const arr = await fetchScansFromDb({ limit, onlyToday });
    res.set("Cache-Control", "no-store");
    res.json(arr);
  } catch (e) {
    res.status(500).json({ error: "DB error", detail: String(e.message || e) });
  }
});

// POST /api/scan
// Body: { barcode: "...", worker?: "B16" }
// - Si llega A (B16): setea worker y si hay globalPendingB lo completa.
// - Si llega B (V01-60-25): si viene worker en body, se asigna a ese worker; si no, queda como pendiente global.
app.post("/api/scan", async (req, res) => {
  const { barcode, worker: workerFromBody } = req.body || {};
  if (!barcode || typeof barcode !== "string") return res.status(400).json({ error: "Falta barcode" });

  const parsed = parseBarcode(barcode);
  if (parsed.type === "UNKNOWN") {
    return res.status(400).json({ error: "Barcode no reconocido", raw: parsed.raw || barcode, reason: parsed.reason });
  }

  // ========= Caso A: bonchador =========
  if (parsed.type === "A") {
    const w = parsed.worker;

    const p = pendingByWorker.get(w);
    const updated = { ...p, updatedAtIso: nowIso(), raw_a: parsed.worker };

    // Si hay un B global esperando, lo aplicamos a este worker
    if (globalPendingB) {
      updated.variedad_id = globalPendingB.variedad_id;
      updated.variedad_nombre = globalPendingB.variedad_nombre;
      updated.grado_cm = globalPendingB.grado_cm;
      updated.tallos = globalPendingB.tallos;
      updated.raw_b = globalPendingB.raw_b;

      globalPendingB = null;
    }

    pendingByWorker.set(w, updated);

    sendSse({ kind: "pendingAll", pending: Object.fromEntries([...pendingByWorker.entries()]) });
    sendSse({ kind: "globalPendingB", globalPendingB });

    const reg = await maybeBuildRecord(w);
    if (reg && reg.error) {
      return res.status(400).json({ ok: false, status: reg.status, message: reg.message, parsed, pending: pendingByWorker.get(w) });
    }

    const status = reg ? "COMPLETE" : "PENDING_B";
    return res.json({ ok: true, status, parsed, pending: pendingByWorker.get(w), globalPendingB, reg: reg || null });
  }

  // ========= Caso B: variedad-grado-tallos =========
  if (parsed.type === "B") {
    // Nombre desde cache (si está), si no, se resolverá al guardar
    const vid = String(parsed.variedad_id).toUpperCase();
    const vNombre = variedadMap.get(vid) || null;

    const bodyW = String(workerFromBody || "").trim().toUpperCase();

    // Si llega con worker en body, lo asignamos directo al worker
    if (bodyW && pendingByWorker.has(bodyW)) {
      const p = pendingByWorker.get(bodyW);
      const updated = {
        ...p,
        updatedAtIso: nowIso(),
        variedad_id: vid,
        variedad_nombre: vNombre,
        grado_cm: parsed.grado_cm,
        tallos: parsed.tallos,
        raw_b: String(barcode).toUpperCase(),
      };
      pendingByWorker.set(bodyW, updated);

      sendSse({ kind: "pendingAll", pending: Object.fromEntries([...pendingByWorker.entries()]) });

      const reg = await maybeBuildRecord(bodyW);
      if (reg && reg.error) {
        return res.status(400).json({ ok: false, status: reg.status, message: reg.message, parsed, pending: pendingByWorker.get(bodyW) });
      }

      const status = reg ? "COMPLETE" : "PENDING_A";
      return res.json({ ok: true, status, parsed, pending: pendingByWorker.get(bodyW), globalPendingB, reg: reg || null });
    }

    // Si NO llega worker, lo guardamos como pendiente global (B→A)
    globalPendingB = {
      variedad_id: vid,
      variedad_nombre: vNombre,
      grado_cm: parsed.grado_cm,
      tallos: parsed.tallos,
      raw_b: String(barcode).toUpperCase(),
      updatedAtIso: nowIso(),
    };

    sendSse({ kind: "globalPendingB", globalPendingB });

    return res.json({ ok: true, status: "PENDING_A_GLOBAL", parsed, globalPendingB });
  }

  return res.status(400).json({ error: "Estado no soportado" });
});

// SSE
app.get("/api/stream", (req, res) => {
  res.set({
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders?.();

  sseClients.add(res);

  const snapshot = scans.slice(-200).reverse();
  const pending = Object.fromEntries([...pendingByWorker.entries()]);
  const workers = catalogs.workers.map((code) => ({ code, name: workerNames.get(code) || code }));

  res.write(`data: ${JSON.stringify({ kind: "snapshot", snapshot, pending, workers, globalPendingB })}\n\n`);

  req.on("close", () => {
    sseClients.delete(res);
    try { res.end(); } catch {}
  });
});

// Precarga de memoria desde DB (hoy) para que no “arranque en cero” al reconectar
async function rebuildInMemoryFromDb() {
  const rows = await fetchScansFromDb({ limit: 5000, onlyToday: true });

  scans.length = 0;
  seqByWorker.clear();
  for (const w of catalogs.workers) seqByWorker.set(w, 0);

  const asc = [...rows].reverse();
  const localSeq = new Map();
  for (const w of catalogs.workers) localSeq.set(w, 0);

  for (const reg of asc) {
    const w = String(reg.worker).toUpperCase();
    if (!localSeq.has(w)) continue;

    const next = (localSeq.get(w) || 0) + 1;
    localSeq.set(w, next);

    reg.seq = String(next).padStart(6, "0");
    reg.worker_name = workerNames.get(w) || w;

    scans.push(reg);
  }

  for (const w of catalogs.workers) {
    seqByWorker.set(w, localSeq.get(w) || 0);
  }

  console.log("Precarga OK. Registros hoy:", scans.length);
}

// Start
app.listen(PORT, "0.0.0.0", async () => {
  console.log(`Servidor listo: http://127.0.0.1:${PORT}`);
  console.log(`DB: ${DB_URL ? "DATABASE_URL configurada" : "FALTA DATABASE_URL"}`);

  try {
    await refreshVariedadesCache().catch(()=>{});
    await rebuildInMemoryFromDb();
  } catch (e) {
    console.log("Precarga falló:", e.message || e);
  }
});