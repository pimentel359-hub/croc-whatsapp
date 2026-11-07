/**
 * PASTELARIA CROC & CIA - SERVIDOR BAILEYS WHATSAPP
 * Microserviço oficial para automação de mensagens de confirmação e status de pedidos.
 *
 * Como rodar:
 * 1. cd baileys-server
 * 2. npm install
 * 3. npm start
 */

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BAILEYS_API_KEY || "";

app.use(cors());
app.use(express.json());

let sock = null;
let currentQrCode = null;
let isConnected = false;
let connectedUser = null;

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");

  sock = makeWASocket({
    auth: state,
    logger: pino({ level: "silent" }),
    printQRInTerminal: false
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQrCode = qr;
      isConnected = false;
      console.log("\n[Baileys] Novo QR Code gerado! Escaneie pelo WhatsApp:");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      isConnected = false;
      connectedUser = null;
      console.log("[Baileys] Conexão encerrada. Reconectar?", shouldReconnect);
      if (shouldReconnect) {
        connectToWhatsApp();
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQrCode = null;
      connectedUser = sock.user?.id || "Conectado";
      console.log("[Baileys] ✅ WhatsApp conectado com sucesso! Usuário:", connectedUser);
    }
  });
}

// Iniciar conexão
connectToWhatsApp();

// Middleware de autenticação opcional
function checkAuth(req, res, next) {
  if (!API_KEY) return next();
  const authHeader = req.headers.authorization || req.headers.apikey;
  const token = authHeader ? authHeader.replace(/^Bearer\s+/i, "") : null;
  if (token === API_KEY) return next();
  return res.status(401).json({ success: false, error: "API Key inválida ou ausente" });
}

// 1. Rota de Status da Conexão
app.get("/status", (req, res) => {
  res.json({
    online: true,
    connected: isConnected,
    user: connectedUser,
    hasQrCode: !!currentQrCode,
    uptime: process.uptime()
  });
});

// 2. Rota para Visualizar o QR Code no Navegador
app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <title>Baileys - Conectado</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #120A1A; color: #FFFFFF; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #1F1528; border: 1px solid #7E22CE; padding: 30px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); }
          h2 { color: #4ADE80; margin-top: 0; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>✅ WhatsApp Conectado com Sucesso!</h2>
          <p style="color: #9CA3AF;">O microserviço Baileys está ativo e pronto para enviar mensagens.</p>
          <p><strong>Usuário:</strong> ${connectedUser}</p>
        </div>
      </body>
      </html>
    `);
  }

  if (!currentQrCode) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="3">
        <title>Aguardando QR Code...</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #120A1A; color: #FFFFFF; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
        </style>
      </head>
      <body>
        <div>
          <h2>⏳ Inicializando WhatsApp...</h2>
          <p style="color: #9CA3AF;">Gerando QR Code. A página atualizará automaticamente em 3 segundos.</p>
        </div>
      </body>
      </html>
    `);
  }

  try {
    const qrImage = await QRCode.toDataURL(currentQrCode);
    res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="refresh" content="15">
        <title>Escanear QR Code WhatsApp - Croc & Cia</title>
        <style>
          body { font-family: system-ui, sans-serif; background: #120A1A; color: #FFFFFF; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; text-align: center; }
          .card { background: #1F1528; border: 1px solid #7E22CE; padding: 30px; border-radius: 16px; box-shadow: 0 8px 30px rgba(0,0,0,0.5); max-width: 420px; }
          h2 { color: #FFBE1A; margin-top: 0; }
          img { border-radius: 12px; margin: 15px 0; background: white; padding: 12px; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🥟 Pastelaria Croc & Cia</h2>
          <p style="color: #D1D5DB; font-size: 0.9rem;">Abra o WhatsApp no seu celular &gt; Aparelhos conectados &gt; Conectar aparelho, e aponte para o QR Code abaixo:</p>
          <img src="${qrImage}" alt="QR Code Baileys" width="220" height="220">
          <p style="color: #9CA3AF; font-size: 0.8rem;">O QR Code é atualizado automaticamente.</p>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Erro ao renderizar QR Code: " + err.message);
  }
});

// 3. Rota de Envio de Mensagem de Texto
app.post("/send-message", checkAuth, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: "WhatsApp não está conectado. Acesse http://localhost:3000/qr para conectar."
    });
  }

  const phone = req.body.phone || req.body.number;
  const message = req.body.message || req.body.text;

  if (!phone || !message) {
    return res.status(400).json({
      success: false,
      error: "Campos 'phone' e 'message' são obrigatórios."
    });
  }

  let cleanPhone = String(phone).replace(/\D/g, "");
  if (cleanPhone.length === 10 || cleanPhone.length === 11) {
    cleanPhone = "55" + cleanPhone;
  }

  const jid = `${cleanPhone}@s.whatsapp.net`;

  try {
    const result = await sock.sendMessage(jid, { text: message });
    console.log(`[Baileys] ✅ Mensagem enviada para ${cleanPhone}`);
    return res.json({
      success: true,
      phone: cleanPhone,
      messageId: result?.key?.id
    });
  } catch (err) {
    console.error(`[Baileys] ❌ Erro ao enviar para ${cleanPhone}:`, err);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
});

