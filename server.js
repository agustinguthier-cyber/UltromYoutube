#!/usr/bin/env node
/**
 * Servidor local ligero (sin dependencias externas) para UltromYoutube.
 *
 * - Sirve los archivos estaticos del proyecto (ultrom-estudio.html, channels_data.json,
 *   logos, etc.) en http://localhost:3000, para evitar los problemas de CORS/fetch
 *   que aparecen al abrir el HTML directo con file://.
 * - Expone POST /api/generate-script como proxy hacia un proveedor de LLM compatible
 *   con la API de OpenAI (/v1/chat/completions), para no exponer la API key en el
 *   navegador.
 * - Expone /api/generate-audio/{start,status,result} (async, con polling) como proxy hacia
 *   un proveedor de TTS (texto a voz): Voicebox local, Fish Audio por API key, NVIDIA NIM,
 *   o un endpoint local/custom propio. También queda POST /api/generate-audio (sincronico)
 *   como variante simple para integraciones externas.
 * - Expone /api/generate-scene-media/{start,status}: por cada escena intenta primero un
 *   B-roll de VIDEO real con Wan2GP (si WAN2GP_ROOT esta configurado en ultron/.env) y,
 *   si no esta disponible o falla, cae a una imagen IA (Pollinations.ai por defecto, sin
 *   API key, con un reintento automático si el primer intento falla). Reusa tal cual
 *   ultron/scripts/lib/generateBrolls.js y generateImageWithRetry() de selectBackground.js
 *   (el mismo codigo que ya usa el pipeline CLI standalone de ultron) en vez de duplicarlos.
 *   Guarda el resultado en public/assets/scenes/ y devuelve su URL relativa + el tipo de
 *   medio (video o imagen) que salio para esa escena.
 * - Expone /api/scenes/upload y /api/audio/upload (subida directa de bytes, sin
 *   multipart/dependencias) para que el navegador suba a disco los medios de escena
 *   subidos a mano y el audio (narracion/musica/sfx) antes de renderizar, y
 *   /api/render-video/{start,status} que arma el video final 100% en el servidor via
 *   FFmpeg nativo (ver render.js): sin MediaRecorder, sin ffmpeg.wasm en el navegador.
 *
 * Uso:
 *   copiar .env.example a .env y completar LLM_API_KEY (y LLM_PROVIDER si hace falta)
 *   y, para locucion, tener Voicebox abierto (o completar TTS_API_KEY si usas otro proveedor)
 *   y, para medios de escena, no hace falta nada por defecto (cae a Pollinations, gratis
 *   y sin key) -- opcionalmente completar WAN2GP_ROOT en ultron/.env para B-roll de video
 *   real con Wan2GP (ver ultron/README.md, seccion Wan2GP -- no verificado end-to-end)
 *   y, para renderizar video, tener ffmpeg instalado y en el PATH (o FFMPEG_PATH en .env)
 *   node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ROOT = __dirname;

/* loadDotEnv() tiene que correr ANTES de requerir render.js/generateBrolls.js/generateImage.js:
   esos modulos leen algunas de sus env vars (FFMPEG_PATH, WAN2GP_TIMEOUT_S) en constantes de
   nivel de modulo, evaluadas una sola vez al hacer require() -- si el .env todavia no se cargo
   en ese momento, quedan pegadas al default para siempre en esta corrida del proceso. */
loadDotEnv();

const render = require('./render.js');
const remotionRender = require('./remotionRender.js');
const { generateBroll, isWan2GpConfigured } = require('./ultron/scripts/lib/generateBrolls.js');
const { generateImageWithRetry } = require('./ultron/scripts/lib/selectBackground.js');

const PORT = Number(process.env.PORT) || 3000;

/* Timeout por defecto para llamadas salientes a proveedores externos (TTS
   sincronicos). Sin esto, un proveedor que se cuelga (no responde error, no responde nada)
   deja la request colgada para siempre y sin feedback — confirmado con NVIDIA NIM: una
   funcion "degraded" a veces falla rapido con 400, pero otras veces directamente no
   responde. Voicebox no usa esto: tiene su propio mecanismo de deadline en el polling SSE.
   El LLM de texto (guion/prompts) usa su propio timeout, mas corto — ver LLM_TIMEOUT_MS. */
const EXTERNAL_FETCH_TIMEOUT_MS = 90000;

/* Red de seguridad a nivel proceso: cada ruta ya atrapa sus propios errores async (ver
   server.listen mas abajo, todos los handlers van con .catch()), pero si algo se escapa
   igual (una excepcion sincronica fuera de esos try/catch, una promesa suelta sin await)
   Node por defecto mata el proceso entero — y eso es lo que se ve del lado del navegador
   como "NetworkError when attempting to fetch resource" en la siguiente request, porque
   ya no hay nada escuchando en el puerto. Loguear y seguir vivo es mejor que caerse. */
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException (el servidor sigue corriendo):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('[fatal] unhandledRejection (el servidor sigue corriendo):', err);
});

/* ================= configuracion del proveedor LLM ================= */
/* Cualquier proveedor que hable el esquema OpenAI de /v1/chat/completions sirve aca.
   LLM_PROVIDER solo elige los valores por defecto de baseUrl/model; siempre se pueden
   pisar con LLM_BASE_URL / LLM_MODEL en el .env. */
const LLM_PROVIDER = (process.env.LLM_PROVIDER || 'nvidia').toLowerCase();
const LLM_PROVIDER_DEFAULTS = {
  // NVIDIA NIM (build.nvidia.com) - API keys gratis con credito de prueba.
  // Nota: meta/llama-3.1-8b-instruct quedo DEGRADED del lado de NVIDIA (a veces falla rapido
  // con 400, a veces directamente cuelga la conexion sin responder) — confirmado probando
  // varios modelos a mano. meta/llama-3.1-70b-instruct respondio bien en esa misma prueba,
  // pero seguia siendo lento/inconsistente en uso real (fetches colgados cerca del timeout).
  // meta/llama-3.3-70b-instruct es un modelo mas nuevo en el mismo catalogo NIM, con mejor
  // latencia/disponibilidad reportada. Si NVIDIA lo vuelve a marcar como degradado, pisa
  // esto con LLM_MODEL en el .env (otra opcion del catalogo: mistralai/mistral-large-2-instruct).
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    model: 'meta/llama-3.3-70b-instruct'
  },
  // FreeLLMAPI: cada cuenta/proyecto tiene su propia URL base, no hay una unica
  // publica confiable para poner por defecto aca. Completar LLM_BASE_URL en el .env.
  freellmapi: {
    baseUrl: '',
    model: ''
  },
  custom: {
    baseUrl: '',
    model: ''
  }
};
const providerDefaults = LLM_PROVIDER_DEFAULTS[LLM_PROVIDER] || LLM_PROVIDER_DEFAULTS.custom;
const LLM_BASE_URL = process.env.LLM_BASE_URL || providerDefaults.baseUrl;
const LLM_MODEL = process.env.LLM_MODEL || providerDefaults.model;
const LLM_API_KEY = process.env.LLM_API_KEY || '';

/* Timeout por intento para el LLM de texto (guion, prompts, SEO, etc.), bastante mas corto
   que el resto de las llamadas externas (EXTERNAL_FETCH_TIMEOUT_MS=90s) para no dejar al
   usuario esperando casi dos minutos antes de enterarse de que el proveedor esta colgado.
   callChatCompletions() reintenta el proveedor primario una vez, y si hay un fallback
   configurado lo prueba en el medio — ver mas abajo. */
const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS) || 18000;

/* ================= proveedor LLM de fallback (opcional) ================= */
/* Si el primario (NVIDIA NIM u otro) no responde dentro de LLM_TIMEOUT_MS, se prueba este
   segundo proveedor antes de reintentar el primario una vez mas. Pensado para un proveedor
   "ultra rapido" como Groq (LPU, latencias tipicamente <2s) o un endpoint local/self-hosted.
   Sin LLM_FALLBACK_API_KEY configurada, el fallback queda deshabilitado (no hay endpoint
   publico de Groq sin key, asi que no tiene sentido poner una URL por defecto sin key). */
const LLM_FALLBACK_PROVIDER = (process.env.LLM_FALLBACK_PROVIDER || ((process.env.LLM_FALLBACK_API_KEY || process.env.GROQ_API_KEY) ? 'groq' : '')).toLowerCase();
const LLM_FALLBACK_PROVIDER_DEFAULTS = {
  // Groq (https://groq.com) - inferencia sobre LPU propio, no GPU: latencias sub-segundo
  // tipicas incluso en modelos de 70B. API compatible con el esquema OpenAI.
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'llama-3.3-70b-versatile'
  },
  custom: { baseUrl: '', model: '' }
};
const fallbackDefaults = LLM_FALLBACK_PROVIDER_DEFAULTS[LLM_FALLBACK_PROVIDER] || LLM_FALLBACK_PROVIDER_DEFAULTS.custom;
const LLM_FALLBACK_BASE_URL = process.env.LLM_FALLBACK_BASE_URL || fallbackDefaults.baseUrl;
const LLM_FALLBACK_MODEL = process.env.LLM_FALLBACK_MODEL || fallbackDefaults.model;
// GROQ_API_KEY es un alias de conveniencia (nombre convencional en varias herramientas) --
// LLM_FALLBACK_API_KEY gana si estan las dos.
const LLM_FALLBACK_API_KEY = process.env.LLM_FALLBACK_API_KEY || process.env.GROQ_API_KEY || '';
const LLM_FALLBACK_ENABLED = Boolean(LLM_FALLBACK_API_KEY && LLM_FALLBACK_BASE_URL);

