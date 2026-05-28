import "dotenv/config";
import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import pino from "pino";
import fs from "fs";
import path from "path";
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));

const PORT = process.env.PORT || 8081;
const API_KEY = process.env.API_KEY;
const SESSIONS_DIR = process.env.SESSIONS_DIR || "/opt/whatsapp-gateway/sessions";

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

const sessions = new Map();

function auth(req, res, next) {
  const key = req.headers.apikey || req.headers.authorization?.replace("Bearer ", "");
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function sessionPath(instanceName) {
  return path.join(SESSIONS_DIR, instanceName);
}

async function sendWebhook(instanceName, event, payload = {}) {
  const s = sessions.get(instanceName);
  const webhook = s?.webhook;
  if (!webhook?.url) return;

  try {
    await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webhook.headers || {}),
      },
      body: JSON.stringify({
        event,
        instance: instanceName,
        instanceName,
        data: payload,
        ...payload,
      }),
    });
    console.log(`[${instanceName}] webhook enviado: ${event}`);
  } catch (err) {
    console.error(`[${instanceName}] erro webhook ${event}:`, err.message);
  }
}

async function startInstance(instanceName, webhook = null) {
  const existing = sessions.get(instanceName);
  if (existing) {
    if (webhook) existing.webhook = webhook;
    return existing;
  }

  const dir = sessionPath(instanceName);
  fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const data = {
    instanceName,
    status: "connecting",
    qr: null,
    sock: null,
    phone: null,
    webhook,
    restarting: false,
  };

  sessions.set(instanceName, data);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    browser: ["CenterFlow", "Chrome", "1.0.0"],
  });

  data.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      data.qr = await qrcode.toDataURL(qr);
      data.status = "connecting";
      console.log(`[${instanceName}] QR atualizado`);

      await sendWebhook(instanceName, "QRCODE_UPDATED", {
        qrcode: data.qr,
        base64: data.qr,
        qrcode_base64: data.qr,
      });
    }

    if (connection === "open") {
      data.status = "connected";
      data.qr = null;
      data.phone = sock.user?.id || null;
      console.log(`[${instanceName}] conectado: ${data.phone}`);

      await sendWebhook(instanceName, "CONNECTION_UPDATE", {
        state: "open",
        status: "open",
        connection: "open",
        phone: data.phone,
        ownerJid: data.phone,
      });
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${instanceName}] close code=${code}`);

      if (code === DisconnectReason.loggedOut) {
        data.status = "disconnected";
        sessions.delete(instanceName);

        await sendWebhook(instanceName, "CONNECTION_UPDATE", {
          state: "close",
          status: "close",
          connection: "close",
          statusReason: code,
        });

        return;
      }

      // 408/timeout é transitório. Não avisar o Financeiro como desconectado.
      // Reinicia mantendo webhook e sessão.
      if (!data.restarting) {
        data.restarting = true;
        setTimeout(async () => {
          sessions.delete(instanceName);
          try {
            await startInstance(instanceName, data.webhook);
          } catch (err) {
            console.error(`[${instanceName}] erro ao reiniciar:`, err.message);
          }
        }, 2000);
      }
    }
  });

  return data;
}

app.get("/health", (req, res) => {
  res.json({ ok: true, service: "whatsapp-gateway" });
});

app.post("/instance/create", auth, async (req, res) => {
  const { instanceName } = req.body || {};
  if (!instanceName) return res.status(400).json({ error: "instanceName obrigatório" });

  const s = await startInstance(instanceName, req.body?.webhook || null);

  res.json({
    instance: {
      instanceName,
      status: s.status,
      integration: "WHATSAPP-BAILEYS",
    },
    qrcode: s.qr ? { base64: s.qr } : { count: 0 },
  });
});

app.get("/instance/connect/:instanceName", auth, async (req, res) => {
  const { instanceName } = req.params;
  const s = await startInstance(instanceName);

  if (s.status === "connected") {
    return res.json({
      instance: {
        instanceName,
        state: "open",
      },
    });
  }

  if (s.qr) {
    return res.json({
      base64: s.qr,
      qrcode: s.qr,
      code: s.qr,
      qrcode_base64: s.qr,
    });
  }

  res.json({ count: 0 });
});

app.get("/instance/fetchInstances", auth, (req, res) => {
  const list = [];

  for (const [name, s] of sessions.entries()) {
    list.push({
      name,
      instanceName: name,
      connectionStatus: s.status === "connected" ? "open" : s.status,
      ownerJid: s.phone,
      qrcode: s.qr ? { base64: s.qr } : undefined,
      base64: s.qr || undefined,
    });
  }

  res.json(list);
});

app.post("/instance/logout/:instanceName", auth, async (req, res) => {
  const { instanceName } = req.params;
  const s = sessions.get(instanceName);

  if (s?.sock) {
    try {
      await s.sock.logout();
    } catch {}
  }

  sessions.delete(instanceName);
  res.json({ status: "SUCCESS", response: { message: "logged out" } });
});

app.delete("/instance/delete/:instanceName", auth, async (req, res) => {
  const { instanceName } = req.params;
  const s = sessions.get(instanceName);

  if (s?.sock) {
    try {
      await s.sock.logout();
    } catch {}
  }

  sessions.delete(instanceName);

  const dir = sessionPath(instanceName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  res.json({ status: "SUCCESS", error: false, response: { message: "Instance deleted" } });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`WhatsApp Gateway rodando em http://0.0.0.0:${PORT}`);
});
