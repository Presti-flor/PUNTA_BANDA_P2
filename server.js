// server.js
// -------------------------------------------------------------
// Backend para Empaque — Rendimiento por bonchador (PRESTIGE P2)
// Formatos de escaneo:
//   • Bonchador + tallos: B16-T20
//   • Variedad + grado : V01-60
// Guarda en DB: worker (p.ej. "B16"), tallos (del bonchador), variedad_id, grado_cm
// Incluye SSE para actualizaciones en tiempo real.
// -------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const path = require("path");

// FORZAR ZONA HORARIA COLOMBIA
process.env.TZ = "America/Bogota";

const app = express();
app.use(cors());
app.use(express.json());

// -----------------------------
// Conexión a Postgres
// -----------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // En Railway/Heroku suelen forzar SSL
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

// -----------------------------
// Configuración y estado
// -----------------------------
const WORKER_MIN = 16;
const WORKER_MAX = 25;

// Mapa en memoria de nombres de bonchadores (p.ej. { B16: "Juan" })
let workerNameMap = {};

// Conjunto de clientes SSE conectados
const clients = new Set();

// Servir estáticos
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

/* ==========================================================
   RUTAS DE API
   ========================================================== */

// Lista de bonchadores con nombres
app.get("/api/workers", (req, res) => {
  const workers = [];
  for (let i = WORKER_MIN; i <= WORKER_MAX; i++) {
    const code = `B${i}`;
    workers.push({ code, name: workerNameMap[code] || code });
  }
  res.json(workers);
});

// Guardar/actualizar nombre de bonchador (en memoria)
app.post("/api/workers", (req, res) => {
  const { code, name } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: "Faltan datos" });
  workerNameMap[String(code).toUpperCase()] = String(name).trim();
  res.json({ ok: true });
});

// Traer escaneos recientes (con nombre de variedad por JOIN)
app.get("/api/scans", async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 200;
    const query = `
      SELECT 
        s.ts, 
        s.worker, 
        s.tallos, 
        s.variedad_id, 
        s.grado_cm,
        COALESCE(v.nombre, s.variedad_id) AS variedad_nombre
      FROM scans s
      LEFT JOIN variedades v ON s.variedad_id = v.id
      ORDER BY s.ts DESC 
      LIMIT $1
    `;
    const result = await pool.query(query, [limit]);

    const finalData = result.rows.map(row => ({
      ...row,
      worker_name: workerNameMap[row.worker] || row.worker
    }));

    res.json(finalData);
  } catch (err) {
    console.error("GET /api/scans error:", err);
    res.status(500).json({ error: "Error en DB" });
  }
});

// Pendientes (si aún no llevas estado de pendientes, devolvemos vacío)
app.get("/api/pendingAll", (req, res) => {
  res.json({});
});

/* ==========================================================
   LÓGICA DE PARSEOS (NUEVOS FORMATOS)
   ========================================================== */

// Bonchador: B16-T20  (B=bonchador; T=tallos)
function parseWorker(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^B(\d{2})-T(\d{1,3})$/);
  if (!m) return null;

  const n = parseInt(m[1], 10);
  const tallos = parseInt(m[2], 10);

  if (!(n >= WORKER_MIN && n <= WORKER_MAX)) return null;
  if (!Number.isFinite(tallos) || tallos <= 0) return null;

  return {
    code: `B${n}`,   // Para DB y mostrar (ej: "B16")
    tallos,          // Tallos declarados en el bonchador
    raw: up          // Escaneo crudo (ej: "B16-T20")
  };
}

// Producto: V01-60  (variedad y grado; SIN tallos)
function parseProduct(code) {
  const up = String(code || "").trim().toUpperCase();
  const m = up.match(/^V(\d{1,2})-(\d{1,3})$/);
  if (!m) return null;

  const variedad_id = `V${m[1]}`;
  const grado_cm = parseInt(m[2], 10);
  if (!Number.isFinite(grado_cm)) return null;

  return {
    variedad_id,
    grado_cm,
    raw: up
  };
}

// Recibir combinación (dos pasos en cualquier orden desde el front)
app.post("/api/scan", async (req, res) => {
  try {
    const { barcode, worker } = req.body || {};
    const wObj = parseWorker(worker);
    const pObj = parseProduct(barcode);

    if (wObj && pObj) {
      const savedReg = await saveScan(wObj, pObj);

      // Traemos el nombre de la variedad para emitirlo por SSE
      let varNombre = pObj.variedad_id;
      try {
        const varRes = await pool.query(
          "SELECT nombre FROM variedades WHERE id = $1",
          [pObj.variedad_id]
        );
        if (varRes.rows[0]) varNombre = varRes.rows[0].nombre || pObj.variedad_id;
      } catch {}

      const broadcastData = {
        ...savedReg,
        variedad_nombre: varNombre,
        worker_name: workerNameMap[savedReg.worker] || savedReg.worker
      };

      broadcast({ kind: "scan", reg: broadcastData });
      return res.json({ ok: true });
    }

    return res.status(400).json({ error: "Datos inválidos" });
  } catch (err) {
    console.error("POST /api/scan error:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// Guardar registro en DB
async function saveScan(wObj, pObj) {
  const client = await pool.connect();
  try {
    const localTimestamp = new Date();
    const query = `
      INSERT INTO scans (ts, worker, tallos, variedad_id, grado_cm, raw_a, raw_b)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `;
    const values = [
      localTimestamp,
      wObj.code,          // "B16"
      wObj.tallos,        // tallos desde bonchador
      pObj.variedad_id,   // "V01"
      pObj.grado_cm,      // 60
      wObj.raw,           // raw_a: "B16-T20"
      pObj.raw            // raw_b: "V01-60"
    ];
    const result = await client.query(query, values);
    return result.rows[0];
  } finally {
    client.release();
  }
}

/* ==========================================================
   SSE (Server-Sent Events) en /api/stream
   ========================================================== */

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  clients.forEach(res => res.write(msg));
}

app.get("/api/stream", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  // Mantener conexión
  clients.add(res);


  req.on("close", () => {
    clients.delete(res);
    try { res.end(); } catch {}
  });
});

/* ==========================================================
   ARRANQUE DEL SERVIDOR
   ========================================================== */

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor en puerto ${PORT} (Formatos: Bxx-Tyy y Vxx-gg)`);
});