/* ================= NexLev (paso 3, boton "Idea Tendencia") =================
   API REST de NexLev (https://nexlev.io), no su servidor MCP -- ese esta pensado para que un
   humano conecte Claude/ChatGPT a su cuenta via OAuth desde el navegador (Settings ->
   Connectors), no para que un backend dispare una llamada automatica al hacer click en un
   boton. La API REST clasica (x-api-key) encaja con el resto de proveedores externos de este
   proyecto (mismo patron fetch + timeout que NVIDIA/Pollinations). Key en
   dashboard.nexlev.io/n8n-youtube.
   Contrato verificado leyendo el codigo fuente de su integracion oficial de n8n
   (github.com/alge-soft/n8n-nodes-nexlev), no un doc publico formal -- confirma baseURL,
   header x-api-key y el endpoint /external/similar-videos/get-similar, pero NO el shape
   exacto de la respuesta (no hay JSON de ejemplo documentado). Por eso
   handleNexlevTrendIdea() no intenta parsear un schema fijo: le pasa la respuesta cruda tal
   cual al LLM y deja que la sintetice, mismo enfoque best-effort que el resto de proveedores
   sin contrato documentado en este proyecto (SkyReels, Wan2GP). */
const NEXLEV_API_KEY = process.env.NEXLEV_API_KEY || '';
const NEXLEV_BASE_URL = 'https://prod.dashboard.nexlev.io/api';
const NEXLEV_TIMEOUT_MS = Number(process.env.NEXLEV_TIMEOUT_MS) || 45000;

/* ================= yt-dlp (paso 3, boton "Idea Tendencia" -- version gratis) =================
   Alternativa 100% gratis a NexLev para el mismo botón: en vez de pagar el plan Pro de NexLev,
   busca directo en YouTube (sin API key, sin login) con `yt-dlp "ytsearchN:<query>"` y le pasa
   los resultados reales al mismo synthesizeTrendIdea() de arriba.
   Nace de investigar "Agent Reach" (github.com/Panniantong/Agent-Reach), que el usuario pidió
   integrar para esto -- pero leyendo su propio código (agent_reach/channels/youtube.py) y su
   CLAUDE.md ("Positioning: installer + doctor + config tool. NOT a wrapper -- after install,
   agents call upstream tools directly") queda claro que Agent Reach no expone una función de
   búsqueda invocable: es una capa que instala/diagnostica herramientas (yt-dlp entre ellas)
   para que un agente en una sesión interactiva las llame el mismo por shell. No hay nada ahí
   para que un backend fijo llame directo. Lo que sí sirve, y es exactamente lo mismo que Agent
   Reach habría terminado usando para YouTube, es yt-dlp -- así que se usa directo, sin la capa
   intermedia. Verificado en vivo (2026-08-24): búsqueda real, sin key, devolvió resultados con
   título/canal/vistas reales para una query de prueba. */
const YTDLP_PYTHON = process.env.YTDLP_PYTHON || 'python';
const YTDLP_SEARCH_COUNT = Number(process.env.YTDLP_SEARCH_COUNT) || 8;
const YTDLP_TIMEOUT_MS = Number(process.env.YTDLP_TIMEOUT_MS) || 30000;

/* ================= Telegram (paso 10, boton "Publicar en Telegram") =================
   Bot API oficial (api.telegram.org) -- el archivo se sube como bytes reales via
   multipart/form-data (FormData/Blob nativos de Node, sin dependencias), no como URL: el
   servidor corre en localhost, Telegram no podria descargar el video de ahi.
   TELEGRAM_BOT_TOKEN: creado con @BotFather en Telegram (comando /newbot).
   TELEGRAM_CHAT_ID: a donde llegan los archivos -- puede ser el id numerico de un chat
   privado con el propio bot (el usuario le escribio primero, los bots no pueden iniciar
   conversacion), o el id/@usuario de un canal o grupo donde el bot sea administrador. */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';
const TELEGRAM_TIMEOUT_MS = Number(process.env.TELEGRAM_TIMEOUT_MS) || 120000;

async function telegramApiCall(method, fields){
  const form = new FormData();
  for(const [key, value] of Object.entries(fields)){
    if(value === undefined || value === null) continue;
    form.append(key, value);
  }
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  if(!res.ok || !data.ok) throw new Error(data.description || `HTTP ${res.status}`);
  return data.result;
}

/* ================= configuracion del proveedor TTS (locucion) ================= */
/* TTS_PROVIDER solo elige los valores por defecto de baseUrl/model; siempre se pueden
   pisar con TTS_BASE_URL / TTS_MODEL en el .env. "voicebox" y "local" no necesitan
   TTS_API_KEY (corren en la maquina del usuario). */
const TTS_PROVIDER = (process.env.TTS_PROVIDER || 'voicebox').toLowerCase();
const TTS_PROVIDER_DEFAULTS = {
  // Voicebox (https://voicebox.sh) - app local de voz, sin key. Backend FastAPI propio.
  voicebox: { baseUrl: 'http://127.0.0.1:17493', model: '' },
  // Fish Audio (https://fish.audio) - TTS por API key.
  fishaudio: { baseUrl: 'https://api.fish.audio/v1', model: '' },
  // NVIDIA NIM (integrate.api.nvidia.com) - misma cuenta/key que LLM_API_KEY. El servicio
  // alojado de NIM para este modelo se sirve por gRPC (no REST), asi que este cliente
  // solo funciona si NVIDIA expone una pasarela REST equivalente — dejar como referencia.
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'resembleai/chatterbox-multilingual-tts' },
  // Endpoint local o self-hosted generico, sin key por defecto.
  local: { baseUrl: '', model: '' },
  custom: { baseUrl: '', model: '' }
};
const ttsProviderDefaults = TTS_PROVIDER_DEFAULTS[TTS_PROVIDER] || TTS_PROVIDER_DEFAULTS.custom;
const TTS_BASE_URL = process.env.TTS_BASE_URL || ttsProviderDefaults.baseUrl;
const TTS_MODEL = process.env.TTS_MODEL || ttsProviderDefaults.model;
// Si es NVIDIA y no se seteo una TTS_API_KEY propia, reusa LLM_API_KEY (misma cuenta NVIDIA NIM).
const TTS_API_KEY = process.env.TTS_API_KEY || (TTS_PROVIDER === 'nvidia' ? LLM_API_KEY : '');
const TTS_VOICE_ID = process.env.TTS_VOICE_ID || '';
const TTS_FORMAT = process.env.TTS_FORMAT || 'mp3';

const SCENES_DIR = path.join(ROOT, 'public', 'assets', 'scenes');
const AUDIO_DIR = path.join(ROOT, 'public', 'assets', 'audio');
fs.mkdirSync(SCENES_DIR, { recursive: true });
fs.mkdirSync(AUDIO_DIR, { recursive: true });

/* ================= aislamiento por sesion (multi-usuario) =================
   Con un solo servidor compartido por varias personas al mismo tiempo, los nombres de
   archivo fijos de antes (scene_000.jpg, narration.mp3) hacian que dos proyectos generando
   en simultaneo se pisaran entre si sin ningun aviso. Cada escena/audio ahora vive bajo una
   subcarpeta con el sessionId que manda el navegador (generado una vez por pestaña, ver
   ultrom-estudio.html), asi que dos personas nunca comparten los mismos archivos en disco.
   Los jobs de generacion (AUDIO_JOBS/MEDIA_JOBS/RENDER_JOBS) ya eran seguros para esto -- se
   identifican por un UUID random propio, no por nombre fijo -- asi que no hace falta tocarlos. */
