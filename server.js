process.env.TZ = "America/Recife";
/**
 * PASTELARIA CROC & CIA - SERVIDOR BAILEYS WHATSAPP v2.7
 * Microserviço oficial para automação de confirmação de pedidos, notificações de entrega, status Pix e boas-vindas.
 * 
 * Novidades v2.7:
 * - MENSAGEM AUTOMÁTICA DE BOAS-VINDAS INTELIGENTE (1º CONTATO DO DIA):
 *   Quando um cliente inicia uma conversa no dia, recebe automaticamente uma mensagem de boas-vindas
 *   com o link oficial do cardápio online do site (https://pastelariacrocecia.freedev.app).
 * - FILTROS RIGOROSOS DE SEGURANÇA:
 *   * Desconsidera grupos (@g.us) e participantes de grupos.
 *   * Desconsiderar conversas iniciadas da pastelaria para o cliente (se a loja falou antes, não manda boas-vindas).
 *   * Desconsidera mensagens repetidas do mesmo cliente no mesmo dia (fuso America/Recife).
 *   * Desconsidera status (@broadcast) e newsletters (@newsletter).
 * - PERSISTÊNCIA EM ARQUIVOS JSON ('welcome_config.json' e 'daily_contacts.json'):
 *   Tolerância total a reinicializações e falhas do servidor sem perder o controle dos contatos atendidos.
 * - ROTAS DA API: /welcome-settings (GET/POST), /daily-contacts, /reset-daily-contacts e /test-welcome.
 * 
 * Novidades v2.6:
 * - ROTEAMENTO INTELIGENTE PARA O GRUPO "Pedidos Croc & Cia":
 *   Todo aviso de novo pedido para a pastelaria é enviado automaticamente para o grupo de pedidos.
 * - SOLUÇÃO DEFINITIVA PARA "Aguardando essa mensagem. Isso pode levar alguns instantes" (getMessage + msgRetryCounterCache).
 * - Modo passivo inteligente (markOnlineOnConnect: false) para preservar toques e notificações do celular físico.
 * - Auto-reconexão inteligente com regeneração automática de QR Code em caso de logout / queda.
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
let ghostModeInterval = null;

// Cache do ID do grupo de pedidos para resposta ultra-rápida sem consultar o WhatsApp a cada mensagem
let cachedOrderGroupId = null;
let lastGroupCheck = 0;

// 1. Cache para controle de retentativas de decodificação E2EE do WhatsApp
const msgRetryCounterCache = {
  _cache: new Map(),
  get(key) { return this._cache.get(key); },
  set(key, val) {
    if (this._cache.size > 2000) {
      const first = this._cache.keys().next().value;
      this._cache.delete(first);
    }
    this._cache.set(key, val);
  },
  del(key) { this._cache.delete(key); },
  flushAll() { this._cache.clear(); }
};

// 2. Armazém em memória de mensagens para atender chamadas de retry via 'getMessage'
// É essa função que faz o WhatsApp do celular decifrar a mensagem imediatamente,
// eliminando a mensagem "Aguardando essa mensagem. Isso pode levar alguns instantes"
const messageStore = new Map();
function storeMessage(keyId, messageProto, remoteJid = null) {
  if (!keyId || !messageProto) return;
  if (messageStore.size > 3000) {
    const first = messageStore.keys().next().value;
    messageStore.delete(first);
  }
  messageStore.set(keyId, messageProto);
  if (remoteJid) {
    messageStore.set(`${remoteJid}:${keyId}`, messageProto);
  }
}

// 2.1 Histórico de mensagens trocadas para auditoria (recebidas e enviadas)
const recentExchangedMessages = [];
function recordExchangedMessage(entry) {
  recentExchangedMessages.unshift(entry);
  if (recentExchangedMessages.length > 500) {
    recentExchangedMessages.length = 500;
  }
}

// ==============================================================================
// 2.2 SISTEMA INTELIGENTE DE MENSAGEM DE BOAS-VINDAS (1º CONTATO DO DIA)
// Regras:
// 1. Enviar mensagem de boas-vindas com link do site apenas no 1º contato do dia iniciado pelo cliente.
// 2. Desconsiderar mensagens em grupos (@g.us e participantes).
// 3. Desconsiderar mensagens/conversas iniciadas da pastelaria para o cliente.
// 4. Desconsiderar status/broadcast (@broadcast) e newsletters (@newsletter).
// 5. Desconsiderar mensagens repetidas do mesmo cliente no mesmo dia.
// 6. Persistência em 'daily_contacts.json' e 'welcome_config.json' para tolerância a falhas/restarts.
// ==============================================================================

const WELCOME_CONFIG_FILE = path.join(__dirname, "welcome_config.json");
const DAILY_CONTACTS_FILE = path.join(__dirname, "daily_contacts.json");

const defaultWelcomeConfig = {
  enabled: true,
  siteUrl: "https://pastelariacrocecia.freedev.app",
  message: "Olá! 🥟 Seja muito bem-vindo(a) à *Pastelaria Croc & Cia*! ✨\n\nPara conferir nosso cardápio completo, montar seu pastel quentinho do seu jeito e fazer seu pedido com total agilidade, acesse nosso site oficial:\n👉 https://pastelariacrocecia.freedev.app\n\nSe precisar de qualquer informação ou atendimento da nossa equipe, é só responder por aqui. Estamos à disposição! 💛",
  delayMs: 2000,
  typingSimulation: true
};

let welcomeConfig = { ...defaultWelcomeConfig };

function loadWelcomeConfig() {
  try {
    if (fs.existsSync(WELCOME_CONFIG_FILE)) {
      const raw = fs.readFileSync(WELCOME_CONFIG_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        welcomeConfig = { ...defaultWelcomeConfig, ...parsed };
        console.log("[Baileys] ⚙️ Configurações de boas-vindas carregadas com sucesso.");
        return;
      }
    }
  } catch (e) {
    console.warn("[Baileys] Aviso ao ler welcome_config.json:", e.message);
  }
  welcomeConfig = { ...defaultWelcomeConfig };
  saveWelcomeConfig();
}

function saveWelcomeConfig() {
  try {
    fs.writeFileSync(WELCOME_CONFIG_FILE, JSON.stringify(welcomeConfig, null, 2), "utf-8");
  } catch (e) {
    console.warn("[Baileys] Aviso ao salvar welcome_config.json:", e.message);
  }
}

// Retorna data 'YYYY-MM-DD' estritamente no fuso de Recife (America/Recife, UTC-3)
function getRecifeDateKey() {
  const d = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Recife",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(d);
}

// Retorna chaves equivalentes para o número no Brasil (com e sem nono dígito)
function getContactLookupKeys(jidOrPhone) {
  if (!jidOrPhone) return [];
  const str = String(jidOrPhone);
  if (str.includes("@lid")) return [str];
  const clean = str.replace(/@.*$/, "").replace(/\D/g, "");
  if (!clean) return [];
  const keys = new Set([clean]);
  let with55 = clean;
  if (clean.length === 10 || clean.length === 11) {
    with55 = "55" + clean;
    keys.add(with55);
  }
  if (with55.startsWith("55")) {
    if (with55.length === 12) {
      const ddd = with55.slice(2, 4);
      const rest = with55.slice(4);
      keys.add(`55${ddd}9${rest}`);
    } else if (with55.length === 13 && with55.charAt(4) === "9") {
      const ddd = with55.slice(2, 4);
      const rest = with55.slice(5);
      keys.add(`55${ddd}${rest}`);
    }
  }
  return Array.from(keys);
}

function isPastelariaJid(jid, connUser = null) {
  if (!jid) return false;
  const clean = String(jid).replace(/\D/g, "");
  if (clean === "5581991896473" || clean === "558191896473" || clean === "81991896473" || clean === "8191896473") return true;
  if (connUser && connUser !== "Conectado") {
    const connClean = String(connUser).replace(/\D/g, "");
    if (connClean && clean === connClean) return true;
  }
  return false;
}

// Armazenamento diário de contatos atendidos
let dailyContactsStore = {
  date: getRecifeDateKey(),
  contacts: {}
};

function ensureCurrentDate() {
  const today = getRecifeDateKey();
  if (dailyContactsStore.date !== today) {
    console.log(`[Baileys] 🌅 Novo dia detectado (${today}). Reiniciando mapa de contatos diários.`);
    dailyContactsStore = {
      date: today,
      contacts: {}
    };
    saveDailyContacts();
  }
}

function loadDailyContacts() {
  try {
    if (fs.existsSync(DAILY_CONTACTS_FILE)) {
      const raw = fs.readFileSync(DAILY_CONTACTS_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      const today = getRecifeDateKey();
      if (parsed && parsed.date === today && typeof parsed.contacts === "object") {
        dailyContactsStore = parsed;
        console.log(`[Baileys] 📋 Contatos do dia carregados (${Object.keys(dailyContactsStore.contacts).length} registros em ${today})`);
        return;
      }
    }
  } catch (e) {
    console.warn("[Baileys] Aviso ao carregar daily_contacts.json:", e.message);
  }
  dailyContactsStore = {
    date: getRecifeDateKey(),
    contacts: {}
  };
  saveDailyContacts();
}

function saveDailyContacts() {
  try {
    fs.writeFileSync(DAILY_CONTACTS_FILE, JSON.stringify(dailyContactsStore, null, 2), "utf-8");
  } catch (e) {
    console.warn("[Baileys] Aviso ao salvar daily_contacts.json:", e.message);
  }
}

function getTodayContactRecord(jidOrPhone) {
  ensureCurrentDate();
  const keys = getContactLookupKeys(jidOrPhone);
  for (const k of keys) {
    if (dailyContactsStore.contacts[k]) {
      return { record: dailyContactsStore.contacts[k], primaryKey: k };
    }
  }
  return { record: null, primaryKey: keys[0] || String(jidOrPhone) };
}

// Registra que a pastelaria falou com o cliente (suprimindo boas-vindas se o cliente responder depois)
function registerStoreInitiatedInteraction(targetJidOrPhone, reason = "Mensagem enviada da Pastelaria") {
  if (!targetJidOrPhone) return;
  const targetStr = String(targetJidOrPhone);
  if (targetStr.endsWith("@g.us") || targetStr.includes("@g.us") || targetStr.includes("@broadcast") || targetStr.includes("@newsletter")) {
    return;
  }
  if (isPastelariaJid(targetJidOrPhone, connectedUser)) return;

  const { record, primaryKey } = getTodayContactRecord(targetJidOrPhone);
  if (!record) {
    dailyContactsStore.contacts[primaryKey] = {
      initiatedBy: "store",
      firstTime: new Date().toISOString(),
      welcomeSent: true, // Garante que nunca enviará boas-vindas para este cliente hoje
      suppressedReason: reason
    };
    saveDailyContacts();
    console.log(`[Baileys] 🏢 Conversa com ${primaryKey} iniciada pela Pastelaria. Boas-vindas suprimidas hoje (${reason}).`);
  }
}

// Timers pendentes de boas-vindas para evitar condições de corrida (debouncing)
const pendingWelcomeTimers = new Map();

function cancelPendingWelcome(primaryKey) {
  if (pendingWelcomeTimers.has(primaryKey)) {
    clearTimeout(pendingWelcomeTimers.get(primaryKey));
    pendingWelcomeTimers.delete(primaryKey);
  }
}

function triggerWelcomeDispatch(remoteJid, primaryKey, text) {
  cancelPendingWelcome(primaryKey);
  const delay = Math.max(1000, Number(welcomeConfig.delayMs) || 2000);

  // Simula presença 'digitando...'
  if (sock && isConnected && welcomeConfig.typingSimulation !== false) {
    try {
      sock.sendPresenceUpdate("composing", remoteJid).catch(() => {});
    } catch (_) {}
  }

  const timer = setTimeout(async () => {
    pendingWelcomeTimers.delete(primaryKey);
    if (!sock || !isConnected) {
      console.warn(`[Baileys] ⚠️ WhatsApp não conectado, cancelando boas-vindas para ${primaryKey}.`);
      if (dailyContactsStore.contacts[primaryKey]) {
        dailyContactsStore.contacts[primaryKey].processing = false;
        saveDailyContacts();
      }
      return;
    }

    try {
      console.log(`[Baileys] 🥟 Enviando boas-vindas automáticas para ${remoteJid} (${primaryKey})...`);
      const result = await sock.sendMessage(remoteJid, { text });

      if (dailyContactsStore.contacts[primaryKey]) {
        dailyContactsStore.contacts[primaryKey].welcomeSent = true;
        dailyContactsStore.contacts[primaryKey].welcomeSentAt = new Date().toISOString();
        dailyContactsStore.contacts[primaryKey].messageId = result?.key?.id;
        delete dailyContactsStore.contacts[primaryKey].processing;
        saveDailyContacts();
      }

      recordExchangedMessage({
        id: "WALOG-WELCOME-" + (result?.key?.id || Date.now()),
        timestamp: new Date().toISOString(),
        date_formatted: new Date().toLocaleString("pt-BR", { timeZone: "America/Recife" }),
        target: primaryKey,
        target_type: "CLIENTE",
        direction: "OUTGOING",
        order_number: "BOAS-VINDAS",
        status: "ENVIADO",
        status_reason: "Boas-vindas enviada automaticamente (1º contato do dia iniciado pelo cliente).",
        preview: text.slice(0, 100),
        full_message: text,
        signature_valid: true
      });

      console.log(`[Baileys] ✅ Boas-vindas entregue com sucesso para ${primaryKey}! ID: ${result?.key?.id}`);
    } catch (err) {
      console.error(`[Baileys] ❌ Falha ao enviar boas-vindas para ${primaryKey}:`, err.message);
      if (dailyContactsStore.contacts[primaryKey]) {
        dailyContactsStore.contacts[primaryKey].processing = false;
        dailyContactsStore.contacts[primaryKey].error = err.message;
        saveDailyContacts();
      }
    } finally {
      setTimeout(() => {
        if (sock && isConnected) {
          sock.sendPresenceUpdate("unavailable").catch(() => {});
        }
      }, 1000);
    }
  }, delay);

  pendingWelcomeTimers.set(primaryKey, timer);
}

// Inicializa configurações e contatos persistentes
loadWelcomeConfig();
loadDailyContacts();

// Localiza o JID do grupo "Pedidos Croc & Cia"
async function findOrderGroupJid() {
  const now = Date.now();
  if (cachedOrderGroupId && (now - lastGroupCheck) < 60000) {
    return cachedOrderGroupId;
  }
  if (!sock || !isConnected || typeof sock.groupFetchAllParticipating !== "function") {
    return cachedOrderGroupId;
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    const found = Object.values(groups).find(g => 
      g.subject && /pedidos\s*croc/i.test(g.subject)
    );
    if (found && found.id) {
      cachedOrderGroupId = found.id;
      lastGroupCheck = now;
      console.log(`[Baileys] 📢 Grupo de Pedidos localizado com sucesso: "${found.subject}" (${cachedOrderGroupId})`);
      return cachedOrderGroupId;
    }
  } catch (err) {
    console.warn("[Baileys] Aviso ao consultar grupos:", err.message);
  }
  return cachedOrderGroupId;
}

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

    // Obtém versão mais recente do WhatsApp Web para manter paridade criptográfica total
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
      markOnlineOnConnect: false, // Fundamental para não roubar o status online do celular principal
      syncFullHistory: false,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
      defaultQueryTimeoutMs: 60000,
      msgRetryCounterCache, // Permite rastrear tentativas de decodificação E2EE
      getMessage: async (key) => {
        // Responde às solicitações de retry do WhatsApp quando o celular precisa decodificar a mensagem
        if (!key || !key.id) return undefined;
        let msg = messageStore.get(key.id);
        if (!msg && key.remoteJid) {
          msg = messageStore.get(`${key.remoteJid}:${key.id}`);
        }
        return msg || undefined;
      }
    };

    if (typeof Browsers !== "undefined" && Browsers.appropriate) {
      socketConfig.browser = Browsers.appropriate("Pastelaria Croc & Cia");
    } else {
      socketConfig.browser = ["Pastelaria Croc & Cia", "Chrome", "124.0.0"];
    }

    sock = makeWASocket(socketConfig);

    sock.ev.on("creds.update", saveCreds);

    // Captura mensagens recebidas para alimentar o armazém de retry (getMessage) e processar boas-vindas
    // Sem marcar como lidas para preservar notificações de novas mensagens no celular físico
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (!messages || !Array.isArray(messages)) return;
      const isLiveNotify = (type === "notify");

      for (const m of messages) {
        if (!m?.key || !m?.message) continue;
        const msgId = m.key.id;
        const remoteJid = m.key.remoteJid || "";

        // Sempre armazena a mensagem para resolução imediata de retry E2EE (getMessage)
        if (msgId) {
          storeMessage(msgId, m.message, remoteJid);
        }

        // Caso 1: Mensagem enviada pelo celular da loja / usuário conectado (fromMe: true)
        if (m.key.fromMe) {
          // Se enviou para um cliente individual (não grupo), registra que a loja falou com ele hoje
          if (!remoteJid.endsWith("@g.us") && !remoteJid.includes("@broadcast") && !remoteJid.includes("@newsletter")) {
            registerStoreInitiatedInteraction(remoteJid, "Mensagem enviada diretamente pelo celular da loja");
          }
          continue;
        }

        // Caso 2: Mensagem recebida de terceiros (fromMe: false)
        const rawText = m.message.conversation ||
                        m.message.extendedTextMessage?.text ||
                        m.message.imageMessage?.caption ||
                        m.message.videoMessage?.caption ||
                        m.message.documentMessage?.caption ||
                        (m.message.imageMessage ? "[Foto]" : "") ||
                        (m.message.audioMessage ? "[Áudio]" : "") ||
                        (m.message.stickerMessage ? "[Figurinha]" : "") ||
                        (m.message.locationMessage ? "[Localização]" : "") ||
                        (m.message.contactMessage ? "[Contato]" : "");

        const cleanSender = remoteJid.replace(/@.*$/, "").replace(/\D/g, "");

        if (rawText) {
          recordExchangedMessage({
            id: "WAMSG-" + (msgId || Date.now()),
            timestamp: new Date().toISOString(),
            date_formatted: new Date().toLocaleString("pt-BR", { timeZone: "America/Recife" }),
            target: cleanSender || remoteJid,
            target_type: "RECEBIDA",
            direction: "INCOMING",
            order_number: (rawText.match(/#(\d+)/) || [null, "-"])[1] || "-",
            status: "RECEBIDO",
            status_reason: "Mensagem recebida do cliente no WhatsApp.",
            preview: rawText.slice(0, 100),
            full_message: rawText,
            signature_valid: true
          });
        }

        // ====================================================================
        // AVALIAÇÃO DE DISPARO DA MENSAGEM DE BOAS-VINDAS INTELIGENTE
        // ====================================================================
        // 1. Apenas processa mensagens recebidas em tempo real ('notify'), ignorando histórico ('append')
        if (!isLiveNotify) continue;

        // 2. Desconsiderar mensagens em grupos (@g.us ou participante de grupo)
        if (remoteJid.endsWith("@g.us") || remoteJid.includes("@g.us") || m.key.participant) {
          continue;
        }

        // 3. Desconsiderar status/broadcast e newsletters
        if (remoteJid.includes("@broadcast") || remoteJid.includes("@newsletter")) {
          continue;
        }

        // 4. Desconsiderar a própria pastelaria
        if (isPastelariaJid(remoteJid, connectedUser)) {
          continue;
        }

        // 5. Ignorar se não houver conteúdo legível
        if (!rawText) continue;

        // 6. Verificar se o recurso de boas-vindas está ativado
        if (!welcomeConfig.enabled) continue;

        // 7. Checa se o contato já possui registro de interação no dia (Recife time)
        const { record, primaryKey } = getTodayContactRecord(remoteJid);
        if (record) {
          // Já interagiu hoje (ou a loja falou primeiro, ou já enviou boas-vindas, ou cliente já falou)
          continue;
        }

        // 8. 1º contato do dia INICIADO PELO CLIENTE!
        // Reserva o registro imediatamente para evitar duplicação por mensagens rápidas em sequência
        dailyContactsStore.contacts[primaryKey] = {
          initiatedBy: "customer",
          firstTime: new Date().toISOString(),
          welcomeSent: false,
          processing: true
        };
        saveDailyContacts();

        // Monta o texto garantindo a inclusão do link oficial do site
        let welcomeText = welcomeConfig.message || defaultWelcomeConfig.message;
        if (welcomeConfig.siteUrl) {
          if (welcomeText.includes("{{site_url}}")) {
            welcomeText = welcomeText.replace(/\{\{site_url\}\}/g, welcomeConfig.siteUrl);
          } else if (!welcomeText.includes(welcomeConfig.siteUrl)) {
            welcomeText += `\n\n👉 ${welcomeConfig.siteUrl}`;
          }
        }

        // Dispara o envio com delay humanizado e presença 'digitando...'
        triggerWelcomeDispatch(remoteJid, primaryKey, welcomeText);
      }

      // Reafirma modo segundo plano (Ghost Mode) para o WhatsApp entregar com som e vibração no celular físico
      setTimeout(() => {
        if (sock && isConnected) {
          sock.sendPresenceUpdate("unavailable").catch(() => {});
        }
      }, 1000);
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
        cachedOrderGroupId = null;
        if (ghostModeInterval) {
          clearInterval(ghostModeInterval);
          ghostModeInterval = null;
        }

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
        
        // Define presença em segundo plano de forma passiva (Ghost Mode)
        try {
          sock.sendPresenceUpdate("unavailable").catch(() => {});
        } catch (_) {}

        // Loop permanente para manter o robô 100% em segundo plano (Ghost Mode)
        // Isso impede que os servidores da Meta silenciem as notificações sonoras e vibratórias no celular
        if (ghostModeInterval) clearInterval(ghostModeInterval);
        ghostModeInterval = setInterval(async () => {
          if (sock && isConnected) {
            try {
              await sock.sendPresenceUpdate("unavailable");
            } catch (_) {}
          }
        }, 20000);

        // Busca antecipadamente o grupo de pedidos
        setTimeout(findOrderGroupJid, 2000);
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
    cachedMessages: messageStore.size,
    orderGroupFound: !!cachedOrderGroupId,
    orderGroupId: cachedOrderGroupId,
    uptime: process.uptime(),
    timezone: "America/Recife",
    serverTimeRecife: new Date().toLocaleString("pt-BR", { timeZone: "America/Recife" }),
    timestamp: new Date().toISOString()
  });
});

// 2. Rota para Visualizar o QR Code no Navegador com Controles de Resgate
app.get("/qr", async (req, res) => {
  if (isConnected) {
    const groupInfo = cachedOrderGroupId 
      ? `<div style="background: rgba(34, 197, 94, 0.1); border: 1px solid #22C55E; color: #86EFAC; padding: 10px; border-radius: 8px; font-size: 0.85rem; margin: 10px 0;">🔔 Grupo "Pedidos Croc & Cia" conectado! Alertas tocarão no celular.</div>`
      : `<div style="background: rgba(234, 179, 8, 0.1); border: 1px solid #EAB308; color: #FDE047; padding: 10px; border-radius: 8px; font-size: 0.85rem; margin: 10px 0;">⏳ Aguardando localização do grupo "Pedidos Croc & Cia"...</div>`;

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
          .user-box { background: rgba(0,0,0,0.3); border: 1px solid #374151; padding: 12px; border-radius: 10px; font-family: monospace; font-size: 1rem; color: #F3F4F6; margin: 15px 0 15px 0; word-break: break-all; }
          .btn-group { display: flex; flex-direction: column; gap: 12px; margin-top: 15px; }
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
          <p style="color: #9CA3AF; margin: 0 0 10px 0; font-size: 0.95rem;">O microserviço Baileys está ativo com decodificação instantânea de chaves e roteamento para o grupo de pedidos.</p>
          
          <div class="user-box">
            ${connectedUser}
          </div>

          ${groupInfo}

          <div class="btn-group">
            <button class="btn btn-primary" onclick="testSend()">
              💬 Enviar Mensagem de Teste no Grupo
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
            const res = await fetch("/send-message", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                phone: "pastelaria",
                message: "🥟 Teste de envio no grupo Pedidos Croc & Cia! Conexão ativa, notificações e toques liberados no celular."
              })
            });
            const data = await res.json();
            if (data.success) {
              alert("✅ Mensagem de teste enviada com sucesso! Destino: " + data.destination);
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

// Armazém anti-duplicação de mensagens enviadas (janela atômica de 30 segundos)
const recentSentCache = new Map();
function checkDuplicateOutgoing(targetJid, text, orderNum) {
  const now = Date.now();
  for (const [k, v] of recentSentCache.entries()) {
    if (now - v.time > 60000) recentSentCache.delete(k);
  }
  const match = text.match(/#(\d+)/);
  const orderKey = orderNum ? String(orderNum).replace(/\D/g, "") : (match ? match[1] : null);
  const snippet = text.slice(0, 100).trim();
  const key = orderKey ? `${targetJid}:order_${orderKey}` : `${targetJid}:snip_${snippet}`;
  if (recentSentCache.has(key)) {
    const prev = recentSentCache.get(key);
    if (now - prev.time < 30000) {
      return prev;
    }
  }
  return null;
}
function recordSentMessage(targetJid, text, orderNum, messageId) {
  const match = text.match(/#(\d+)/);
  const orderKey = orderNum ? String(orderNum).replace(/\D/g, "") : (match ? match[1] : null);
  const snippet = text.slice(0, 100).trim();
  const key = orderKey ? `${targetJid}:order_${orderKey}` : `${targetJid}:snip_${snippet}`;
  recentSentCache.set(key, { time: Date.now(), messageId });
}

// 3. Rota de Envio de Mensagem de Texto (Suporte a JID, Grupos, LID e Telefone)
app.post("/send-message", checkAuth, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: "WhatsApp não está conectado. Acesse /qr para conectar.",
      hasQrCode: !!currentQrCode
    });
  }

  const rawDest = String(
    req.body.phone || 
    req.body.number || 
    req.body.jid || 
    (req.body.lid && String(req.body.lid).includes("@lid") ? req.body.lid : "") || 
    req.body.to || 
    ""
  ).trim();
  const rawMsg = req.body.message || req.body.text || "";
  const message = String(rawMsg).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();

  if (!rawDest || !message) {
    return res.status(400).json({
      success: false,
      error: "Campos 'phone'/'jid'/'lid' e 'message' são obrigatórios."
    });
  }

  let targetJid = null;
  const cleanDigits = rawDest.replace(/\D/g, "");

  // 1. Caso o destino seja o próprio estabelecimento (Pastelaria / Loja) ou o Grupo de Pedidos
  const isPastelaria = rawDest === "pastelaria" || rawDest === "self" || rawDest === "admin" ||
                       rawDest === "pedidos" || rawDest === "grupo" ||
                       cleanDigits === "5581991896473" || cleanDigits === "558191896473" ||
                       cleanDigits === "81991896473" || cleanDigits === "8191896473";

  if (isPastelaria) {
    // Tenta primeiro direcionar para o Grupo "Pedidos Croc & Cia" para que o celular toque alto com notificação
    const groupJid = await findOrderGroupJid();
    if (groupJid) {
      targetJid = groupJid;
      console.log(`[Baileys] 📢 Alerta de pedido roteado para o Grupo: ${targetJid}`);
    } else if (sock.user?.id) {
      targetJid = sock.user.id.split(":")[0] + "@s.whatsapp.net";
      console.log(`[Baileys] ⚠️ Grupo de pedidos não localizado, enviando para self-chat: ${targetJid}`);
    }
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

  // Verificação anti-duplicidade em memória (janela de 30s)
  const dupCheck = checkDuplicateOutgoing(targetJid, message, req.body.orderNumber);
  if (dupCheck) {
    console.log(`[Baileys] 🛡️ Mensagem duplicada prevenida para ${targetJid} (ID anterior: ${dupCheck.messageId})`);
    return res.json({
      success: true,
      duplicatePrevented: true,
      destination: targetJid,
      phone: cleanDigits,
      messageId: dupCheck.messageId
    });
  }

  try {
    let msgOptions = { text: message };
    const rawImage = req.body.image || req.body.imageUrl || req.body.bannerUrl;
    if (rawImage && typeof rawImage === "string" && (rawImage.startsWith("http://") || rawImage.startsWith("https://"))) {
      msgOptions = {
        image: { url: rawImage },
        caption: message
      };
    }
    const result = await sock.sendMessage(targetJid, msgOptions);
    console.log(`[Baileys] ✅ Mensagem enviada com sucesso para ${targetJid} (ID: ${result?.key?.id})`);

    // Registra no cache anti-duplicidade
    recordSentMessage(targetJid, message, req.body.orderNumber, result?.key?.id);

    // Registra no histórico de mensagens trocadas para auditoria
    recordExchangedMessage({
      id: "WALOG-" + (result?.key?.id || Date.now()),
      timestamp: new Date().toISOString(),
      date_formatted: new Date().toLocaleString("pt-BR", { timeZone: "America/Recife" }),
      target: cleanDigits || targetJid,
      target_type: isPastelaria ? "LOJA" : "CLIENTE",
      direction: "OUTGOING",
      order_number: req.body.orderNumber ? String(req.body.orderNumber) : ((message.match(/#(\d+)/) || [null, "-"])[1] || "-"),
      status: "ENVIADO",
      status_reason: "Enviado com sucesso via API Baileys/Render.",
      preview: message.slice(0, 100),
      full_message: message,
      signature_valid: true
    });

    // Registra que a Pastelaria iniciou contato com este cliente hoje (suprimindo boas-vindas caso o cliente responda)
    if (!isPastelaria && targetJid && !targetJid.endsWith("@g.us")) {
      registerStoreInitiatedInteraction(targetJid || cleanDigits, "Mensagem enviada via API/Painel da Pastelaria");
      const { primaryKey } = getTodayContactRecord(targetJid || cleanDigits);
      cancelPendingWelcome(primaryKey);
    }

    // Armazena a mensagem enviada no cache de retry para que o celular e o WhatsApp
    // consigam resolver a chave criptográfica E2EE instantaneamente sem travar em 'Aguardando essa mensagem'
    if (result?.key?.id && result?.message) {
      storeMessage(result.key.id, result.message, targetJid);
    }

    // Reafirma presença invisível em segundo plano após envio
    setTimeout(() => {
      if (sock && isConnected) {
        sock.sendPresenceUpdate("unavailable").catch(() => {});
      }
    }, 800);

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

// 3.1 Rota de Consulta de Mensagens Trocadas (Auditoria / Retaguarda)
app.get("/recent-messages", (req, res) => {
  res.json({
    success: true,
    count: recentExchangedMessages.length,
    messages: recentExchangedMessages
  });
});

// 3.2 Rota de Consulta de Configuração de Boas-Vindas
app.get("/welcome-settings", (req, res) => {
  ensureCurrentDate();
  const contacts = Object.values(dailyContactsStore.contacts || {});
  const welcomeSentCount = contacts.filter(c => c.welcomeSent && c.initiatedBy === "customer").length;
  const storeInitiatedCount = contacts.filter(c => c.initiatedBy === "store").length;
  res.json({
    success: true,
    config: welcomeConfig,
    today: dailyContactsStore.date,
    stats: {
      totalContactsToday: contacts.length,
      welcomeSentToday: welcomeSentCount,
      storeInitiatedToday: storeInitiatedCount
    }
  });
});

// 3.3 Rota para Salvar Configuração de Boas-Vindas
app.post("/welcome-settings", checkAuth, (req, res) => {
  if (req.body.enabled !== undefined) {
    welcomeConfig.enabled = Boolean(req.body.enabled);
  }
  if (req.body.siteUrl && typeof req.body.siteUrl === "string") {
    welcomeConfig.siteUrl = req.body.siteUrl.trim();
  }
  if (req.body.message && typeof req.body.message === "string") {
    welcomeConfig.message = req.body.message.trim();
  }
  if (req.body.delayMs !== undefined) {
    welcomeConfig.delayMs = Math.max(500, Number(req.body.delayMs) || 2000);
  }
  if (req.body.typingSimulation !== undefined) {
    welcomeConfig.typingSimulation = Boolean(req.body.typingSimulation);
  }
  saveWelcomeConfig();
  console.log("[Baileys] ⚙️ Configurações de boas-vindas atualizadas com sucesso via API.");
  return res.json({
    success: true,
    message: "Configurações de boas-vindas salvas com sucesso!",
    config: welcomeConfig
  });
});

// 3.4 Rota de Auditoria de Contatos do Dia
app.get("/daily-contacts", checkAuth, (req, res) => {
  ensureCurrentDate();
  res.json({
    success: true,
    date: dailyContactsStore.date,
    total: Object.keys(dailyContactsStore.contacts || {}).length,
    contacts: dailyContactsStore.contacts
  });
});

// 3.5 Rota para Limpar/Resetar Contatos do Dia (Testes)
app.post("/reset-daily-contacts", checkAuth, (req, res) => {
  dailyContactsStore = {
    date: getRecifeDateKey(),
    contacts: {}
  };
  saveDailyContacts();
  console.log("[Baileys] 🔄 Contatos do dia resetados manualmente.");
  res.json({
    success: true,
    message: "Contatos diários resetados com sucesso!",
    date: dailyContactsStore.date
  });
});

// 3.6 Rota para Testar Envio de Boas-Vindas para um Telefone Específico
app.post("/test-welcome", checkAuth, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: "WhatsApp não está conectado." });
  }
  const rawDest = String(req.body.phone || req.body.number || req.body.to || "").trim();
  if (!rawDest) {
    return res.status(400).json({ success: false, error: "Telefone não informado." });
  }
  let cleanPhone = rawDest.replace(/\D/g, "");
  if (cleanPhone.length === 10 || cleanPhone.length === 11) cleanPhone = "55" + cleanPhone;
  const targetJid = `${cleanPhone}@s.whatsapp.net`;

  let welcomeText = req.body.message || welcomeConfig.message || defaultWelcomeConfig.message;
  const siteUrl = req.body.siteUrl || welcomeConfig.siteUrl;
  if (siteUrl) {
    if (welcomeText.includes("{{site_url}}")) {
      welcomeText = welcomeText.replace(/\{\{site_url\}\}/g, siteUrl);
    } else if (!welcomeText.includes(siteUrl)) {
      welcomeText += `\n\n👉 ${siteUrl}`;
    }
  }

  try {
    const result = await sock.sendMessage(targetJid, { text: welcomeText });
    return res.json({
      success: true,
      message: "Mensagem de teste de boas-vindas enviada com sucesso!",
      destination: targetJid,
      messageId: result?.key?.id,
      preview: welcomeText.slice(0, 100)
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Rota para Listar Grupos Participantes (Diagnóstico)
app.get("/groups", checkAuth, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: "WhatsApp não está conectado." });
  }
  try {
    const groups = await sock.groupFetchAllParticipating();
    const list = Object.values(groups).map(g => ({
      id: g.id,
      name: g.subject,
      participantsCount: g.participants?.length || 0
    }));
    return res.json({
      success: true,
      count: list.length,
      orderGroupJid: cachedOrderGroupId,
      groups: list
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. Rota Proxy para Testar Conexão com Mercado Pago (Zero CORS)
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

// 6. Rota Proxy para Criar Pix Oficial no Mercado Pago (Zero CORS)
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

// 7. Rota para Forçar Presença em Segundo Plano (Invisível / Unavailable)
app.all(["/set-offline", "/hide", "/invisible"], async (req, res) => {
  if (!sock) {
    return res.status(503).json({ success: false, error: "WhatsApp não está conectado." });
  }
  try {
    await sock.sendPresenceUpdate("unavailable").catch(() => {});
    return res.json({
      success: true,
      presence: "unavailable",
      message: "Presença definida como segundo plano (unavailable) com sucesso!"
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 8. Rota de Resgate: Desconectar e Gerar Novo QR Code Automaticamente (Zero-Render)
app.all(["/reset-session", "/force-new-qr", "/disconnect"], async (req, res) => {
  try {
    console.log("[Baileys] 🔄 Comando de RESET DE SESSÃO recebido via HTTP.");
    isConnected = false;
    connectedUser = null;
    currentQrCode = null;
    cachedOrderGroupId = null;

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

// 9. Rota de Resgate: Forçar Reconexão Sem Perder a Sessão Salva
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
  console.log(`🥟 Servidor Baileys Croc & Cia v2.6 rodando na porta ${PORT}`);
  console.log(`👉 Status: http://localhost:${PORT}/status`);
  console.log(`👉 QR Code: http://localhost:${PORT}/qr`);
  console.log(`👉 Grupos: http://localhost:${PORT}/groups`);
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
