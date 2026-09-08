const express = require("express");
const compression = require("compression");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const app = express();
app.use(compression());
app.use(express.json({ limit: "20mb" }));

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
  // Add the new multi-image column if it doesn't exist yet (safe on repeated runs).
  await pool.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS images JSONB NOT NULL DEFAULT '[]';`);
}

async function seedIfEmpty() {
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM sections");
  if (rows[0].n > 0) return;
  console.log("Sembrando catálogo inicial...");
  await runFullSeed();
}

// Backfill: for products that exist but still have an empty `images` array
// (created before the carousel feature), pull the multi-photo set from
// seed-data.json by matching product id, without touching anything an
// admin may have already edited (those already have images set).
async function backfillImages() {
  const seedPath = path.join(__dirname, "seed-data.json");
  const seed = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  const byId = {};
  seed.forEach(sec => sec.products.forEach(p => { byId[p.id] = p.images || []; }));

  const { rows } = await pool.query(
    "SELECT id, image, images FROM products WHERE images = '[]'::jsonb OR images IS NULL"
  );
  if (!rows.length) return;
  console.log(`Actualizando ${rows.length} producto(s) con el set completo de fotos...`);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const row of rows) {
      let images = byId[row.id];
      if (!images || !images.length) {
        // Fallback: keep whatever single photo it already had.
        images = row.image ? [row.image] : [];
      }
      await client.query("UPDATE products SET images=$1 WHERE id=$2", [JSON.stringify(images), row.id]);
    }
    await client.query("COMMIT");
    console.log("Fotos actualizadas.");
  } catch (e) {
    await client.query("ROLLBACK");
    console.error("Error actualizando fotos:", e);
  } finally {
    client.release();
  }
}

async function runFullSeed() {
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
        const images = p.images || (p.image ? [p.image] : []);
        await client.query(
          `INSERT INTO products (id, section_id, name, price, dims, notes, images, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [p.id, sec.id, p.name, p.price || "", JSON.stringify(p.dims || []), JSON.stringify(p.notes || []), JSON.stringify(images), pi]
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
// In-memory cache of the assembled catalog JSON string. Rebuilt only when an
// admin write happens, so a burst of visitors doesn't repeatedly re-query and
// re-serialize ~2MB of product photos on every page load (this was very
// likely the cause of the free instance's 512MB memory-limit restarts).
let catalogCache = null;
let catalogCacheBuilding = null; // in-flight rebuild promise, shared by concurrent requests

async function rebuildCatalogCache() {
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
        images: (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []),
      })),
  }));
  catalogCache = JSON.stringify({ sections });
  return catalogCache;
}

app.get("/api/catalog", async (req, res) => {
  try {
    if (catalogCache) {
      res.type("application/json").send(catalogCache);
      return;
    }
    // Only one in-flight rebuild at a time; concurrent requests share it
    // instead of each triggering their own heavy query + JSON build.
    if (!catalogCacheBuilding) {
      catalogCacheBuilding = rebuildCatalogCache().finally(() => { catalogCacheBuilding = null; });
    }
    const body = await catalogCacheBuilding;
    res.type("application/json").send(body);
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
    catalogCache = null;
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
    catalogCache = null;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo renombrar la sección." });
  }
});

app.delete("/api/admin/sections/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM sections WHERE id=$1", [req.params.id]);
    catalogCache = null;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo eliminar la sección." });
  }
});

// ---------- admin: products ----------
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const { sectionId, name, price, dims, notes, images } = req.body || {};
    if (!sectionId || !name || !name.trim()) return res.status(400).json({ error: "Faltan datos del producto." });
    const id = uid("p");
    const { rows } = await pool.query("SELECT COALESCE(MAX(position),-1)+1 AS pos FROM products WHERE section_id=$1", [sectionId]);
    await pool.query(
      `INSERT INTO products (id, section_id, name, price, dims, notes, images, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, sectionId, name.trim(), price || "", JSON.stringify(dims || []), JSON.stringify(notes || []), JSON.stringify(images || []), rows[0].pos]
    );
    catalogCache = null;
    res.json({ ok: true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo guardar el producto." });
  }
});

app.patch("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    const { sectionId, name, price, dims, notes, images } = req.body || {};
    if (!sectionId || !name || !name.trim()) return res.status(400).json({ error: "Faltan datos del producto." });
    await pool.query(
      `UPDATE products SET section_id=$1, name=$2, price=$3, dims=$4, notes=$5, images=$6 WHERE id=$7`,
      [sectionId, name.trim(), price || "", JSON.stringify(dims || []), JSON.stringify(notes || []), JSON.stringify(images || []), req.params.id]
    );
    catalogCache = null;
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "No se pudo actualizar el producto." });
  }
});

app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  try {
    await pool.query("DELETE FROM products WHERE id=$1", [req.params.id]);
    catalogCache = null;
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
    await backfillImages();
    await rebuildCatalogCache();
  } catch (e) {
    console.error("Error de inicialización de base de datos:", e);
  }
  app.listen(PORT, () => console.log("Servidor escuchando en puerto " + PORT));
}

start();