const DEFAULT_SESSION_ID = 'default'; // fallback para integraciones externas que no manden session
function sanitizeSessionId(raw){
  const id = (raw || '').toString().trim();
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : DEFAULT_SESSION_ID;
}
function sessionScenesDir(sessionId){
  const dir = path.join(SCENES_DIR, sanitizeSessionId(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function sessionAudioDir(sessionId){
  const dir = path.join(AUDIO_DIR, sanitizeSessionId(sessionId));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/* ================= .env casero (sin dependencias) ================= */
/* Carga el .env del proyecto y, ademas, ultron/.env: ahi viven WAN2GP_ROOT/IMAGE_PROVIDER
   y el resto de la config de medios de escena (documentada en ultron/README.md y usada
   tambien por el pipeline CLI standalone de ultron) -- se carga aca tambien para no
   duplicar esas variables en dos .env distintos. Mismo criterio "no pisa lo ya seteado"
   que el resto de esta funcion, asi que el .env raiz siempre gana si hay conflicto. */
function loadDotEnv(){
  loadDotEnvFile(path.join(ROOT, '.env'));
  loadDotEnvFile(path.join(ROOT, 'ultron', '.env'));
}
function loadDotEnvFile(envPath){
  if(!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for(const line of lines){
    const trimmed = line.trim();
    if(!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if(eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))){
      value = value.slice(1, -1);
    }
    if(!(key in process.env)) process.env[key] = value;
  }
}

/* ================= archivos estaticos ================= */
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res){
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if(urlPath === '/') urlPath = '/ultrom-estudio.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if(!filePath.startsWith(ROOT)){
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if(err){
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + urlPath);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ================= helpers de API ================= */
function readJsonBody(req){
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if(raw.length > 2_000_000){
        reject(new Error('Body demasiado grande.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if(!raw){ resolve({}); return; }
      try{ resolve(JSON.parse(raw)); }
      catch(e){ reject(new Error('JSON invalido: ' + e.message)); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj){
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

/* Junta el body crudo (bytes) de una request, sin parsear — usado por los endpoints de
   subida de archivos. Nada de multipart/form-data: el cliente manda un archivo por
   request como el body entero, con el tipo/indice en la query string. Mas simple que
   parsear multipart a mano y evita sumar una dependencia solo para esto. */
function readRawBody(req, maxBytes = 200_000_000){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if(total > maxBytes){ reject(new Error('Archivo demasiado grande.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* Extension de archivo a partir del Content-Type de la subida — cubre imagen/video/audio. */
function extFromUploadContentType(ct){
  ct = (ct || '').toLowerCase();
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
    'audio/wave': '.wav', 'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/ogg': '.ogg', 'audio/webm': '.weba'
  };
  return map[ct] || null;
}

/* Borra cualquier archivo existente "<baseName>.*" en dir antes de escribir uno nuevo,
   para que no queden versiones viejas con otra extension huerfanas (ej. si una escena
   se resube en un formato distinto). */
function removeExistingWithBase(dir, baseName){
  let entries;
  try{ entries = fs.readdirSync(dir); }catch(e){ return; }
  const prefix = baseName + '.';
  for(const f of entries){
    if(f.startsWith(prefix)){
      try{ fs.unlinkSync(path.join(dir, f)); }catch(e){ /* best effort */ }
    }
  }
}

/* Busca "<baseName>.*" en dir y devuelve {path, ext, mediaType} o null si no existe. */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov']);
function findFileByBase(dir, baseName){
  let entries;
  try{ entries = fs.readdirSync(dir); }catch(e){ return null; }
  const prefix = baseName + '.';
  const match = entries.find(f => f.startsWith(prefix));
  if(!match) return null;
  const ext = path.extname(match).toLowerCase();
  const mediaType = IMAGE_EXTS.has(ext) ? 'image' : (VIDEO_EXTS.has(ext) ? 'video' : null);
  return { path: path.join(dir, match), ext, mediaType };
}

/* ================= POST /api/generate-script ================= */
/* Ruta unica para todas las llamadas a IA de la app (guion, prompts de imagen/animacion,
   SEO, hooks, derivacion de shorts, etc.). Soporta dos formas de uso:
   - Estructurada (paso 4, Generar guion): { idea, tiempos, instructivo, message } — tiempos
     son los tiempos narrativos del canal, instructivo es el system prompt ya armado del
     lado del cliente por buildGuionInstructivo().
   - Prompt libre (el resto de las funciones que antes llamaban directo a callClaude()):
     { message, maxTokens } — un unico mensaje de usuario, sin system prompt, igual que la
     llamada que reemplaza. */
/* ================= investigacion real (Wikipedia) para el guion =================
   Pedido explicito del usuario (2026-08-25): sin esto, el LLM (8B, sin ningun tipo de
   busqueda) escribe guiones de temas historicos/misteriosos inventando nombres de
   "expertos", instituciones y citas textuales de la nada -- riesgo real de que YouTube
   marque el video como contenido inautentico. Wikipedia en español, API REST propia, sin
   API key -- cubre bien la mayoria de los temas de historia/misterio/documental de este
   proyecto (no cubre temas muy nicho o de actualidad reciente, ver nota en el prompt cuando
   no encuentra nada). Best-effort: si falla o no encuentra nada, generateScript() sigue
   igual, solo que con una instruccion mas fuerte de no inventar datos concretos. */
async function fetchWikipediaResearch(query){
  try{
    const searchUrl = `https://es.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=1&origin=*`;
    const searchRes = await fetch(searchUrl, { signal: AbortSignal.timeout(8000) });
    if(!searchRes.ok) return null;
    const searchData = await searchRes.json();
    const hit = searchData && searchData.query && searchData.query.search && searchData.query.search[0];
    if(!hit) return null;

    const extractUrl = `https://es.wikipedia.org/w/api.php?action=query&prop=extracts&exintro&explaintext&titles=${encodeURIComponent(hit.title)}&format=json&origin=*`;
    const extractRes = await fetch(extractUrl, { signal: AbortSignal.timeout(8000) });
    if(!extractRes.ok) return null;
    const extractData = await extractRes.json();
    const pages = (extractData && extractData.query && extractData.query.pages) || {};
    const page = Object.values(pages)[0];
    if(!page || !page.extract || !page.extract.trim()) return null;

    return {
      title: page.title,
      extract: page.extract.trim().slice(0, 3000),
      url: `https://es.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`
    };
  }catch(e){
    return null;
  }
}

function buildResearchBlock(research){
  if(research){
    return `\n\nFUENTE REAL VERIFICADA (Wikipedia, "${research.title}", ${research.url}):\n${research.extract}\n\nUsá esta fuente como base para cualquier dato concreto (nombres propios, fechas, instituciones, hechos) que menciones en el guion. Si necesitás un dato que NO está en esta fuente, no lo inventes: hablá en términos generales ("los registros de la época", "algunos investigadores sugieren") en vez de fabricar un nombre, una fecha exacta o una cita textual específica.\n`;
  }
  return `\n\nNo se encontró una fuente verificada para este tema. Por eso: NO inventes nombres propios de expertos/historiadores, instituciones, citas textuales entre comillas ni fechas exactas específicas. Hablá en términos generales y verificables en vez de fabricar un dato concreto que no podés confirmar.\n`;
}

async function handleGenerateScript(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { idea, tiempos, instructivo, message, maxTokens } = body;

  if(!message && !idea){
    return sendJson(res, 400, { error: 'Falta "message" (prompt libre) o "idea" (opcionalmente con "tiempos") en el body.' });
  }
  if(!LLM_API_KEY){
    return sendJson(res, 500, {
      error: 'No hay LLM_API_KEY configurada en el servidor. Copia .env.example a .env y completa tu key de FreeLLMAPI o NVIDIA NIM.'
    });
  }
  if(!LLM_BASE_URL){
    return sendJson(res, 500, {
      error: `No hay LLM_BASE_URL configurada para el proveedor "${LLM_PROVIDER}". Completa LLM_BASE_URL en tu .env.`
    });
  }

  let systemPrompt = instructivo || (Array.isArray(tiempos) && tiempos.length ? buildFallbackInstructivo(tiempos) : null);
  const userMessage = message || `IDEA DEL VIDEO: "${idea}"\nEmpieza directo con el guion.`;

  // Solo se investiga en el camino real de generacion de guion (idea presente, sin "message"
  // libre) -- las decenas de otras llamadas de prompt libre que ya pasan por este mismo
  // endpoint (SEO, hooks, prompts de imagen, etc.) no lo necesitan y no deberian pagar el
  // costo extra de la consulta a Wikipedia.
  if(idea && !message){
    const research = await fetchWikipediaResearch(idea);
    systemPrompt = (systemPrompt || '') + buildResearchBlock(research);
  }

  const messages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }]
    : [{ role: 'user', content: userMessage }];

  try{
    const script = await callChatCompletions({ messages, maxTokens: maxTokens || 1200 });
    return sendJson(res, 200, { script, provider: LLM_PROVIDER, model: LLM_MODEL });
  }catch(e){
    return sendJson(res, 502, { error: `Error al contactar al proveedor de IA (${LLM_PROVIDER}): ${e.message}` });
  }
}

function buildFallbackInstructivo(tiempos){
  const pasos = tiempos.map((t, i) => `${i + 1}. ${t}`).join('\n');
  return `Eres un guionista profesional de YouTube. Escribe un guion narrado en español, en prosa continua lista para locución, siguiendo esta estructura obligatoria de ${tiempos.length} tiempos:\n${pasos}`;
}

/* Un unico intento de POST {baseUrl}/chat/completions (esquema OpenAI). No reintenta ni
   hace fallback — eso lo maneja callChatCompletions() orquestando varias llamadas a esta
   funcion. Separada para poder reutilizarla tanto con el proveedor primario como con el
   de fallback sin duplicar la logica de fetch/parseo. */
async function callChatCompletionsOnce({ baseUrl, apiKey, model, messages, maxTokens, timeoutMs, label }){
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  let res;
  try{
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.9
      }),
      signal: AbortSignal.timeout(timeoutMs)
    });
  }catch(e){
    if(e.name === 'TimeoutError') throw new Error(`${label} no respondió en ${timeoutMs/1000}s (¿modelo caído o degradado?).`);
    const detail = (e && e.cause && e.cause.message) ? e.cause.message : (e && e.message) || String(e);
    throw new Error(`${label}: no se pudo conectar (${detail}).`);
  }

  if(!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`${label}: HTTP ${res.status} ${res.statusText} ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if(!text){
    throw new Error(`${label}: respuesta sin contenido: ` + JSON.stringify(data).slice(0, 300));
  }
  return text.trim();
}

/* Orquesta el LLM primario (con un reintento automatico) y, si esta configurado, un
   proveedor de fallback "ultra rapido" (Groq u otro) para cuando el primario se cuelga o
   tarda demasiado. Orden: primario → fallback (si el primario fallo) → un ultimo reintento
   del primario (por si el fallo fue una falla transitoria y no hay fallback, o el fallback
   tambien fallo). Nunca deja la llamada colgada mas de ~2-3x LLM_TIMEOUT_MS en el peor caso,
   muy por debajo de los 90s que tardaba antes en avisar que el proveedor no respondia. */
async function callChatCompletions({ messages, maxTokens }){
  const attemptsLog = [];
  const tryPrimary = () => callChatCompletionsOnce({
    baseUrl: LLM_BASE_URL, apiKey: LLM_API_KEY, model: LLM_MODEL,
    messages, maxTokens, timeoutMs: LLM_TIMEOUT_MS, label: LLM_PROVIDER
  });
  const tryFallback = () => callChatCompletionsOnce({
    baseUrl: LLM_FALLBACK_BASE_URL, apiKey: LLM_FALLBACK_API_KEY, model: LLM_FALLBACK_MODEL,
    messages, maxTokens, timeoutMs: LLM_TIMEOUT_MS, label: `fallback (${LLM_FALLBACK_PROVIDER})`
  });

  try{
    return await tryPrimary();
  }catch(e){
    attemptsLog.push(e.message);
  }

  if(LLM_FALLBACK_ENABLED){
    try{
      return await tryFallback();
    }catch(e){
      attemptsLog.push(e.message);
    }
  }

  try{
    return await tryPrimary();
  }catch(e){
    attemptsLog.push(e.message);
  }

  throw new Error(attemptsLog.join(' | '));
}

/* Ultimo paso compartido por /api/nexlev-trend-idea y /api/trend-idea/youtube: le pasa datos
   reales de videos (de la fuente que sea) al LLM y le pide que sintetice titulo/slogan/angulo
   de investigacion para el canal. Separado para no duplicar el prompt entre las dos fuentes. */
async function synthesizeTrendIdea({ sourceData, sourceLabel, channelName, channelNicho, channelTono }){
  const prompt = `Eres estratega de contenido de YouTube para el canal "${channelName || ''}" (${channelNicho || ''}).
Tono del canal: ${(channelTono || '').slice(0, 300)}

Estos son datos reales de videos (${sourceLabel}):
${JSON.stringify(sourceData).slice(0, 4000)}

A partir de estos datos reales (no inventes tendencias que no esten sugeridas por ellos), proponé UNA sola idea de video nueva para este canal. Devolvé EXACTAMENTE este formato, sin nada mas antes ni despues:
TITULO: (título ganador, como lo escribirías en el banco de ideas SEO del canal)
SLOGAN: (2 a 4 palabras en MAYÚSCULAS, la frase de portada/miniatura)
INVESTIGACION: (2 a 4 oraciones: el ángulo de investigación real que debería cubrir el guion, basado en lo que sí funciona en los videos de referencia)`;

  // 500 se quedaba corto y cortaba a mitad de INVESTIGACION (el ultimo campo pedido, el que
  // mas se nota si se corta) -- confirmado en vivo 2026-08-25 con un caso real.
  const raw = await callChatCompletions({ messages: [{ role: 'user', content: prompt }], maxTokens: 900 });
  const stripQuotes = s => s.trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  const titulo = stripQuotes((raw.match(/TITULO:\s*(.+)/i) || [])[1] || '');
  const slogan = stripQuotes((raw.match(/SLOGAN:\s*(.+)/i) || [])[1] || '');
  const investigacion = ((raw.match(/INVESTIGACION:\s*([\s\S]+)/i) || [])[1] || '').trim();
  if(!titulo){
    throw new Error('El LLM no devolvió el formato esperado: ' + raw.slice(0, 200));
  }
  return { titulo, slogan, investigacion };
}

/* ================= POST /api/nexlev-trend-idea ================= */
async function handleNexlevTrendIdea(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { videoUrl, channelName, channelNicho, channelTono } = body;
  if(!videoUrl) return sendJson(res, 400, { error: 'Falta "videoUrl" (URL de un video de YouTube de referencia).' });
  if(!NEXLEV_API_KEY){
    return sendJson(res, 500, {
      error: 'No hay NEXLEV_API_KEY configurada en el servidor. Conseguila en dashboard.nexlev.io/n8n-youtube y completala en tu .env.'
    });
  }

  let nexlevData;
  try{
    const nexlevRes = await fetch(`${NEXLEV_BASE_URL}/external/similar-videos/get-similar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': NEXLEV_API_KEY },
      body: JSON.stringify({ videoURL: videoUrl }),
      signal: AbortSignal.timeout(NEXLEV_TIMEOUT_MS)
    });
    if(!nexlevRes.ok){
      const errText = await nexlevRes.text().catch(() => '');
      throw new Error(`HTTP ${nexlevRes.status} ${errText.slice(0, 300)}`);
    }
    nexlevData = await nexlevRes.json();
  }catch(e){
    const detail = e.name === 'TimeoutError' ? `no respondió en ${NEXLEV_TIMEOUT_MS / 1000}s` : e.message;
    return sendJson(res, 502, { error: `NexLev: ${detail}` });
  }

  try{
    const idea = await synthesizeTrendIdea({
      sourceData: nexlevData,
      sourceLabel: 'similares/en tendencia que devolvió NexLev a partir de un video de referencia que eligió el productor',
      channelName, channelNicho, channelTono
    });
    return sendJson(res, 200, { ...idea, nexlevRaw: nexlevData });
  }catch(e){
    return sendJson(res, 502, { error: `Error al sintetizar la idea con IA: ${e.message}` });
  }
}

/* ================= POST /api/trend-idea/youtube ================= */
async function handleTrendIdeaYoutube(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { channelName, channelNicho, channelTono } = body;
  if(!channelNicho) return sendJson(res, 400, { error: 'Falta "channelNicho" (elegí un canal primero).' });

  // El nicho suele venir como "Categoría amplia — ángulo específico" (ver vol*.txt/CHANNELS);
  // el ángulo específico (después del guion) suele ser mejor query de búsqueda que la
  // categoría amplia de antes. Sin guion, se usa el nicho entero tal cual.
  const query = channelNicho.includes('—')
    ? channelNicho.split('—').slice(1).join('—').trim()
    : channelNicho.trim();

  let videos;
  try{
    const { stdout } = await execFileAsync(
      YTDLP_PYTHON,
      ['-m', 'yt_dlp', `ytsearch${YTDLP_SEARCH_COUNT}:${query}`, '--flat-playlist', '--dump-json', '--no-warnings'],
      { timeout: YTDLP_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
    );
    videos = stdout.trim().split('\n').filter(Boolean).map(line => {
      const d = JSON.parse(line);
      return { titulo: d.title, canal: d.channel || d.uploader, vistas: d.view_count };
    });
  }catch(e){
    const detail = e.killed ? `no respondió en ${YTDLP_TIMEOUT_MS / 1000}s` : (e.stderr || e.message || '').toString().split('\n')[0];
    return sendJson(res, 502, {
      error: `yt-dlp: ${detail || 'fallo desconocido'} (¿está instalado? "python -m pip install -U yt-dlp")`
    });
  }
  if(!videos.length){
    return sendJson(res, 502, { error: `YouTube no devolvió resultados para "${query}".` });
  }

  try{
    const idea = await synthesizeTrendIdea({
      sourceData: videos,
      sourceLabel: `resultados reales de búsqueda en YouTube para "${query}" (título, canal y vistas)`,
      channelName, channelNicho, channelTono
    });
    return sendJson(res, 200, { ...idea, youtubeQuery: query, youtubeResults: videos });
  }catch(e){
    return sendJson(res, 502, { error: `Error al sintetizar la idea con IA: ${e.message}` });
  }
}

/* ================= trabajos de generacion de audio (async) ================= */
/* Voicebox ya trackea sus propias generaciones por id (ver callVoiceboxTTS mas abajo), asi
   que para TTS_PROVIDER=voicebox el "jobId" que ve el cliente ES el generation id real de
   Voicebox — /status y /result son un proxy directo, sin estado propio que mantener.
   Para el resto de los proveedores (sincronicos, sin id propio) se guarda el resultado aca,
   con limpieza periodica para no crecer sin limite en una sesion larga del servidor. */
const AUDIO_JOBS = new Map(); // jobId -> { status, buffer?, contentType?, error?, createdAt }
const AUDIO_JOB_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - AUDIO_JOB_TTL_MS;
  for(const [id, job] of AUDIO_JOBS){
    if(job.createdAt < cutoff) AUDIO_JOBS.delete(id);
  }
}, 5 * 60 * 1000).unref();

/* ================= POST /api/generate-audio/start ================= */
/* Encola la generacion y devuelve enseguida (no espera a que termine): { jobId, status }.
   Con Voicebox, status suele volver "generating" — el cliente hace polling a /status. Con
   el resto de los proveedores (una sola llamada sincronica) status ya vuelve "completed" o
   "failed" de una, pero se mantiene el mismo contrato de 3 pasos para que el front no tenga
   que distinguir proveedores. */
async function handleGenerateAudioStart(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { text, voice, format } = body;
  if(!text || typeof text !== 'string' || !text.trim()){
    return sendJson(res, 400, { error: 'Falta "text" (el texto de la escena o del guion completo) en el body.' });
  }
  const ttsNeedsApiKey = TTS_PROVIDER !== 'local' && TTS_PROVIDER !== 'voicebox';
  if(!TTS_API_KEY && ttsNeedsApiKey){
    return sendJson(res, 500, {
      error: `No hay TTS_API_KEY configurada para el proveedor "${TTS_PROVIDER}". Copia .env.example a .env y completa tu key (Fish Audio, o la misma LLM_API_KEY de NVIDIA NIM), o pon TTS_PROVIDER=local/voicebox con TTS_BASE_URL apuntando a tu servidor propio.`
    });
  }
  if(!TTS_BASE_URL){
    return sendJson(res, 500, {
      error: `No hay TTS_BASE_URL configurada para el proveedor de TTS "${TTS_PROVIDER}". Completa TTS_BASE_URL en tu .env.`
    });
  }

  const opts = { text: text.trim(), voice: voice || TTS_VOICE_ID || undefined, format: format || TTS_FORMAT };

  if(TTS_PROVIDER === 'voicebox'){
    try{
      const base = TTS_BASE_URL.replace(/\/+$/, '');
      const { id, status } = await startVoiceboxGeneration(base, opts);
      return sendJson(res, 200, { jobId: id, status });
    }catch(e){
      return sendJson(res, 502, { error: `Error al contactar a Voicebox: ${e.message}` });
    }
  }

  // proveedores sincronicos: ejecutar ya mismo y cachear el resultado bajo un jobId propio
  const jobId = crypto.randomUUID();
  AUDIO_JOBS.set(jobId, { status: 'generating', createdAt: Date.now() });
  try{
    const audio = await callTTSProvider(opts);
    AUDIO_JOBS.set(jobId, { status: 'completed', buffer: audio.buffer, contentType: audio.contentType, createdAt: Date.now() });
    return sendJson(res, 200, { jobId, status: 'completed' });
  }catch(e){
    AUDIO_JOBS.set(jobId, { status: 'failed', error: e.message, createdAt: Date.now() });
    return sendJson(res, 200, { jobId, status: 'failed', error: e.message });
  }
}

/* ================= GET /api/generate-audio/status?jobId= ================= */
async function handleGenerateAudioStatus(req, res, jobId){
  if(!jobId) return sendJson(res, 400, { error: 'Falta "jobId" en la query string.' });

  if(TTS_PROVIDER === 'voicebox'){
    try{
      const base = TTS_BASE_URL.replace(/\/+$/, '');
      const payload = await probeVoiceboxStatus(base, jobId);
      const status = payload.status === 'completed' ? 'completed'
        : (payload.status === 'failed' || payload.status === 'error') ? 'failed'
        : 'generating';
      return sendJson(res, 200, { status, error: payload.error || null });
    }catch(e){
      return sendJson(res, 502, { error: `No se pudo consultar el estado en Voicebox: ${e.message}` });
    }
  }

  const job = AUDIO_JOBS.get(jobId);
  if(!job) return sendJson(res, 404, { error: 'No existe ese jobId (¿expiró o el servidor se reinició?).' });
  return sendJson(res, 200, { status: job.status, error: job.error || null });
}

/* ================= GET /api/generate-audio/result?jobId= ================= */
async function handleGenerateAudioResult(req, res, jobId){
  if(!jobId) return sendJson(res, 400, { error: 'Falta "jobId" en la query string.' });

  if(TTS_PROVIDER === 'voicebox'){
    try{
      const base = TTS_BASE_URL.replace(/\/+$/, '');
      const audioRes = await fetch(`${base}/audio/${jobId}`);
      if(!audioRes.ok){
        const errText = await audioRes.text().catch(() => '');
        throw new Error(`HTTP ${audioRes.status} ${errText.slice(0, 300)}`);
      }
      const contentType = audioRes.headers.get('content-type') || 'audio/wav';
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      res.writeHead(200, { 'Content-Type': contentType.startsWith('audio/') ? contentType : 'audio/wav', 'Content-Length': buffer.length, 'Cache-Control': 'no-store' });
      return res.end(buffer);
    }catch(e){
      return sendJson(res, 502, { error: `No se pudo descargar el audio desde Voicebox: ${e.message}` });
    }
  }

  const job = AUDIO_JOBS.get(jobId);
  if(!job) return sendJson(res, 404, { error: 'No existe ese jobId (¿expiró o el servidor se reinició?).' });
  if(job.status === 'failed') return sendJson(res, 502, { error: job.error || 'La generación falló.' });
  if(job.status !== 'completed' || !job.buffer) return sendJson(res, 409, { error: 'Todavía no está listo.' });
  res.writeHead(200, { 'Content-Type': job.contentType, 'Content-Length': job.buffer.length, 'Cache-Control': 'no-store' });
  res.end(job.buffer);
}

/* ================= POST /api/generate-audio (sincronico, legado/compat) ================= */
/* Recibe el texto de una escena o del guion completo y lo sintetiza a voz via un
   proveedor de TTS OpenAI-style-free (Fish Audio por API key, o un endpoint local/
   custom propio). Devuelve el audio en crudo (Content-Type audio/*), listo para usar
   directo como src de un <audio> del lado del cliente. Bloquea hasta terminar — el front
   ya no lo usa (usa /start + /status + /result para mostrar progreso y no colgarse en
   generaciones largas), pero queda disponible para integraciones externas simples. */
async function handleGenerateAudio(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { text, voice, format } = body;

  if(!text || typeof text !== 'string' || !text.trim()){
    return sendJson(res, 400, { error: 'Falta "text" (el texto de la escena o del guion completo) en el body.' });
  }
  const ttsNeedsApiKey = TTS_PROVIDER !== 'local' && TTS_PROVIDER !== 'voicebox';
  if(!TTS_API_KEY && ttsNeedsApiKey){
    return sendJson(res, 500, {
      error: `No hay TTS_API_KEY configurada para el proveedor "${TTS_PROVIDER}". Copia .env.example a .env y completa tu key (Fish Audio, o la misma LLM_API_KEY de NVIDIA NIM), o pon TTS_PROVIDER=local/voicebox con TTS_BASE_URL apuntando a tu servidor propio.`
    });
  }
  if(!TTS_BASE_URL){
    return sendJson(res, 500, {
      error: `No hay TTS_BASE_URL configurada para el proveedor de TTS "${TTS_PROVIDER}". Completa TTS_BASE_URL en tu .env.`
    });
  }

  try{
    const audio = await callTTSProvider({
      text: text.trim(),
      voice: voice || TTS_VOICE_ID || undefined,
      format: format || TTS_FORMAT
    });
    res.writeHead(200, {
      'Content-Type': audio.contentType,
      'Content-Length': audio.buffer.length,
      'Cache-Control': 'no-store'
    });
    res.end(audio.buffer);
  }catch(e){
    sendJson(res, 502, { error: `Error al contactar al proveedor de TTS (${TTS_PROVIDER}): ${e.message}` });
  }
}

async function callTTSProvider({ text, voice, format }){
  if(TTS_PROVIDER === 'voicebox'){
    return callVoiceboxTTS({ text, voice });
  }
  if(TTS_PROVIDER === 'fishaudio'){
    return callFishAudioTTS({ text, voice, format });
  }
  if(TTS_PROVIDER === 'nvidia'){
    return callNvidiaTTS({ text, voice, format });
  }
  // 'local' y 'custom' comparten el mismo cliente generico
  return callGenericTTS({ text, voice, format });
}

/* Voicebox (https://voicebox.sh): app local de voz con backend FastAPI en TTS_BASE_URL
   (por defecto http://127.0.0.1:17493). El flujo real, confirmado contra el /openapi.json
   de una instancia corriendo en local, es en tres pasos:
   1) POST /speak {text, profile} -> encola la generacion, devuelve {id, status:"generating"}
   2) GET /generate/{id}/status -> SSE que va emitiendo el estado hasta "completed"/"failed"
   3) GET /audio/{id} -> sirve el archivo de audio ya generado (bytes crudos)
   "voice" es el id (o nombre) del perfil de Voicebox a usar; si no se manda, Voicebox cae
   al binding del cliente o al perfil default. */
/* Un solo pedido de principio a fin: encola, espera y descarga. Es TODO lo que hacia antes
   callVoiceboxTTS() -- ahora extraido aparte porque con guiones largos (ver mas abajo) hace
   falta llamarlo varias veces, una por cada pedazo de texto. */
async function generateVoiceboxChunk(base, { text, voice, timeoutMs }){
  const { id: generationId, status } = await startVoiceboxGeneration(base, { text, voice });
  if(status !== 'completed'){
    await waitForVoiceboxGeneration(base, generationId, timeoutMs);
  }
  const audioRes = await fetch(`${base}/audio/${generationId}`);
  if(!audioRes.ok){
    const errText = await audioRes.text().catch(() => '');
    throw new Error(`No se pudo descargar el audio generado (GET /audio/${generationId}): HTTP ${audioRes.status} ${errText.slice(0, 300)}`);
  }
  const contentType = audioRes.headers.get('content-type') || 'audio/wav';
  const buffer = Buffer.from(await audioRes.arrayBuffer());
  return { buffer, contentType: contentType.startsWith('audio/') ? contentType : 'audio/wav' };
}

/* Voicebox rechaza con 400/422 "string_too_long" cualquier texto de mas de 10000 caracteres
   por pedido de /speak (confirmado en vivo 2026-08-25 con un guion de video largo real) --
   limite propio de Voicebox, no configurable desde aca. Con margen de seguridad, un poco por
   debajo de ese limite. */
const VOICEBOX_MAX_CHARS = 9500;

/* Los pedazos se arman bastante mas chicos que VOICEBOX_MAX_CHARS a propósito: no es solo un
   limite de caracteres de la API, tambien es tiempo real de generacion. Probado en vivo
   (2026-08-25): un pedazo de ~6000 caracteres (varios minutos de audio hablado) tardo mas de
   3 minutos en generarse y agoto el timeout de espera. Pedazos mas chicos generan mas rapido
   cada uno (con mas margen contra VOICEBOX_CHUNK_TIMEOUT_MS de abajo) y, si uno falla, se
   pierde menos trabajo hecho. */
const VOICEBOX_CHUNK_TARGET_CHARS = 4000;
/* Probado en vivo (2026-08-25): ni siquiera un timeout fijo de 6 minutos alcanzo para un
   pedazo de ~4000 caracteres en esta maquina -- Voicebox local puede ser bastante mas lento
   que "generoso" en hardware modesto. En vez de seguir adivinando una constante fija, el
   timeout escala con el tamano real del pedazo (150ms por caracter, piso de 3 min) para que
   un pedazo mas corto no espere de mas y uno largo no se quede corto. */
function voiceboxChunkTimeoutMs(text){
  return Math.max(180000, text.length * 150);
}

/* Parte el texto en pedazos de hasta maxChars, cortando siempre en un limite de oracion
   (nunca a mitad de una) -- mismo criterio que trimScriptToWordTarget() en el cliente, pero
   empaquetando en vez de recortar. */
function splitTextIntoVoiceChunks(text, maxChars){
  const sentences = text.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [text];
  const chunks = [];
  let current = '';
  for(const raw of sentences){
    const sentence = raw.trim();
    if(!sentence) continue;
    const candidate = current ? `${current} ${sentence}` : sentence;
    if(candidate.length > maxChars && current){
      chunks.push(current);
      current = sentence;
    }else{
      current = candidate;
    }
  }
  if(current) chunks.push(current);
  return chunks;
}

async function callVoiceboxTTS({ text, voice }){
  const base = TTS_BASE_URL.replace(/\/+$/, '');

  if(text.length <= VOICEBOX_MAX_CHARS){
    return generateVoiceboxChunk(base, { text, voice });
  }

  // Guion largo: Voicebox no acepta el texto entero de una -- se genera en varios pedidos y
  // se concatena el audio resultante con ffmpeg (ya es dependencia del proyecto para el
  // render de video). filter_complex concat en vez de el demuxer -f concat/-c copy porque no
  // hay garantia de que cada pedido a Voicebox devuelva exactamente el mismo formato de
  // archivo -- este camino decodifica cada pedazo antes de unirlos, asi que funciona aunque
  // no coincidan bit a bit.
  const chunks = splitTextIntoVoiceChunks(text, VOICEBOX_CHUNK_TARGET_CHARS);
  const jobDir = render.newJobDir(`voicebox-${crypto.randomUUID()}`);
  try{
    const chunkFiles = [];
    for(let i = 0; i < chunks.length; i++){
      const { buffer } = await generateVoiceboxChunk(base, { text: chunks[i], voice, timeoutMs: voiceboxChunkTimeoutMs(chunks[i]) });
      const fileName = `chunk_${String(i).padStart(3, '0')}.wav`;
      fs.writeFileSync(path.join(jobDir, fileName), buffer);
      chunkFiles.push(fileName);
    }

    const outName = 'concatenated.wav';
    const inputArgs = chunkFiles.flatMap(name => ['-i', name]);
    const filterInputs = chunkFiles.map((_, i) => `[${i}:a]`).join('');
    const filterComplex = `${filterInputs}concat=n=${chunkFiles.length}:v=0:a=1[out]`;
    await render.runFFmpeg([...inputArgs, '-filter_complex', filterComplex, '-map', '[out]', outName], { cwd: jobDir });

    const buffer = fs.readFileSync(path.join(jobDir, outName));
    return { buffer, contentType: 'audio/wav' };
  }finally{
    render.cleanupJobDir(jobDir);
  }
}

/* Solo el paso 1 (POST /speak) — encola la generacion y devuelve de una, sin esperar a que
   termine. Usado tanto por callVoiceboxTTS (flujo sincronico completo) como por
   /api/generate-audio/start (flujo async con polling). */
async function startVoiceboxGeneration(base, { text, voice }){
  const speakRes = await fetch(base + '/speak', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, profile: voice || undefined })
  });
  if(!speakRes.ok){
    const errText = await speakRes.text().catch(() => '');
    throw new Error(`HTTP ${speakRes.status} ${speakRes.statusText} en POST /speak — ${errText.slice(0, 400)}`);
  }
  const speakData = await speakRes.json();
  if(!speakData.id){
    throw new Error('Voicebox no devolvio un id de generacion: ' + JSON.stringify(speakData).slice(0, 300));
  }
  return { id: speakData.id, status: speakData.status || 'generating' };
}

