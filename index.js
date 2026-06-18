/**
 * SteelTech — Alegra → Meta Conversions API
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
  PORT               = 3000,
} = process.env;

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
      event_name: "Purchase",
      event_time: Math.floor(Date.now() / 1000),
      action_source: "other",
      event_id: eventId,
      user_data: userData,
      custom_data: {
        value: parseFloat(value) || 0,
        currency: (currency || "USD").toUpperCase(),
        content_type: "product",
      },
    }],
  };

  const url = `https://graph.facebook.com/${META_API_VERSION}/${META_PIXEL_ID}/events?access_token=${META_ACCESS_TOKEN}`;
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Meta CAPI error: ${JSON.stringify(result)}`);
  return result;
}

app.post("/webhook/alegra", async (req, res) => {
  try {
    if (WEBHOOK_SECRET) {
      const secret = req.headers["x-alegra-secret"] || req.query.secret;
      if (secret !== WEBHOOK_SECRET) return res.status(401).json({ error: "Unauthorized" });
    }

    const body = req.body;
    const invoice = body.data || body;
    const client = invoice.client || {};
    const phone = client.phoneNumber || client.phone || client.mobile || null;
    const email = client.email || null;
    const fullName = client.name || client.fullName || "";
    const value = invoice.total || invoice.grandTotal || 0;
    const currency = invoice.currency?.code || invoice.currencyCode || "USD";
    const eventId = `alegra-invoice-${invoice.id || Date.now()}`;

    if (!phone && !email) return res.status(200).json({ message: "Ignored: no customer identifiers" });

    const result = await sendPurchaseToMeta({ phone, email, fullName, value, currency, eventId });
    res.status(200).json({ success: true, meta: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/", (req, res) => res.json({ status: "ok", service: "SteelTech – Alegra → Meta CAPI" }));

app.listen(PORT, () => console.log(`Servidor en puerto ${PORT}`));
