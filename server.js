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

const PORT = Number(process.env.PORT) || 8081;
const API_KEY = process.env.API_KEY;
const SESSIONS_DIR =
  process.env.SESSIONS_DIR || path.join(process.cwd(), "sessions");

const DEFAULT_WEBHOOK_EVENTS = ["QRCODE_UPDATED", "CONNECTION_UPDATE"];

/** Códigos de desconexão transitória — reinicia sem avisar o Financeiro. */
const TRANSIENT_DISCONNECT_CODES = new Set([
  DisconnectReason.timedOut, // 408
  DisconnectReason.connectionClosed, // 428
  DisconnectReason.restartRequired, // 515
  DisconnectReason.connectionLost, // 408 em algumas versões
  440, // connectionReplaced
]);

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

/** @type {Map<string, SessionData>} */
const sessions = new Map();

function auth(req, res, next) {
  const key =
    req.headers.apikey ||
    req.headers["api-key"] ||
    req.headers.authorization?.replace(/^Bearer\s+/i, "");
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

function sessionPath(instanceName) {
  return path.join(SESSIONS_DIR, instanceName);
}

function webhookMetaPath(instanceName) {
  return path.join(sessionPath(instanceName), "webhook.json");
}

function normalizeWebhook(input) {
  if (!input || typeof input !== "object") return null;

  const nested = input.webhook && typeof input.webhook === "object" ? input.webhook : input;
  const url = nested.url || nested.webhookUrl || input.webhookUrl;
  if (!url) return null;

  const eventsRaw = nested.events || input.events || DEFAULT_WEBHOOK_EVENTS;
  const events = (Array.isArray(eventsRaw) ? eventsRaw : [eventsRaw])
    .map((e) => String(e).toUpperCase().replace(/\./g, "_"))
    .filter(Boolean);

  return {
    url: String(url),
    headers:
      nested.headers && typeof nested.headers === "object" ? { ...nested.headers } : {},
    events: events.length ? events : [...DEFAULT_WEBHOOK_EVENTS],
    byEvents: nested.byEvents !== false,
  };
}

function saveWebhookMeta(instanceName, webhook) {
  if (!webhook?.url) return;
  const dir = sessionPath(instanceName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(webhookMetaPath(instanceName), JSON.stringify(webhook, null, 2), "utf8");
}

function loadWebhookMeta(instanceName) {
  const file = webhookMetaPath(instanceName);
  if (!fs.existsSync(file)) return null;
  try {
    return normalizeWebhook(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function clearWebhookMeta(instanceName) {
  const file = webhookMetaPath(instanceName);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

function shouldSendWebhook(webhook, event) {
  if (!webhook?.url) return false;
  if (!webhook.byEvents) return true;
  const normalized = String(event).toUpperCase().replace(/\./g, "_");
  return (webhook.events || DEFAULT_WEBHOOK_EVENTS).includes(normalized);
}

async function sendWebhook(instanceName, event, payload = {}, webhookOverride = null) {
  const s = sessions.get(instanceName);
  const webhook = webhookOverride || s?.webhook || loadWebhookMeta(instanceName);
  if (!shouldSendWebhook(webhook, event)) return;

  const body = {
    event,
    instance: instanceName,
    instanceName,
    data: payload,
    ...payload,
  };

  try {
    const res = await fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webhook.headers || {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(
        `[${instanceName}] webhook ${event} HTTP ${res.status}: ${await res.text().catch(() => "")}`
      );
    } else {
      console.log(`[${instanceName}] webhook enviado: ${event}`);
    }
  } catch (err) {
    console.error(`[${instanceName}] erro webhook ${event}:`, err.message);
  }
}

function listPersistedInstances() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  return fs
    .readdirSync(SESSIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((name) => {
      const dir = sessionPath(name);
      try {
        return fs.readdirSync(dir).some((f) => f.endsWith(".json") && f !== "webhook.json");
      } catch {
        return false;
      }
    });
}

function removeSessionFiles(instanceName) {
  const dir = sessionPath(instanceName);
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function stopSocket(sock) {
  if (!sock) return;
  try {
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("creds.update");
  } catch {}
  try {
    sock.end(undefined);
  } catch {}
}

function sessionToListItem(name, s) {
  const status =
    s.status === "connected"
      ? "open"
      : s.status === "connecting"
        ? "connecting"
        : s.status;
  return {
    name,
    instanceName: name,
    connectionStatus: status,
    ownerJid: s.phone || undefined,
    qrcode: s.qr ? { base64: s.qr } : undefined,
    base64: s.qr || undefined,
    instance: {
      instanceName: name,
      status,
      state: status === "open" ? "open" : status,
      ownerJid: s.phone || undefined,
    },
  };
}

async function startInstance(instanceName, webhookInput = null) {
  const existing = sessions.get(instanceName);
  if (existing?.sock && !existing.restarting) {
    if (webhookInput) {
      existing.webhook = webhookInput;
      saveWebhookMeta(instanceName, webhookInput);
    }
    return existing;
  }

  const webhook =
    webhookInput || existing?.webhook || loadWebhookMeta(instanceName) || null;
  if (webhook) saveWebhookMeta(instanceName, webhook);

  if (existing?.sock) {
    await stopSocket(existing.sock);
    sessions.delete(instanceName);
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
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
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
      data.restarting = false;
      data.phone = sock.user?.id || null;
      console.log(`[${instanceName}] conectado: ${data.phone}`);

      await sendWebhook(instanceName, "CONNECTION_UPDATE", {
        state: "open",
        status: "open",
        connection: "open",
        phone: data.phone,
        phoneNumber: data.phone,
        ownerJid: data.phone,
        instance: {
          instanceName,
          state: "open",
          owner: data.phone,
        },
      });
    }

    if (connection === "close") {
      const code =
        lastDisconnect?.error?.output?.statusCode ??
        lastDisconnect?.error?.data?.reason ??
        lastDisconnect?.error?.code;

      console.log(`[${instanceName}] close code=${code}`);

      if (code === DisconnectReason.loggedOut) {
        const webhookRef = data.webhook || loadWebhookMeta(instanceName);
        data.status = "disconnected";

        await sendWebhook(
          instanceName,
          "CONNECTION_UPDATE",
          {
            state: "close",
            status: "close",
            connection: "close",
            statusReason: code,
          },
          webhookRef
        );

        await stopSocket(sock);
        sessions.delete(instanceName);
        removeSessionFiles(instanceName);
        return;
      }

      if (TRANSIENT_DISCONNECT_CODES.has(code)) {
        if (!data.restarting) {
          data.restarting = true;
          data.status = "connecting";
          const savedWebhook = data.webhook || loadWebhookMeta(instanceName);
          console.log(`[${instanceName}] desconexao transitória (${code}), reiniciando...`);

          await stopSocket(sock);
          sessions.delete(instanceName);

          setTimeout(async () => {
            try {
              await startInstance(instanceName, savedWebhook);
            } catch (err) {
              console.error(`[${instanceName}] erro ao reiniciar:`, err.message);
            }
          }, 2000);
        }
        return;
      }

      // Outros fechamentos: reinicia sem notificar desconexão definitiva
      if (!data.restarting) {
        data.restarting = true;
        const savedWebhook = data.webhook || loadWebhookMeta(instanceName);
        await stopSocket(sock);
        sessions.delete(instanceName);
        setTimeout(async () => {
          try {
            await startInstance(instanceName, savedWebhook);
          } catch (err) {
            console.error(`[${instanceName}] erro ao reiniciar:`, err.message);
          }
        }, 3000);
      }
    }
  });

  return data;
}

async function logoutHandler(req, res) {
  const { instanceName } = req.params;
  const s = sessions.get(instanceName);
  const webhookRef = s?.webhook || loadWebhookMeta(instanceName);

  if (s?.sock) {
    try {
      await s.sock.logout();
    } catch (err) {
      console.warn(`[${instanceName}] logout sock:`, err.message);
    }
    await stopSocket(s.sock);
  }

  sessions.delete(instanceName);
  removeSessionFiles(instanceName);

  await sendWebhook(
    instanceName,
    "CONNECTION_UPDATE",
    { state: "close", status: "close", connection: "close" },
    webhookRef
  );

  res.json({ status: "SUCCESS", response: { message: "logged out" } });
}

async function restorePersistedSessions() {
  const names = listPersistedInstances();
  if (!names.length) return;

  console.log(`Restaurando ${names.length} sessão(ões) em disco...`);
  for (const name of names) {
    try {
      const webhook = loadWebhookMeta(name);
      await startInstance(name, webhook);
      console.log(`[${name}] sessão restaurada`);
    } catch (err) {
      console.error(`[${name}] falha ao restaurar:`, err.message);
    }
  }
}

// ─── Rotas ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "whatsapp-gateway",
    sessions: sessions.size,
    sessionsDir: SESSIONS_DIR,
  });
});

app.post("/instance/create", auth, async (req, res) => {
  const { instanceName } = req.body || {};
  if (!instanceName) {
    return res.status(400).json({ error: "instanceName obrigatório" });
  }

  const webhook = normalizeWebhook(req.body);
  const s = await startInstance(instanceName, webhook);

  res.json({
    instance: {
      instanceName,
      status: s.status === "connected" ? "open" : s.status,
      state: s.status === "connected" ? "open" : "connecting",
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
        status: "open",
      },
    });
  }

  if (s.qr) {
    return res.json({
      base64: s.qr,
      qrcode: s.qr,
      code: s.qr,
      qrcode_base64: s.qr,
      pairingCode: null,
    });
  }

  res.json({ count: 0 });
});

