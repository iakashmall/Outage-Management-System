import http from "node:http";
import fs from "node:fs";
import { URL } from "node:url";
import pg from "pg";
import sharp from "sharp";

const { Pool } = pg;
const port = Number(process.env.PORT || 4000);
const useSsl = process.env.DB_SSL === "true";
const readPem = (path) => (path ? fs.readFileSync(path, "utf8") : undefined);
const ssl = useSsl
  ? {
      ca: readPem(process.env.DB_SSL_CA),
      cert: readPem(process.env.DB_SSL_CERT),
      key: readPem(process.env.DB_SSL_KEY),
      rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== "false",
    }
  : false;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
});
const maxUploadBytes = 20 * 1024 * 1024;
const photoSchemaSql = `
  CREATE TABLE IF NOT EXISTS job_photos (
    id BIGSERIAL PRIMARY KEY,
    job_id TEXT NOT NULL,
    image_data BYTEA NOT NULL,
    content_type TEXT NOT NULL DEFAULT 'image/webp',
    original_content_type TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    latitude DOUBLE PRECISION,
    longitude DOUBLE PRECISION,
    note TEXT,
    captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE INDEX IF NOT EXISTS job_photos_job_id_idx ON job_photos (job_id);
`;

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": process.env.CORS_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxUploadBytes) {
      throw new Error("Photo payload is too large");
    }
  }
  return JSON.parse(body || "{}");
}

function decodeDataUrl(dataUrl) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || "");
  if (!match) throw new Error("Expected a JPEG, PNG, or WebP data URL");
  return { contentType: match[1], buffer: Buffer.from(match[2], "base64") };
}

async function storePhoto(jobId, payload) {
  const original = decodeDataUrl(payload.dataUrl);
  const image = sharp(original.buffer, { limitInputPixels: 40e6 });
  const metadata = await image.metadata();
  const compressed = await image
    .rotate()
    .resize({ width: 1920, height: 1920, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 72, effort: 4 })
    .toBuffer();

  const result = await pool.query(
    `INSERT INTO job_photos
      (job_id, image_data, content_type, original_content_type, width, height, latitude, longitude, note)
     VALUES ($1, $2, 'image/webp', $3, $4, $5, $6, $7, $8)
     RETURNING id, job_id, content_type, width, height, octet_length(image_data) AS bytes, captured_at`,
    [
      jobId,
      compressed,
      original.contentType,
      metadata.width || 0,
      metadata.height || 0,
      Number.isFinite(Number(payload.lat)) ? Number(payload.lat) : null,
      Number.isFinite(Number(payload.lon)) ? Number(payload.lon) : null,
      payload.note ?? null,
    ]
  );
  return { ...result.rows[0], originalBytes: original.buffer.length };
}

async function ensureDatabaseSchema() {
  await pool.query(photoSchemaSql);
}

const server = http.createServer(async (request, response) => {
  if (request.method === "OPTIONS") return sendJson(response, 204, {});
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  try {
    if (request.method === "GET" && url.pathname === "/health") {
      await pool.query("SELECT 1");
      return sendJson(response, 200, { ok: true, database: "postgresql" });
    }

    const photoMatch = url.pathname.match(/^\/api\/mobile\/jobs\/([^/]+)\/photos$/);
    if (request.method === "POST" && photoMatch) {
      const payload = await readJson(request);
      const photo = await storePhoto(decodeURIComponent(photoMatch[1]), payload);
      return sendJson(response, 201, { photo });
    }

    return sendJson(response, 404, { error: "Not found" });
  } catch (error) {
    const status = error.message === "Photo payload is too large" ? 413 : 400;
    console.error(error);
    return sendJson(response, status, { error: error.message || "Request failed" });
  }
});

async function startServer() {
  try {
    await ensureDatabaseSchema();
    server.listen(port, () => {
      console.log(`OMS photo API listening on http://localhost:${port}`);
    });
  } catch (error) {
    console.error("Failed to initialize PostgreSQL schema:", error);
    process.exit(1);
  }
}

startServer();

process.on("SIGTERM", async () => {
  await pool.end();
  server.close();
});
