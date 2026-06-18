/**
 * SteelTech — Alegra → Meta Conversions API
 * Modo: polling cada 15 min (sin depender de webhooks de Alegra)
 */

const express = require("express");
const crypto  = require("crypto");
const fetch   = require("node-fetch");

const app = express();
app.use(express.json());

const {
  META_ACCESS_TOKEN,
  META_PIXEL_ID    = "572456420974818",
  META_API_VERSION = "v20.0",
  ALEGRA_EMAIL,
  ALEGRA_TOKEN,
  PORT             = 3000,
  POLL_INTERVAL_MS = 15 * 60 * 1000, // 15 minutos
} = process.env;

// ─── Utilidades ─────────────────────────────────────────────────────────────

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

// ─── Meta CAPI ──────────────────────────────────────────────────────────────

async function sendPurchaseToMeta({ phone, email, fullName, value, currency, eventId }) {
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
      event_name:    "Purchase",
      event_time:    Math.floor(Date.now() / 1000),
      action_source: "other",
      event_id:      eventId,
      user_data:     userData,
      custom_data: {
        value:        parseFloat(value) || 0,
        currency:     (currency || "DOP").toUpperCase(),
        content_type: "product",
      },
    }],
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;
  const res  = await fetch(url, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(payload),
  });
  const result = await res.json();
  if (!res.ok) throw new Error(`Meta CAPI: ${JSON.stringify(result)}`);
  return result;
}

// ─── Alegra API ─────────────────────────────────────────────────────────────

function alegraHeaders() {
  const creds = Buffer.from(`${ALEGRA_EMAIL}:${ALEGRA_TOKEN}`).toString("base64");
  return { Authorization: `Basic ${creds}`, "Content-Type": "application/json" };
}

async function getPaidInvoicesSince(since) {
  // since = Date ISO string — filtramos facturas modificadas desde esa fecha
  const params = new URLSearchParams({
    status:    "closed",
    order:     "desc",
    start:     "0",
    limit:     "30",
    dateRange: "custom",
    // Alegra no tiene filtro por fecha de pago en todos los planes,
    // así que traemos las últimas 50 cerradas y filtramos por fecha
  });
  const res = await fetch(`https://api.alegra.com/api/v1/invoices?${params}`, {
    headers: alegraHeaders(),
  });
  if (!res.ok) throw new Error(`Alegra API ${res.status}: ${await res.text()}`);
  const invoices = await res.json();
  // Filtrar las pagadas después de "since"
  return invoices.filter((inv) => {
    const paid = inv.dueDate || inv.closedDate || inv.date;
    return paid && new Date(paid) >= new Date(since);
  });
}

// ─── Polling ────────────────────────────────────────────────────────────────

let lastPollTime = new Date(Date.now() - POLL_INTERVAL_MS).toISOString();
const sentInvoices = new Set(); // evita duplicados durante la sesión del servidor

async function pollAlegra() {
  if (!ALEGRA_EMAIL || !ALEGRA_TOKEN) {
    console.log("[poll] Sin credenciales de Alegra — saltando");
    return;
  }
  const since = lastPollTime;
  lastPollTime = new Date().toISOString();

  console.log(`[poll] Buscando facturas pagadas desde ${since}...`);
  try {
    const invoices = await getPaidInvoicesSince(since);
    console.log(`[poll] ${invoices.length} factura(s) encontrada(s)`);

    for (const inv of invoices) {
      const id = String(inv.id);
      if (sentInvoices.has(id)) continue;

      const client   = inv.client || {};
      const phone    = client.phonePrimary || client.phoneNumber || client.phone || client.mobile || null;
      const email    = client.email || null;
      const fullName = client.name || "";
      const value    = inv.total || 0;
      const currency = inv.currency?.code || "DOP";

      if (!phone && !email) {
        console.log(`[poll] Factura #${id} ignorada — sin datos de contacto`);
        continue;
      }

      const result = await sendPurchaseToMeta({
        phone, email, fullName, value, currency,
        eventId: `alegra-${id}`,
      });
      sentInvoices.add(id);
      console.log(`[poll] Factura #${id} enviada a Meta:`, result);
    }
  } catch (err) {
    console.error("[poll] Error:", err.message);
  }
}

// Ejecutar polling al iniciar y luego cada POLL_INTERVAL_MS
pollAlegra();
setInterval(pollAlegra, POLL_INTERVAL_MS);

// ─── Endpoints HTTP ─────────────────────────────────────────────────────────

// Endpoint de salud y estado
app.get("/", (req, res) => res.json({
  status:       "ok",
  service:      "SteelTech – Alegra → Meta CAPI",
  lastPoll:     lastPollTime,
  sentInvoices: sentInvoices.size,
}));

// Forzar un poll manual (útil para probar)
// Acepta ?since=2026-06-10 para buscar desde una fecha específica
app.post("/poll", async (req, res) => {
  if (req.query.since) {
    const prev = lastPollTime;
    lastPollTime = new Date(req.query.since).toISOString();
    await pollAlegra();
    res.json({ ok: true, testedSince: req.query.since, lastPoll: lastPollTime });
    lastPollTime = prev; // restaurar
  } else {
    await pollAlegra();
    res.json({ ok: true, lastPoll: lastPollTime });
  }
});

// Webhook de Alegra (por si en el futuro logran registrarlo)
app.get("/webhook/alegra",  (req, res) => res.status(200).json({ status: "ok" }));
app.post("/webhook/alegra", async (req, res) => {
  try {
    const invoice = req.body?.data || req.body || {};
    const status  = (invoice.status || "").toLowerCase();
    if (!["closed", "paid", "total"].includes(status)) {
      return res.status(200).json({ message: `Ignored: status='${status}'` });
    }
    const client   = invoice.client || {};
    const phone    = client.phonePrimary || client.phoneNumber || client.phone || client.mobile || null;
    const email    = client.email || null;
    const fullName = client.name || "";
    const value    = invoice.total || 0;
    const currency = invoice.currency?.code || "DOP";
    const eventId  = `alegra-invoice-${invoice.id || Date.now()}`;
    if (!phone && !email) return res.status(200).json({ message: "Ignored: no identifiers" });
    const result = await sendPurchaseToMeta({ phone, email, fullName, value, currency, eventId });
    res.status(200).json({ success: true, meta: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
