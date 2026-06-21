/**
 * SteelTech — Alegra → Meta Conversions API
 * Polling + Webhook
 */

const express = require("express");
const crypto  = require("crypto");
const fetch   = require("node-fetch");

const app = express();
app.use(express.json());

const {
  META_ACCESS_TOKEN,
  META_PIXEL_ID      = "572456420974818",
  META_API_VERSION   = "v20.0",
  WEBHOOK_SECRET     = "",
  ALEGRA_EMAIL,
  ALEGRA_TOKEN,
  // Fecha desde la que empieza el primer poll (ISO 8601).
  // Ej: "2026-06-17T00:00:00.000Z"
  // Si no se configura, usa 7 días atrás para recuperar facturas recientes.
  POLL_FROM_DATE,
  POLL_INTERVAL_MS   = 15 * 60 * 1000,
  PORT               = 3000,
} = process.env;

// ── Estado global ────────────────────────────────────────────────────────────
let lastPoll = POLL_FROM_DATE
  ? new Date(POLL_FROM_DATE)
  : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // 7 días atrás por defecto

let sentInvoices = 0;

console.log(`[init] Poll inicial desde: ${lastPoll.toISOString()}`);

// ── Helpers ──────────────────────────────────────────────────────────────────
function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash("sha256").update(String(value).toLowerCase().trim()).digest("hex");
}

function normalizePhone(phone) {
  if (!phone) return undefined;
  return String(phone).replace(/\D/g, "");
}

function splitName(fullName = "") {
  const parts = fullName.trim().split(/\s+/);
  return { first: parts[0] || "", last: parts.slice(1).join(" ") || "" };
}

// ── Alegra API ───────────────────────────────────────────────────────────────
async function fetchAlegraInvoices(since) {
  if (!ALEGRA_EMAIL || !ALEGRA_TOKEN) {
    throw new Error("ALEGRA_EMAIL o ALEGRA_TOKEN no configurados");
  }

  const dateStr = since.toISOString().split("T")[0]; // YYYY-MM-DD
  const url = `https://app.alegra.com/api/v1/invoices?status=paid&date-start=${dateStr}&limit=30`;
  const auth = Buffer.from(`${ALEGRA_EMAIL}:${ALEGRA_TOKEN}`).toString("base64");

  const res = await fetch(url, {
    headers: {
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Alegra API ${res.status}: ${text}`);
  }

  const data = await res.json();
  // Alegra puede devolver un array directo o un objeto con items/data
  return Array.isArray(data) ? data : (data.items || data.data || []);
}

// ── Meta CAPI ────────────────────────────────────────────────────────────────
async function sendPurchaseToMeta({ phone, email, fullName, value, currency, eventId, eventTime }) {
  if (!META_ACCESS_TOKEN) throw new Error("META_ACCESS_TOKEN no configurado");

  const { first, last } = splitName(fullName);
  const userData = {
    ph: sha256(normalizePhone(phone)),
    em: sha256(email),
    fn: sha256(first),
    ln: sha256(last),
  };
  Object.keys(userData).forEach((k) => userData[k] === undefined && delete userData[k]);

  const payload = {
    data: [{
      event_name: "Purchase",
      event_time: eventTime || Math.floor(Date.now() / 1000),
      action_source: "other",
      event_id: eventId,
      user_data: userData,
      custom_data: {
        value: parseFloat(value) || 0,
        currency: (currency || "DOP").toUpperCase(),
        content_type: "product",
      },
    }],
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(`Meta CAPI error: ${JSON.stringify(result)}`);
  return result;
}

// ── Procesar una factura de Alegra ────────────────────────────────────────────
async function processInvoice(invoice) {
  const client   = invoice.client || {};
  const phone    = client.phonePrimary || client.phoneNumber || client.phone || client.mobile || null;
  const email    = client.email || null;
  const fullName = client.name || client.fullName || "";
  const value    = invoice.total || invoice.grandTotal || 0;
  const currency = invoice.currency?.code || invoice.currencyCode || "DOP";
  const eventId  = `alegra-invoice-${invoice.id}`;
  const eventTime = invoice.date
    ? Math.floor(new Date(invoice.date).getTime() / 1000)
    : undefined;

  if (!phone && !email) {
    console.log(`[skip] Factura ${invoice.id} sin datos de contacto del cliente`);
    return null;
  }

  const result = await sendPurchaseToMeta({ phone, email, fullName, value, currency, eventId, eventTime });
  sentInvoices++;
  console.log(`[sent] Factura ${invoice.id} → Meta OK (total enviadas: ${sentInvoices})`);
  return result;
}

// ── Loop de polling ───────────────────────────────────────────────────────────
async function poll() {
  const since = new Date(lastPoll);
  console.log(`[poll] Buscando facturas pagadas desde ${since.toISOString()}...`);

  try {
    const invoices = await fetchAlegraInvoices(since);
    console.log(`[poll] ${invoices.length} factura(s) encontrada(s)`);

    for (const inv of invoices) {
      try {
        await processInvoice(inv);
      } catch (err) {
        console.error(`[error] Factura ${inv.id}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[poll error] ${err.message}`);
  }

  lastPoll = new Date();
}

// Primer poll inmediato al arrancar, luego cada POLL_INTERVAL_MS
poll();
setInterval(poll, Number(POLL_INTERVAL_MS));

// ── Rutas Express ─────────────────────────────────────────────────────────────

// Webhook directo desde Alegra (si lo configuras en Alegra)
app.post("/webhook/alegra", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const secret = req.headers["x-alegra-secret"] || req.query.secret;
      if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    }

    const body    = req.body;
    const invoice = body.data || body;
    const result  = await processInvoice(invoice);

    if (!result) return res.status(200).json({ message: "Ignorado: sin datos de contacto" });
    res.status(200).json({ success: true, meta: result });
  } catch (err) {
    console.error(`[webhook error] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Backfill manual: GET /backfill?from=2026-06-17&to=2026-06-21
app.get("/backfill", async (req, res) => {
  try {
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    console.log(`[backfill] Recuperando facturas desde ${from.toISOString()}`);
    const invoices = await fetchAlegraInvoices(from);
    console.log(`[backfill] ${invoices.length} factura(s) encontrada(s)`);

    const results = [];
    for (const inv of invoices) {
      try {
        const r = await processInvoice(inv);
        results.push({ id: inv.id, status: r ? "sent" : "skipped" });
      } catch (err) {
        results.push({ id: inv.id, status: "error", error: err.message });
      }
    }
    res.json({ processed: results.length, results });
  } catch (err) {
    console.error(`[backfill error] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/", (req, res) => res.json({
  status: "ok",
  service: "SteelTech – Alegra → Meta CAPI",
  lastPoll: lastPoll.toISOString(),
  sentInvoices,
}));

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