/* Abre GET /generate/{id}/status (SSE) y va llamando onEvent(payload) por cada evento
   parseado, hasta que onEvent devuelva true (listo, corta la conexion) o se acabe el
   timeout. Devuelve true si onEvent corto el loop, false si el stream se cerro solo. Base
   compartida entre esperar-hasta-terminar (waitForVoiceboxGeneration) y sondear-una-vez
   (probeVoiceboxStatus) para no duplicar el parseo de SSE. */
async function readVoiceboxStatusEvents(base, generationId, onEvent, timeoutMs){
  const res = await fetch(`${base}/generate/${generationId}/status`);
  if(!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`No se pudo consultar el estado de la generacion: HTTP ${res.status} ${errText.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try{
    while(true){
      if(Date.now() > deadline){
        throw new Error('Tiempo de espera agotado consultando el estado de Voicebox.');
      }
      const { value, done } = await reader.read();
      if(done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while((idx = buffer.indexOf('\n\n')) !== -1){
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = rawEvent.split('\n').find(l => l.startsWith('data:'));
        if(!dataLine) continue;
        let payload;
        try{ payload = JSON.parse(dataLine.slice(5).trim()); }
        catch(e){ continue; }
        if(onEvent(payload)) return true;
      }
    }
  }finally{
    try{ reader.cancel(); }catch(e){}
  }
  return false;
}

/* Espera (bloqueando) hasta ver un evento con status terminal. Voicebox tarda en generar
   (carga de modelo, inferencia), asi que esto puede demorar bastante en la primera llamada
   — timeout generoso de 3 minutos. Usado por el flujo sincronico callVoiceboxTTS. */
async function waitForVoiceboxGeneration(base, generationId, timeoutMs = 180000){
  let finalPayload = null;
  const stopped = await readVoiceboxStatusEvents(base, generationId, (payload) => {
    if(payload.status === 'completed' || payload.status === 'failed' || payload.status === 'error'){
      finalPayload = payload;
      return true;
    }
    return false;
  }, timeoutMs);
  if(!stopped){
    throw new Error('Voicebox cerro la conexion de estado sin confirmar que la generacion termino.');
  }
  if(finalPayload.status !== 'completed'){
    throw new Error('La generacion de Voicebox fallo' + (finalPayload.error ? `: ${finalPayload.error}` : '.'));
  }
}

/* Sondeo puntual: abre la SSE, toma el primer evento (el snapshot de estado actual) y
   corta — no espera a que termine. Usado por /api/generate-audio/status para el polling
   desde el navegador, con un timeout corto porque solo necesitamos el estado de ahora. */
async function probeVoiceboxStatus(base, generationId, timeoutMs = 15000){
  let result = { status: 'generating' };
  await readVoiceboxStatusEvents(base, generationId, (payload) => {
    result = payload;
    return true;
  }, timeoutMs);
  return result;
}

/* NVIDIA NIM (https://integrate.api.nvidia.com), modelo resembleai/chatterbox-multilingual-tts.
   Misma cuenta/key que LLM_API_KEY (ver TTS_API_KEY arriba). NIM expone la mayoria de sus
   modelos de chat bajo el esquema OpenAI en /v1/chat/completions, pero los modelos de audio
   (TTS/ASR) van por una ruta de audio propia — probamos primero /v1/audio/speech (mismo
   nombre de ruta que usa la API de OpenAI para TTS, convencion que NVIDIA replica en varios
   de sus NIM). Si tu cuenta/catalogo expone el modelo bajo otra ruta o forma de body, ajusta
   esta funcion segun la respuesta real (el error que devuelve trae el body crudo del server). */
async function callNvidiaTTS({ text, voice, format }){
  const url = TTS_BASE_URL.replace(/\/+$/, '') + '/audio/speech';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TTS_API_KEY}`
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      input: text,
      voice: voice || undefined,
      response_format: format || 'mp3'
    }),
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS)
  });

  if(!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${errText.slice(0, 500)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if(contentType.startsWith('audio/')){
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
  }
  if(contentType.includes('application/json')){
    const data = await res.json();
    const b64 = data.audio_base64 || data.audio || data.data;
    if(b64) return { buffer: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' };
    throw new Error('Respuesta JSON de NVIDIA NIM sin audio reconocible: ' + JSON.stringify(data).slice(0, 500));
  }
  // contenido binario sin content-type audio/* explicito (algunos NIM devuelven octet-stream)
  return { buffer: Buffer.from(await res.arrayBuffer()), contentType: 'audio/mpeg' };
}

/* Fish Audio (https://fish.audio): TTS por API key.
   Forma del pedido segun su esquema publico habitual (JSON con texto + id de voz de
   referencia, respuesta = audio crudo). Si tu cuenta/plan usa un esquema distinto
   (multipart, msgpack, otros nombres de campo), ajusta este cliente segun la doc
   vigente de Fish Audio — el resto de la ruta (validaciones, respuesta al navegador)
   no cambia. */
async function callFishAudioTTS({ text, voice, format }){
  const url = TTS_BASE_URL.replace(/\/+$/, '') + '/tts';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TTS_API_KEY}`
    },
    body: JSON.stringify({
      text,
      reference_id: voice,
      format: format || 'mp3'
    }),
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS)
  });

  if(!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${errText.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') || 'audio/mpeg';
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, contentType: contentType.startsWith('audio/') ? contentType : 'audio/mpeg' };
}

/* Endpoint local o proveedor custom compatible: POST {TTS_BASE_URL} con {text, voice, format}.
   Acepta dos formas de respuesta para no atarse a un unico contrato:
   - bytes de audio directos (Content-Type: audio/*)
   - JSON con el audio en base64 (campo "audio_base64", "audio" o "data") */
async function callGenericTTS({ text, voice, format }){
  const res = await fetch(TTS_BASE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(TTS_API_KEY ? { 'Authorization': `Bearer ${TTS_API_KEY}` } : {})
    },
    body: JSON.stringify({ text, voice, format: format || 'mp3' }),
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS)
  });

  if(!res.ok){
    const errText = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${errText.slice(0, 300)}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if(contentType.startsWith('audio/')){
    return { buffer: Buffer.from(await res.arrayBuffer()), contentType };
  }

  const data = await res.json();
  const b64 = data.audio_base64 || data.audio || data.data;
  if(!b64) throw new Error('Respuesta del proveedor de TTS sin audio reconocible (ni Content-Type audio/*, ni JSON con audio en base64).');
  return { buffer: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' };
}

/* ================= GET /api/voice-profiles ================= */
/* Proxy de solo lectura a GET {TTS_BASE_URL}/profiles de Voicebox (id + name de cada
   perfil de voz configurado localmente), para que el front pueda armar el selector de
   locucion sin pegarle directo a :17493 desde el navegador. Solo tiene sentido con
   TTS_PROVIDER=voicebox; con otros proveedores devuelve una lista vacia. */
async function handleVoiceProfiles(req, res){
  if(TTS_PROVIDER !== 'voicebox'){
    return sendJson(res, 200, { profiles: [] });
  }
  try{
    const url = TTS_BASE_URL.replace(/\/+$/, '') + '/profiles';
    const r = await fetch(url);
    if(!r.ok){
      const errText = await r.text().catch(() => '');
      throw new Error(`HTTP ${r.status} ${r.statusText} ${errText.slice(0, 300)}`);
    }
    const data = await r.json();
    const list = Array.isArray(data) ? data : (data.profiles || data.items || []);
    const profiles = list.map(p => ({ id: p.id, name: p.name }));
    return sendJson(res, 200, { profiles });
  }catch(e){
    return sendJson(res, 502, { error: `No se pudo listar los perfiles de Voicebox: ${e.message}` });
  }
}

/* ================= generacion de medios de escena (Wan2GP + Pollinations, async con polling) =================
   Mismo patron que /api/generate-audio/{start,status}: un lote de N escenas puede tardar
   bastante, asi que /start encola todo y devuelve enseguida, y el front sondea /status para
   ver el progreso escena por escena en vivo.

   Por escena, la cadena es: B-roll de VIDEO real con Wan2GP (si esta configurado) -> imagen
   IA (Pollinations por defecto) si Wan2GP no esta disponible o falla para esa escena puntual.
   Reusa tal cual generateBroll()/isWan2GpConfigured() (ultron/scripts/lib/generateBrolls.js)
   y generateImage() (ultron/scripts/lib/generateImage.js) — el mismo codigo que ya usa el
   pipeline CLI standalone de ultron (generate-video.js) — en vez de duplicar esa logica aca.

   Limitacion conocida: ambos generadores producen siempre vertical 768x1344 (default fijo de
   generateImage.js / wan2gp_bridge.py, pensado para el 9:16 de ultron) — no hay forma de
   pedir otra resolucion desde aca todavia. Para 16:9 o carrusel, el render igual cubre el
   cuadro (crop en renderSceneClip/Ken Burns), pero con mas recorte que si la fuente ya
   viniera en ese aspecto. */
const MEDIA_JOBS = new Map(); // jobId -> { status, total, results:[{index,status,url,mediaType,error}], createdAt }
const MEDIA_JOB_TTL_MS = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - MEDIA_JOB_TTL_MS;
  for(const [id, job] of MEDIA_JOBS){
    if(job.createdAt < cutoff) MEDIA_JOBS.delete(id);
  }
}, 5 * 60 * 1000).unref();

/* ================= POST /api/generate-scene-media/start ================= */
async function handleGenerateSceneMediaStart(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const scenes = Array.isArray(body.scenes) ? body.scenes : null;
  if(!scenes || !scenes.length){
    return sendJson(res, 400, { error: 'Falta "scenes" (array de {index, prompt, durationSeconds}) en el body.' });
  }
  for(const s of scenes){
    if(typeof s.index !== 'number' || !s.prompt){
      return sendJson(res, 400, { error: 'Cada escena necesita "index" (number) y "prompt" (string).' });
    }
  }
  const normalizedScenes = scenes.map(s => ({
    index: s.index,
    prompt: s.prompt,
    durationSeconds: Number(s.durationSeconds) > 0 ? Number(s.durationSeconds) : 4
  }));
  const sessionId = sanitizeSessionId(body.session);

  const jobId = crypto.randomUUID();
  const job = {
    status: 'running',
    total: normalizedScenes.length,
    results: normalizedScenes.map(s => ({ index: s.index, status: 'pending', url: null, mediaType: null, error: null })),
    createdAt: Date.now()
  };
  MEDIA_JOBS.set(jobId, job);

  // Procesa en segundo plano, escena por escena (secuencial: Wan2GP corre en la misma GPU
  // local, no banca generar varios clips en paralelo). La respuesta HTTP ya volvio con el jobId.
  runSceneMediaBatchJob(job, normalizedScenes, sessionId).catch(e => {
    job.status = 'failed';
    job.error = e.message;
  });

  return sendJson(res, 200, { jobId, total: job.total, wan2gpConfigured: isWan2GpConfigured() });
}

async function runSceneMediaBatchJob(job, scenes, sessionId){
  const dir = sessionScenesDir(sessionId);
  for(const scene of scenes){
    const entry = job.results.find(r => r.index === scene.index);
    try{
      const { mediaType, filename } = await generateAndSaveSceneMedia(scene.prompt, scene.index, scene.durationSeconds, dir);
      entry.status = 'done';
      entry.mediaType = mediaType;
      entry.url = `/public/assets/scenes/${sessionId}/${filename}`;
    }catch(e){
      entry.status = 'failed';
      entry.error = e.message;
    }
  }
  job.status = 'completed';
}

/* ================= GET /api/generate-scene-media/status?jobId= ================= */
async function handleGenerateSceneMediaStatus(req, res, jobId){
  if(!jobId) return sendJson(res, 400, { error: 'Falta "jobId" en la query string.' });
  const job = MEDIA_JOBS.get(jobId);
  if(!job) return sendJson(res, 404, { error: 'No existe ese jobId (¿expiró o el servidor se reinició?).' });
  return sendJson(res, 200, { status: job.status, total: job.total, results: job.results, error: job.error || null });
}

/* Resuelve el medio de UNA escena: Wan2GP primero (si esta configurado, ver
   isWan2GpConfigured()), imagen IA como fallback. generateBroll() nunca tira excepcion (ver
   su propio doc comment) — si Wan2GP no esta configurado o falla para esta escena puntual,
   devuelve null y esta funcion cae sola a generateImageWithRetry(). Esta SI puede devolver
   null tras agotar su reintento (un intento + un reintento con backoff de 1.5s, ver
   selectBackground.js) — probado en vivo (2026-08-21) que Pollinations falla bastante seguido
   en lotes grandes, y antes de este cambio server.js llamaba a generateImage() una sola vez
   sin reintentar, a diferencia del pipeline CLI de ultron que sí lo hacía. El llamador
   (runSceneMediaBatchJob) es quien atrapa el error final y marca la escena como fallida sin
   cortar el resto del lote. */
async function generateAndSaveSceneMedia(prompt, index, durationSeconds, scenesDir){
  const baseName = `scene_${String(index).padStart(3, '0')}`;

  if(isWan2GpConfigured()){
    const outPath = path.join(scenesDir, `${baseName}.mp4`);
    const file = await generateBroll(prompt, { durationSeconds, outPath });
    if(file){
      return { mediaType: 'video', filename: `${baseName}.mp4` };
    }
  }

  const buffer = await generateImageWithRetry(prompt, `Escena ${index + 1}`);
  if(!buffer){
    throw new Error('No se pudo generar la imagen (falló el intento inicial y el reintento).');
  }
  const ext = extFromImageBuffer(buffer);
  const filename = `${baseName}${ext}`;
  fs.writeFileSync(path.join(scenesDir, filename), buffer);
  return { mediaType: 'image', filename };
}
function extFromImageBuffer(buffer){
  if(buffer[0] === 0x89 && buffer[1] === 0x50) return '.png'; // firma PNG
  if(buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46) return '.webp'; // RIFF....WEBP
  return '.jpg';
}

/* ================= POST /api/scenes/upload?index=N ================= */
/* Sube a disco la imagen/video de una escena subida a mano en el paso 8 (las generadas
   por Wan2GP/Pollinations ya llegan a disco solas, ver mas arriba). Mismo nombre
   "scene_NNN.<ext>" que usa ese batch, para que el render encuentre cualquiera de las dos
   por igual. */
async function handleSceneUpload(req, res, query){
  const index = parseInt(query.get('index'), 10);
  if(!Number.isInteger(index) || index < 0){
    return sendJson(res, 400, { error: 'Falta o es invalido el parametro "index" en la query string.' });
  }
  const ext = extFromUploadContentType(req.headers['content-type']);
  if(!ext){
    return sendJson(res, 400, { error: `Content-Type no reconocido para una escena: "${req.headers['content-type']}".` });
  }
  let buffer;
  try{ buffer = await readRawBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }
  if(!buffer.length) return sendJson(res, 400, { error: 'Archivo vacio.' });

  const sessionId = sanitizeSessionId(query.get('session'));
  const dir = sessionScenesDir(sessionId);
  const baseName = `scene_${String(index).padStart(3, '0')}`;
  removeExistingWithBase(dir, baseName);
  const filename = baseName + ext;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return sendJson(res, 200, { url: `/public/assets/scenes/${sessionId}/${filename}` });
}

/* ================= POST /api/audio/upload?type=narration|music|sfx&name= ================= */
/* Sube a disco el audio que el render va a necesitar: narracion (unica, se pisa en cada
   render), musica de fondo (opcional, unica), o efectos de sonido (opcional, varios —
   requiere &name= para no pisarse entre si). */
async function handleAudioUpload(req, res, query){
  const type = query.get('type');
  if(!['narration', 'music', 'sfx'].includes(type)){
    return sendJson(res, 400, { error: 'El parametro "type" debe ser narration, music o sfx.' });
  }
  const ext = extFromUploadContentType(req.headers['content-type']);
  if(!ext){
    return sendJson(res, 400, { error: `Content-Type no reconocido para audio: "${req.headers['content-type']}".` });
  }
  let buffer;
  try{ buffer = await readRawBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }
  if(!buffer.length) return sendJson(res, 400, { error: 'Archivo vacio.' });

  const sessionId = sanitizeSessionId(query.get('session'));
  const dir = sessionAudioDir(sessionId);
  let baseName;
  if(type === 'sfx'){
    const name = (query.get('name') || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if(!name) return sendJson(res, 400, { error: 'Falta "name" en la query string para subir un SFX.' });
    baseName = `sfx_${name}`;
  } else {
    baseName = type; // "narration" o "music" — uno solo, siempre se pisa (por sesion)
  }
  removeExistingWithBase(dir, baseName);
  const filename = baseName + ext;
  fs.writeFileSync(path.join(dir, filename), buffer);
  return sendJson(res, 200, { url: `/public/assets/audio/${sessionId}/${filename}` });
}

/* ================= renderizado de video (async con polling) ================= */
const RENDER_JOBS = new Map(); // jobId -> { status, stage, percent, error, url, createdAt }
const RENDER_JOB_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - RENDER_JOB_TTL_MS;
  for(const [id, job] of RENDER_JOBS){
    if(job.createdAt < cutoff) RENDER_JOBS.delete(id);
  }
}, 10 * 60 * 1000).unref();

/* ================= POST /api/render-video/start ================= */
/* Arma el video final via FFmpeg (ver render.js): busca en disco los medios ya subidos
   de cada escena del turboscript (scene_NNN.*, subidos a mano o generados con Wan2GP/
   Pollinations) y el audio
   (narration.*, music.* opcional, sfx_*.* opcional), y encola el render completo en
   segundo plano — la respuesta vuelve enseguida con un jobId para sondear el progreso. */
async function handleRenderVideoStart(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { turboscript, totalDurationSec, aspectRatio, subtitlesEnabled, narrationVolume, musicVolume, mediaOffsets, session } = body;
  if(!Array.isArray(turboscript) || !turboscript.length){
    return sendJson(res, 400, { error: 'Falta "turboscript" (array de {start,end,text}) en el body.' });
  }
  if(!totalDurationSec || totalDurationSec <= 0){
    return sendJson(res, 400, { error: 'Falta "totalDurationSec" (duracion real del audio, en segundos) en el body.' });
  }

  const sessionId = sanitizeSessionId(session);
  const audioDir = sessionAudioDir(sessionId);
  const scenesDir = sessionScenesDir(sessionId);

  const narration = findFileByBase(audioDir, 'narration');
  if(!narration){
    return sendJson(res, 400, { error: 'No hay narracion subida. Sube el audio (paso 5) y volve a intentar — el front deberia subirla sola antes de llamar a esta ruta.' });
  }
  const music = findFileByBase(audioDir, 'music');
  let sfxPaths = [];
  try{
    sfxPaths = fs.readdirSync(audioDir)
      .filter(f => f.startsWith('sfx_'))
      .sort()
      .map(f => path.join(audioDir, f));
  }catch(e){ /* sin sfx, no pasa nada */ }

  // mediaOffsets (opcional): {[index]: segundos} -- un mismo clip de video subido a mano
  // puede cubrir varias escenas seguidas (paso 8, agrupación manual de clips); cada escena
  // del grupo manda el punto del archivo donde le toca arrancar. Ver renderSceneClip()
  // (render.js) y buildGuionJson() (remotionRender.js) para cómo se usa en cada motor.
  const offsets = (mediaOffsets && typeof mediaOffsets === 'object') ? mediaOffsets : {};
  const scenes = [];
  for(let i = 0; i < turboscript.length; i++){
    const found = findFileByBase(scenesDir, `scene_${String(i).padStart(3, '0')}`);
    if(found && found.mediaType){
      const offsetSeconds = Number(offsets[i]) || 0;
      scenes.push({ index: i, mediaPath: found.path, mediaType: found.mediaType, offsetSeconds });
    }
  }

  const jobId = crypto.randomUUID();
  const job = { status: 'running', stage: 'preparando', percent: 0, error: null, url: null, createdAt: Date.now() };
  RENDER_JOBS.set(jobId, job);

  const finalAspectRatio = aspectRatio || '9:16';
  const renderParams = {
    turboscript,
    scenes,
    totalDurationSec,
    aspectRatio: finalAspectRatio,
    subtitlesEnabled: subtitlesEnabled !== false,
    narrationPath: narration.path,
    musicPath: music ? music.path : null,
    sfxPaths,
    narrationVol: narrationVolume,
    musicVol: musicVolume,
  };
  // Motor de render: Remotion (proyecto hermano ./ultron) para 9:16 -- subtitulos animados
  // palabra por palabra en vez del .ass estatico, ver remotionRender.js. Su composicion esta
  // fijada a 1080x1920 (ultron/src/constants.ts), asi que el resto de los formatos (16:9,
  // carrusel) siguen con el pipeline FFmpeg puro de render.js.
  const renderFn = finalAspectRatio === '9:16' ? remotionRender.renderFullVideoRemotion : render.renderFullVideo;
  renderFn(jobId, renderParams, job).catch(e => { job.status = 'failed'; job.error = e.message; });

  return sendJson(res, 200, { jobId, scenesWithMedia: scenes.length, totalScenes: turboscript.length });
}

/* ================= GET /api/render-video/status?jobId= ================= */
async function handleRenderVideoStatus(req, res, jobId){
  if(!jobId) return sendJson(res, 400, { error: 'Falta "jobId" en la query string.' });
  const job = RENDER_JOBS.get(jobId);
  if(!job) return sendJson(res, 404, { error: 'No existe ese jobId (¿expiró o el servidor se reinició?).' });
  return sendJson(res, 200, {
    status: job.status, stage: job.stage, percent: job.percent, error: job.error, url: job.url
  });
}

/* ================= POST /api/publish/telegram ================= */
async function handlePublishTelegram(req, res){
  let body;
  try{ body = await readJsonBody(req); }
  catch(e){ return sendJson(res, 400, { error: e.message }); }

  const { videoUrl, caption, thumbnailPrompt } = body;
  if(!videoUrl) return sendJson(res, 400, { error: 'Falta "videoUrl".' });

  // Validar la FORMA del videoUrl antes que nada, incluso antes de chequear config -- nunca
  // dejar pasar una ruta que no sea exactamente un archivo dentro de public/assets/renders/
  // (el unico lugar donde el propio servidor escribe videos renderizados), sea cual sea el
  // estado del resto del handler.
  if(!/^\/public\/assets\/renders\/[\w.-]+\.mp4$/.test(videoUrl)){
    return sendJson(res, 400, { error: 'videoUrl inválida.' });
  }
  if(!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID){
    return sendJson(res, 500, {
      error: 'Falta TELEGRAM_BOT_TOKEN o TELEGRAM_CHAT_ID en el servidor. Creá un bot con @BotFather y completá tu .env.'
    });
  }
  const videoPath = path.join(ROOT, videoUrl);
  if(!fs.existsSync(videoPath)){
    return sendJson(res, 404, { error: 'No se encontró el video renderizado (¿ya corriste "Renderizar video" en el paso 9?).' });
  }

  try{
    if(thumbnailPrompt){
      const imgBuffer = await generateImageWithRetry(thumbnailPrompt, 'Portada Telegram');
      if(imgBuffer){
        try{
          await telegramApiCall('sendPhoto', {
            chat_id: TELEGRAM_CHAT_ID,
            photo: new Blob([imgBuffer], { type: 'image/jpeg' })
          });
        }catch(e){
          console.warn('[Telegram] No se pudo enviar la portada, sigo solo con el video: ' + e.message);
        }
      }
    }

    const MAX_CAPTION = 1024; // limite de Telegram para caption de sendVideo
    const fullCaption = caption || '';
    const videoBuffer = fs.readFileSync(videoPath);
    await telegramApiCall('sendVideo', {
      chat_id: TELEGRAM_CHAT_ID,
      video: new Blob([videoBuffer], { type: 'video/mp4' }),
      caption: fullCaption.slice(0, MAX_CAPTION),
      supports_streaming: 'true'
    });

    if(fullCaption.length > MAX_CAPTION){
      await telegramApiCall('sendMessage', { chat_id: TELEGRAM_CHAT_ID, text: fullCaption });
    }

    return sendJson(res, 200, { ok: true });
  }catch(e){
    return sendJson(res, 502, { error: `Telegram: ${e.message}` });
  }
}

/* ================= servidor ================= */
const server = http.createServer((req, res) => {
  const [urlPath, queryString] = req.url.split('?');
  const query = new URLSearchParams(queryString || '');

  if(req.method === 'POST' && urlPath === '/api/generate-script'){
    handleGenerateScript(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/nexlev-trend-idea'){
    handleNexlevTrendIdea(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/trend-idea/youtube'){
    handleTrendIdeaYoutube(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/publish/telegram'){
    handlePublishTelegram(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/generate-audio'){
    handleGenerateAudio(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/generate-audio/start'){
    handleGenerateAudioStart(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'GET' && urlPath === '/api/generate-audio/status'){
    handleGenerateAudioStatus(req, res, query.get('jobId')).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'GET' && urlPath === '/api/generate-audio/result'){
    handleGenerateAudioResult(req, res, query.get('jobId')).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'GET' && urlPath === '/api/voice-profiles'){
    handleVoiceProfiles(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/generate-scene-media/start'){
    handleGenerateSceneMediaStart(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'GET' && urlPath === '/api/generate-scene-media/status'){
    handleGenerateSceneMediaStatus(req, res, query.get('jobId')).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/scenes/upload'){
    handleSceneUpload(req, res, query).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/audio/upload'){
    handleAudioUpload(req, res, query).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'POST' && urlPath === '/api/render-video/start'){
    handleRenderVideoStart(req, res).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'GET' && urlPath === '/api/render-video/status'){
    handleRenderVideoStatus(req, res, query.get('jobId')).catch(e => sendJson(res, 500, { error: 'Error interno: ' + e.message }));
    return;
  }
  if(req.method === 'GET' || req.method === 'HEAD'){
    serveStatic(req, res);
    return;
  }
  res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('405 Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`UltromYoutube corriendo en http://localhost:${PORT}`);
  console.log(`Proveedor LLM configurado: ${LLM_PROVIDER} (${LLM_BASE_URL || 'sin base URL'}, modelo=${LLM_MODEL || 'sin modelo'}, timeout=${LLM_TIMEOUT_MS/1000}s)`);
  if(!LLM_API_KEY){
    console.log('Aviso: LLM_API_KEY no configurada. /api/generate-script va a devolver error hasta que copies .env.example a .env y completes tu key.');
  }
  if(LLM_FALLBACK_ENABLED){
    console.log(`Fallback LLM configurado: ${LLM_FALLBACK_PROVIDER || 'custom'} (${LLM_FALLBACK_BASE_URL}, modelo=${LLM_FALLBACK_MODEL || 'sin modelo'}) — se usa si el proveedor primario no responde.`);
  }else{
    console.log('Sin fallback LLM configurado (opcional). Completa LLM_FALLBACK_API_KEY en tu .env (ej. con Groq) para que /api/generate-script tenga un proveedor secundario si NVIDIA se cuelga.');
  }
  console.log(`Proveedor TTS configurado: ${TTS_PROVIDER} (${TTS_BASE_URL || 'sin base URL'})${TTS_MODEL ? ' modelo=' + TTS_MODEL : ''}`);
  if(!TTS_API_KEY && TTS_PROVIDER !== 'local' && TTS_PROVIDER !== 'voicebox'){
    console.log('Aviso: TTS_API_KEY no configurada. /api/generate-audio va a devolver error hasta que completes tu key (Fish Audio, o la misma LLM_API_KEY si usas TTS_PROVIDER=nvidia), o uses TTS_PROVIDER=local/voicebox.');
  }
  if(TTS_PROVIDER === 'voicebox'){
    console.log(`Voicebox: asegurate de tener la app abierta y corriendo en ${TTS_BASE_URL} antes de usar "Generar Locución".`);
  }
  if(isWan2GpConfigured()){
    console.log(`Wan2GP configurado (WAN2GP_ROOT=${process.env.WAN2GP_ROOT}) — cada escena intenta primero un B-roll de video real; si falla o no está disponible, cae a imagen IA. No verificado end-to-end todavía en este proyecto (ver ultron/README.md).`);
  } else {
    console.log('Wan2GP no configurado (WAN2GP_ROOT vacío en ultron/.env) — "Generar medios de escena" va a usar directo imagen IA (Pollinations.ai, gratis, sin API key).');
  }
  console.log(`Medios de escena generados se guardan en: ${SCENES_DIR}\\<sessionId>\\ (una subcarpeta por sesion/navegador, para que varios usuarios no se pisen).`);
  try{
    require('child_process').execFileSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { stdio: 'ignore' });
    console.log('ffmpeg detectado — /api/render-video listo para usarse.');
  }catch(e){
    console.log('Aviso: no se encontro ffmpeg en el PATH (ni FFMPEG_PATH en .env). /api/render-video va a fallar hasta que lo instales.');
  }
  if(fs.existsSync(path.join(remotionRender.ULTRON_ROOT, 'node_modules'))){
    console.log('Remotion (ultron/) detectado — /api/render-video usa subtitulos animados palabra por palabra para 9:16.');
  } else {
    console.log('Aviso: no se encontraron node_modules en ultron/. El render 9:16 va a fallar hasta que corras "npm install" ahi (ver ultron/README.md).');
  }
});
