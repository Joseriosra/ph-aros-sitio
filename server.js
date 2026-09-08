const express = require("express");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(express.json({ limit: "15mb" }));

const PORT = process.env.PORT || 3000;
const ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || "pauli2026";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("Falta la variable de entorno DATABASE_URL. Conecta la base de datos en Render.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL && DATABASE_URL.includes("render.com") ? { rejectUnauthorized: false } : false,
});

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      material TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL REFERENCES sections(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      price TEXT,
      dims JSONB NOT NULL DEFAULT '[]',
      notes JSONB NOT NULL DEFAULT '[]',
      image TEXT,
      position INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM sections");
  if (rows[0].n > 0) return;
  console.log("Sembrando catálogo inicial...");
  const seedPath = path.join(__dirname, "seed-data.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (let si = 0; si < seed.length; si++) {
      const sec = seed[si];
      await client.query(
        "INSERT INTO sections (id, name, material, position) VALUES ($1,$2,$3,$4)",
        [sec.id, sec.name, sec.material || null, si]
      );
      for (let pi = 0; pi < sec.products.length; pi++) {
        const p = sec.products[pi];
        await client.query(
          `INSERT INTO products (id, section_id, name, price, dims, notes, image, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [p.id, sec.id, p.name, p.price || "", JSON.stringify(p.dims || []), JSON.stringify(p.notes || []), p.image || null, pi]
        );
      }
    }
    await client.query("COMMIT");
    console.log("Catálogo inicial cargado.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Error sembrando datos:", e);
  } finally {
    client.release();
  }
}

function requireAdmin(req, res, next) {
  const passcode = req.header("x-admin-passcode");
  if (passcode !== ADMIN_PASSCODE) {
    return res.status(401).json({ error: "Clave de administrador incorrecta." });
  }
  next();
}

function uid(prefix) {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

// ---------- public API ----------
app.get("/api/catalog", async (req, res) => {
  try {
    const secRes = await pool.query("SELECT * FROM sections ORDER BY position ASC");
    const prodRes = await pool.query("SELECT * FROM products ORDER BY position ASC");
    const sections = secRes.rows.map(s => ({
      id: s.id,
      name: s.name,
      material: s.material,
      products: prodRes.rows
        .filter(p => p.section_id === s.id)
        .map(p => ({
          id: p.id,
          name: p.name,
          price: p.price,
          dims: p.dims,
          notes: p.notes,
          image: p.image,
        })),
    }));
    res.json({ sections });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo cargar el catálogo." });
  }
});

app.post("/api/admin/verify", (req, res) => {
  const { passcode } = req.body || {};
  res.json({ ok: passcode === ADMIN_PASSCODE });
});

// ---------- admin: sections ----------
app.post("/api/admin/sections", requireAdmin, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Falta el nombre de la sección." });
    const id = uid("sec");
    const { rows } = await pool.query("SELECT COALESCE(MAX(position),-1)+1 AS pos FROM sections");
    await pool.query("INSERT INTO sections (id, name, material, position) VALUES ($1,$2,$3,$4)", [id, name.trim(), null, rows[0].pos]);
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo crear la sección." });
  }
});

app.patch("/api/admin/sections/:id", requireAdmin, async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name || !name.trim()) return res.status(400).json({ error: "Falta el nombre." });
    await pool.query("UPDATE sections SET name=$1 WHERE id=$2", [name.trim(), req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo renombrar la sección." });
  }
});

app.delete("/api/admin/sections/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM sections WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo eliminar la sección." });
  }
});

// ---------- admin: products ----------
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { sectionId, name, price, dims, notes, image } = req.body || {};
    if (!sectionId || !name || !name.trim()) return res.status(400).json({ error: "Faltan datos del producto." });
    const id = uid("p");
    const { rows } = await pool.query("SELECT COALESCE(MAX(position),-1)+1 AS pos FROM products WHERE section_id=$1", [sectionId]);
    await pool.query(
      `INSERT INTO products (id, section_id, name, price, dims, notes, image, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, sectionId, name.trim(), price || "", JSON.stringify(dims || []), JSON.stringify(notes || []), image || null, rows[0].pos]
    );
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo guardar el producto." });
  }
});

app.patch("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const { sectionId, name, price, dims, notes, image } = req.body || {};
    if (!sectionId || !name || !name.trim()) return res.status(400).json({ error: "Faltan datos del producto." });
    await pool.query(
      `UPDATE products SET section_id=$1, name=$2, price=$3, dims=$4, notes=$5, image=$6 WHERE id=$7`,
      [sectionId, name.trim(), price || "", JSON.stringify(dims || []), JSON.stringify(notes || []), image || null, req.params.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo actualizar el producto." });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo eliminar el producto." });
  }
});

// ---------- static frontend ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

async function start() {
  try {
    await migrate();
    await seedIfEmpty();
  } catch (e) {
    console.error("Error de inicialización de base de datos:", e);
  }
  app.listen(PORT, () => console.log("Servidor escuchando en puerto " + PORT));
}

start();