app.get("/instance/fetchInstances", auth, (req, res) => {
  const filter = req.query.instanceName;
  const list = [];
  const seen = new Set();

  for (const [name, s] of sessions.entries()) {
    if (filter && name !== filter) continue;
    seen.add(name);
    list.push(sessionToListItem(name, s));
  }

  for (const name of listPersistedInstances()) {
    if (filter && name !== filter) continue;
    if (seen.has(name)) continue;
    list.push({
      name,
      instanceName: name,
      connectionStatus: "close",
      instance: { instanceName: name, state: "close" },
    });
  }

  if (filter && list.length === 0) {
    return res.status(404).json({ message: "Instance not found" });
  }

  res.json(list);
});

app.post("/instance/logout/:instanceName", auth, logoutHandler);
app.delete("/instance/logout/:instanceName", auth, logoutHandler);

app.delete("/instance/delete/:instanceName", auth, async (req, res) => {
  const { instanceName } = req.params;
  const s = sessions.get(instanceName);

  if (s?.sock) {
    try {
      await s.sock.logout();
    } catch {}
    await stopSocket(s.sock);
  }

  sessions.delete(instanceName);
  removeSessionFiles(instanceName);

  res.json({
    status: "SUCCESS",
    error: false,
    response: { message: "Instance deleted" },
  });
});

app.listen(PORT, "0.0.0.0", async () => {
  console.log(`WhatsApp Gateway em http://0.0.0.0:${PORT}`);
  console.log(`Sessões: ${SESSIONS_DIR}`);
  if (!API_KEY) {
    console.warn("AVISO: API_KEY não definida — todas as rotas retornarão 401.");
  }
  await restorePersistedSessions();
});