// 4. Rota Proxy para Testar Conexão com Mercado Pago (Zero CORS)
app.post("/api/mercadopago/test", async (req, res) => {
  const token = (req.body.accessToken || req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return res.status(400).json({ success: false, error: "Access Token não informado." });
  }

  try {
    const mpRes = await fetch("https://api.mercadopago.com/users/me", {
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json"
      }
    });

    const data = await mpRes.json();
    if (mpRes.ok && data.id) {
      const userName = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.nickname || "Conta Mercado Pago";
      return res.json({
        success: true,
        account: {
          id: data.id,
          name: userName,
          email: data.email,
          nickname: data.nickname
        }
      });
    } else {
      return res.status(mpRes.status).json({
        success: false,
        error: data.message || "Access Token inválido ou não autorizado."
      });
    }
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: `Erro ao conectar com Mercado Pago: ${err.message}`
    });
  }
});

// 5. Rota Proxy para Criar Pix Oficial no Mercado Pago (Zero CORS)
app.post("/api/mercadopago/create-pix", async (req, res) => {
  const token = (req.body.accessToken || req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return res.status(400).json({ success: false, error: "Access Token não informado." });
  }

  const amount = Number(req.body.transaction_amount || 0);
  if (amount <= 0) {
    return res.status(400).json({ success: false, error: "Valor da transação inválido." });
  }

  const payload = {
    transaction_amount: amount,
    description: req.body.description || "Pedido - Pastelaria Croc & Cia",
    payment_method_id: "pix",
    payer: {
      email: req.body.payer?.email || "pedidos@pastelariacrocecia.com",
      first_name: req.body.payer?.first_name || "Cliente"
    }
  };

  try {
    const mpRes = await fetch("https://api.mercadopago.com/v1/payments", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Idempotency-Key": `croc_${req.body.orderNumber || Date.now()}_${Date.now()}`
      },
      body: JSON.stringify(payload)
    });

    const data = await mpRes.json();
    const qrCode = data.point_of_interaction?.transaction_data?.qr_code;
    const qrCodeBase64 = data.point_of_interaction?.transaction_data?.qr_code_base64;

    if (mpRes.ok && qrCode) {
      return res.json({
        success: true,
        payment_id: data.id,
        qr_code: qrCode,
        qr_code_base64: qrCodeBase64,
        status: data.status
      });
    } else {
      return res.status(mpRes.status).json({
        success: false,
        error: data.message || "Erro retornado pela API do Mercado Pago",
        raw: data
      });
    }
  } catch (err) {
    return res.status(502).json({
      success: false,
      error: `Erro de comunicação com o Mercado Pago: ${err.message}`
    });
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🥟 Servidor Baileys Croc & Cia rodando na porta ${PORT}`);
  console.log(`👉 Status: http://localhost:${PORT}/status`);
  console.log(`👉 QR Code: http://localhost:${PORT}/qr`);
  console.log(`👉 Envio: POST http://localhost:${PORT}/send-message`);
  console.log(`=======================================================`);
});
