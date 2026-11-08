/**
 * PASTELARIA CROC & CIA - SERVIDOR BAILEYS WHATSAPP v2.0
 * Microserviço oficial para automação de confirmação de pedidos, notificações de entrega e status Pix.
 * 
 * Melhorias v2.0:
 * - Auto-reconexão inteligente com regeneração automática de QR Code em caso de logout / queda
 * - Limpeza automática de credenciais expiradas (elimina necessidade de reiniciar serviço no Render)
 * - Versão dinâmica do WhatsApp Web (fetchLatestBaileysVersion) para evitar atraso/desync no app do celular
 * - Suporte a push notifications completas no celular (elimina corte abrupto de presença)
 * - Rotas de resgate: /reset-session e /reconnect para controle direto pelo painel de retaguarda
 */

const express = require("express");
const cors = require("cors");
const pino = require("pino");
const QRCode = require("qrcode");
const qrcodeTerminal = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BAILEYS_API_KEY || "";
const AUTH_DIR = path.join(__dirname, "auth_info_baileys");

app.use(cors());
app.use(express.json());

let sock = null;
let currentQrCode = null;
let isConnected = false;
let connectedUser = null;
let isConnecting = false;
let reconnectTimer = null;
let consecutiveErrors = 0;

// Função para limpar credenciais expiradas/corrompidas
function cleanAuthFolder() {
  try {
    if (fs.existsSync(AUTH_DIR)) {
      fs.rmSync(AUTH_DIR, { recursive: true, force: true });
      console.log("[Baileys] 🗑️ Pasta 'auth_info_baileys' limpa com sucesso.");
    }
  } catch (err) {
    console.error("[Baileys] ❌ Erro ao limpar auth_info_baileys:", err.message);
  }
}

// Agendador de reconexão segura com debounce
function scheduleReconnect(delayMs = 3000, forceClean = false) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    if (forceClean) {
      cleanAuthFolder();
    }
    await connectToWhatsApp();
  }, delayMs);
}

// Inicializador da Conexão Baileys
async function connectToWhatsApp() {
  if (isConnecting) {
    console.log("[Baileys] Conexão já em andamento, aguardando...");
    return;
  }
  isConnecting = true;

  try {
    // Encerra socket antigo se ainda estiver instanciado
    if (sock) {
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("creds.update");
        sock.ev.removeAllListeners("messages.upsert");
        sock.end(undefined);
      } catch (_) {}
      sock = null;
    }

    if (!fs.existsSync(AUTH_DIR)) {
      fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    // Obtém versão mais recente do WhatsApp Web para que os servidores do WhatsApp
    // roteiem as mensagens instantaneamente para o celular e para o WhatsApp Web
    let version = [2, 3000, 1015901307];
    try {
      if (typeof fetchLatestBaileysVersion === "function") {
        const vInfo = await fetchLatestBaileysVersion();
        if (vInfo && vInfo.version) {
          version = vInfo.version;
          console.log(`[Baileys] WhatsApp Web versão sincronizada: v${version.join(".")} (isLatest: ${vInfo.isLatest})`);
        }
      }
    } catch (e) {
      console.warn("[Baileys] Aviso ao buscar versão recente do WhatsApp Web (usando fallback):", e.message);
    }

    const socketConfig = {
      version,
      auth: state,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      markOnlineOnConnect: false, // Não altera o status para online no momento da conexão
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000
    };

    if (typeof Browsers !== "undefined" && Browsers.appropriate) {
      socketConfig.browser = Browsers.appropriate("Pastelaria Croc & Cia");
    } else {
      socketConfig.browser = ["Pastelaria Croc & Cia", "Chrome", "124.0.0"];
    }

    sock = makeWASocket(socketConfig);

    sock.ev.on("creds.update", saveCreds);

    // MODO EXCLUSIVO DE ENVIO (UNIDIRECIONAL):
    // Não marca mensagens recebidas como lidas para não suprimir notificações do telefone
    sock.ev.on("messages.upsert", async () => {
      // Intencionalmente vazio
    });

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        currentQrCode = qr;
        isConnected = false;
        console.log("\n[Baileys] 📱 Novo QR Code gerado! Pronto para escanear em /qr");
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === "close") {
        isConnected = false;
        connectedUser = null;

        const statusCode = lastDisconnect?.error?.output?.statusCode;
        console.log(`[Baileys] ⚠️ Conexão encerrada. Código: ${statusCode} - ${lastDisconnect?.error?.message || ""}`);

        const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
        const isCorrupted = statusCode === 408 || statusCode === 428 || statusCode === 515;

        if (isLoggedOut) {
          console.log("[Baileys] 🚪 Sessão desconectada / deslogada pelo WhatsApp.");
          console.log("[Baileys] 🔄 Limpando credenciais antigas e gerando NOVO QR Code automaticamente...");
          currentQrCode = null;
          consecutiveErrors = 0;
          scheduleReconnect(2000, true);
        } else if (isCorrupted) {
          consecutiveErrors++;
          console.log(`[Baileys] ⚠️ Erro de stream/conflito (${statusCode}). Tentativa consecutiva: ${consecutiveErrors}`);
          if (consecutiveErrors >= 3) {
            console.log("[Baileys] 🚨 Múltiplas falhas consecutivas. Resetando sessão para novo QR Code...");
            consecutiveErrors = 0;
            currentQrCode = null;
            scheduleReconnect(3000, true);
          } else {
            scheduleReconnect(4000, false);
          }
        } else {
          console.log("[Baileys] 🔄 Conexão temporariamente interrompida. Reconectando em 3s...");
          scheduleReconnect(3000, false);
        }
      } else if (connection === "open") {
        isConnected = true;
        currentQrCode = null;
        consecutiveErrors = 0;
        connectedUser = sock.user?.id || "Conectado";
        console.log("[Baileys] ✅ WhatsApp conectado com sucesso! Usuário:", connectedUser);
      }
    });

  } catch (err) {
    console.error("[Baileys] ❌ Erro ao inicializar conexão Baileys:", err);
    scheduleReconnect(5000, false);
  } finally {
    isConnecting = false;
  }
}

// Iniciar conexão imediatamente
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
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// 2. Rota para Visualizar o QR Code no Navegador com Controles de Resgate
app.get("/qr", async (req, res) => {
  if (isConnected) {
    return res.send(`
      <!DOCTYPE html>
      <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>WhatsApp Conectado - Pastelaria Croc & Cia</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #0F0914; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
          .card { background: #1B1224; border: 1px solid #7E22CE; padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); max-width: 480px; width: 100%; text-align: center; }
          .badge-online { display: inline-flex; align-items: center; gap: 8px; background: rgba(34, 197, 94, 0.15); border: 1px solid #22C55E; color: #4ADE80; padding: 6px 16px; border-radius: 9999px; font-weight: 700; font-size: 0.95rem; margin-bottom: 20px; }
          .user-box { background: rgba(0,0,0,0.3); border: 1px solid #374151; padding: 12px; border-radius: 10px; font-family: monospace; font-size: 1rem; color: #F3F4F6; margin: 15px 0 25px 0; word-break: break-all; }
          .btn-group { display: flex; flex-direction: column; gap: 12px; }
          .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 12px 20px; border-radius: 12px; font-weight: 700; font-size: 0.95rem; text-decoration: none; cursor: pointer; transition: all 0.2s; border: none; }
          .btn-primary { background: #7E22CE; color: white; }
          .btn-primary:hover { background: #9333EA; }
          .btn-danger { background: rgba(239, 68, 68, 0.15); border: 1px solid #EF4444; color: #FCA5A5; }
          .btn-danger:hover { background: rgba(239, 68, 68, 0.3); }
          .btn-link { background: transparent; color: #9CA3AF; font-size: 0.85rem; }
          .btn-link:hover { color: #FFFFFF; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="badge-online">
            <span>●</span> WhatsApp Online &amp; Conectado
          </div>
          <h2 style="margin: 0 0 10px 0; color: #FFFFFF;">🥟 Pastelaria Croc &amp; Cia</h2>
          <p style="color: #9CA3AF; margin: 0 0 15px 0; font-size: 0.95rem;">O microserviço Baileys está ativo e enviando notificações de pedidos normalmente.</p>
          
          <div class="user-box">
            ${connectedUser}
          </div>

          <div class="btn-group">
            <button class="btn btn-primary" onclick="testSend()">
              💬 Enviar Mensagem de Teste
            </button>
            <button class="btn btn-danger" onclick="confirmReset()">
              🔄 Desconectar e Gerar Novo QR Code
            </button>
            <a href="https://pastelariacrocecia.freedev.app/admin.html" class="btn btn-link">
              ⬅ Voltar ao Painel da Pastelaria
            </a>
          </div>
        </div>

        <script>
          function confirmReset() {
            if (confirm("Deseja realmente desconectar este aparelho e gerar um novo QR Code?")) {
              window.location.href = "/reset-session";
            }
          }
          async function testSend() {
            const phone = prompt("Digite o número para o teste (com DDD):", "81991896473");
            if (!phone) return;
            const res = await fetch("/send-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                phone: phone,
                message: "🥟 Teste de envio da Pastelaria Croc & Cia! Conexão ativa e sincronizada com sucesso."
              })
            });
            const data = await res.json();
            if (data.success) {
              alert("✅ Mensagem de teste enviada com sucesso para " + phone + "!");
            } else {
              alert("❌ Falha no teste: " + (data.error || "Erro desconhecido"));
            }
          }
        </script>
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
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Aguardando QR Code - Pastelaria Croc & Cia</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #0F0914; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; text-align: center; }
          .card { background: #1B1224; border: 1px solid #7E22CE; padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); max-width: 440px; width: 100%; }
          .spinner { width: 44px; height: 44px; border: 4px solid rgba(168, 85, 247, 0.2); border-top-color: #A855F7; border-radius: 50%; animation: spin 1s linear infinite; margin: 0 auto 20px auto; }
          @keyframes spin { to { transform: rotate(360deg); } }
          .btn-reset { margin-top: 20px; display: inline-block; padding: 10px 18px; background: rgba(239, 68, 68, 0.15); border: 1px solid #EF4444; color: #FCA5A5; border-radius: 10px; font-weight: 700; text-decoration: none; cursor: pointer; font-size: 0.9rem; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="spinner"></div>
          <h2 style="color: #FFBE1A; margin: 0 0 10px 0;">⏳ Gerando QR Code...</h2>
          <p style="color: #9CA3AF; margin: 0; font-size: 0.95rem;">Inicializando socket do WhatsApp. Esta página atualiza automaticamente a cada 3 segundos.</p>
          <a href="/reset-session" class="btn-reset">⚡ Forçar Reinício do QR Code</a>
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
        <meta http-equiv="refresh" content="12">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Escanear QR Code WhatsApp - Croc & Cia</title>
        <style>
          body { font-family: system-ui, -apple-system, sans-serif; background: #0F0914; color: #FFFFFF; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; text-align: center; }
          .card { background: #1B1224; border: 1px solid #7E22CE; padding: 35px 30px; border-radius: 20px; box-shadow: 0 10px 40px rgba(0,0,0,0.6); max-width: 440px; width: 100%; }
          h2 { color: #FFBE1A; margin: 0 0 10px 0; font-size: 1.4rem; }
          .step-box { background: rgba(0,0,0,0.3); border: 1px solid #374151; padding: 14px; border-radius: 12px; margin: 15px 0; text-align: left; font-size: 0.88rem; color: #D1D5DB; line-height: 1.5; }
          .step-box ol { margin: 0; padding-left: 20px; }
          .step-box li { margin-bottom: 5px; }
          .qr-img { border-radius: 14px; margin: 15px 0; background: white; padding: 12px; box-shadow: 0 4px 20px rgba(0,0,0,0.4); max-width: 240px; width: 100%; height: auto; }
          .btn-group { display: flex; flex-direction: column; gap: 10px; margin-top: 15px; }
          .btn { padding: 10px 18px; border-radius: 10px; font-weight: 700; font-size: 0.9rem; text-decoration: none; cursor: pointer; border: none; }
          .btn-danger { background: rgba(239, 68, 68, 0.15); border: 1px solid #EF4444; color: #FCA5A5; }
        </style>
      </head>
      <body>
        <div class="card">
          <h2>🥟 Conectar WhatsApp Croc &amp; Cia</h2>
          
          <div class="step-box">
            <ol>
              <li>Abra o <strong>WhatsApp</strong> no celular da loja;</li>
              <li>Acesse <strong>Aparelhos conectados</strong> &gt; <strong>Conectar um aparelho</strong>;</li>
              <li>Aponte a câmera para o QR Code abaixo:</li>
            </ol>
          </div>

          <img src="${qrImage}" alt="QR Code Baileys" class="qr-img">
          
          <p style="color: #9CA3AF; font-size: 0.8rem; margin: 5px 0 15px 0;">O QR Code é atualizado a cada 12 segundos.</p>
          
          <div class="btn-group">
            <a href="/reset-session" class="btn btn-danger">🔄 Gerar Novo QR Code</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send("Erro ao renderizar QR Code: " + err.message);
  }
});

// 3. Rota de Envio de Mensagem de Texto (Suporte a JID, LID e Telefone)
app.post("/send-message", checkAuth, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: "WhatsApp não está conectado. Acesse /qr para conectar.",
      hasQrCode: !!currentQrCode
    });
  }

  const rawDest = String(req.body.phone || req.body.number || req.body.jid || req.body.lid || req.body.to || "").trim();
  const message = req.body.message || req.body.text;

  if (!rawDest || !message) {
    return res.status(400).json({
      success: false,
      error: "Campos 'phone'/'jid'/'lid' e 'message' são obrigatórios."
    });
  }

  let targetJid = null;
  const cleanDigits = rawDest.replace(/\D/g, "");

  // 1. Caso o destino seja o próprio estabelecimento (Pastelaria / Loja)
  const isPastelaria = rawDest === "pastelaria" || rawDest === "self" || rawDest === "admin" ||
                       cleanDigits === "5581991896473" || cleanDigits === "558191896473" ||
                       cleanDigits === "81991896473" || cleanDigits === "8191896473";

  if (isPastelaria && sock.user?.id) {
    targetJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
  } else if (rawDest.includes("@lid") || rawDest.includes("@s.whatsapp.net") || rawDest.includes("@g.us")) {
    targetJid = rawDest;
  } else {
    let cleanPhone = cleanDigits;
    if (cleanPhone.length === 10 || cleanPhone.length === 11) {
      cleanPhone = "55" + cleanPhone;
    }

    try {
      if (typeof sock.onWhatsApp === "function") {
        const checkResults = await sock.onWhatsApp(cleanPhone);
        if (checkResults && checkResults.length > 0 && checkResults[0]?.exists) {
          targetJid = checkResults[0].jid;
        } else if (cleanPhone.startsWith("55") && cleanPhone.length === 13) {
          const withoutNine = cleanPhone.slice(0, 4) + cleanPhone.slice(5);
          const checkWithoutNine = await sock.onWhatsApp(withoutNine);
          if (checkWithoutNine && checkWithoutNine.length > 0 && checkWithoutNine[0]?.exists) {
            targetJid = checkWithoutNine[0].jid;
          }
        } else if (cleanPhone.startsWith("55") && cleanPhone.length === 12) {
          const withNine = cleanPhone.slice(0, 4) + "9" + cleanPhone.slice(4);
          const checkWithNine = await sock.onWhatsApp(withNine);
          if (checkWithNine && checkWithNine.length > 0 && checkWithNine[0]?.exists) {
            targetJid = checkWithNine[0].jid;
          }
        }
      }
    } catch (errCheck) {
      console.warn("[Baileys] Erro ao consultar onWhatsApp:", errCheck.message);
    }

    if (!targetJid) {
      targetJid = `${cleanPhone}@s.whatsapp.net`;
    }
  }

  try {
    const result = await sock.sendMessage(targetJid, { text: message });
    console.log(`[Baileys] ✅ Mensagem enviada com sucesso para ${targetJid} (ID: ${result?.key?.id})`);

    // Não alteramos a presença para "unavailable" após o envio.
    // Isso preserva a pilha de push notifications no aparelho físico do cliente e da loja.

    return res.json({
      success: true,
      destination: targetJid,
      phone: cleanDigits,
      messageId: result?.key?.id
    });
  } catch (err) {
    console.error(`[Baileys] ❌ Erro ao enviar para ${targetJid}:`, err);
    return res.status(500).json({
      success: false,
      destination: targetJid,
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

// 6. Rota para Forçar Presença em Segundo Plano (Invisível / Unavailable)
app.get("/set-offline", async (req, res) => {
  if (!sock) {
    return res.status(503).json({ success: false, error: "WhatsApp não está conectado." });
  }
  try {
    await sock.sendPresenceUpdate("unavailable");
    return res.json({
      success: true,
      presence: "unavailable",
      message: "Presença definida como segundo plano com sucesso!"
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 7. Rota de Resgate: Desconectar e Gerar Novo QR Code Automaticamente (Zero-Render)
app.all(["/reset-session", "/force-new-qr", "/disconnect"], async (req, res) => {
  try {
    console.log("[Baileys] 🔄 Comando de RESET DE SESSÃO recebido via HTTP.");
    isConnected = false;
    connectedUser = null;
    currentQrCode = null;

    if (sock) {
      try {
        sock.ev.removeAllListeners("connection.update");
        sock.ev.removeAllListeners("creds.update");
        sock.ev.removeAllListeners("messages.upsert");
        sock.end(undefined);
      } catch (_) {}
      sock = null;
    }

    cleanAuthFolder();
    scheduleReconnect(1000, false);

    if (req.query.format === "json" || req.headers["accept"]?.includes("application/json")) {
      return res.json({
        success: true,
        message: "Sessão resetada com sucesso. Um novo QR Code está sendo gerado!"
      });
    }

    return res.redirect("/qr?reset=1");
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Rota de Resgate: Forçar Reconexão Sem Perder a Sessão Salva
app.all(["/reconnect", "/restart"], async (req, res) => {
  try {
    console.log("[Baileys] ⚡ Comando de RECONEXÃO recebido via HTTP.");
    isConnected = false;
    scheduleReconnect(1000, false);
    if (req.query.format === "json" || req.headers["accept"]?.includes("application/json")) {
      return res.json({
        success: true,
        message: "Reconexão iniciada com sucesso!"
      });
    }
    return res.redirect("/qr?reconnect=1");
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`=======================================================`);
  console.log(`🥟 Servidor Baileys Croc & Cia v2.0 rodando na porta ${PORT}`);
  console.log(`👉 Status: http://localhost:${PORT}/status`);
  console.log(`👉 QR Code: http://localhost:${PORT}/qr`);
  console.log(`👉 Reset QR: http://localhost:${PORT}/reset-session`);
  console.log(`👉 Envio: POST http://localhost:${PORT}/send-message`);
  console.log(`=======================================================`);

  // Keep-Alive anti-hibernação do Render (ping a cada 4 minutos para manter aquecido)
  const PING_TARGET = process.env.RENDER_EXTERNAL_URL || "https://croc-whatsapp.onrender.com";
  setInterval(() => {
    try {
      const https = require("https");
      https.get(`${PING_TARGET}/status`, (r) => {
        // ping ok
      }).on("error", () => {});
    } catch (e) {}
  }, 4 * 60 * 1000);
});
