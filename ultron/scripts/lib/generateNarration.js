const fs = require("node:fs");
const path = require("node:path");
const { postJson, getJson } = require("./httpJson");

const POLL_INTERVAL_MS = 3000;
// Voicebox corriendo en CPU puede tardar bastante mas de 5min en una
// locucion real (visto en pruebas reales: un guion de ~3 segmentos tardo
// mas de eso). 15min de margen antes de rendirse.
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extensionForContentType(contentType) {
  if (contentType.includes("wav")) return "wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return "mp3";
  if (contentType.includes("ogg")) return "ogg";
  return "audio";
}

/**
 * Reusa el flujo async con polling de /api/generate-audio/* del servidor de
 * UltromYoutube (start -> status -> result), igual que el botón "Generar
 * Locución" del paso 4 de la app -- ver CLAUDE.md. Funciona con cualquier
 * TTS_PROVIDER configurado ahí (Voicebox por default).
 *
 * Guarda el audio en outDir/<fileBaseName>.<ext> y devuelve esa ruta.
 */
async function generateNarration(text, { serverUrl, voice, outDir, fileBaseName }) {
  const { jobId, status: startStatus } = await postJson(
    `${serverUrl}/api/generate-audio/start`,
    { text, voice }
  );

  let status = startStatus;
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (status !== "completed" && status !== "failed") {
    if (Date.now() > deadline) {
      throw new Error(
        `Timeout esperando la locución (job ${jobId}, ${POLL_TIMEOUT_MS / 1000}s). ¿Voicebox sigue corriendo?`
      );
    }
    await sleep(POLL_INTERVAL_MS);
    const s = await getJson(`${serverUrl}/api/generate-audio/status?jobId=${jobId}`);
    status = s.status;
    if (status === "failed") throw new Error(s.error || "La generación de audio falló.");
  }

  const res = await fetch(`${serverUrl}/api/generate-audio/result?jobId=${jobId}`);
  if (!res.ok) {
    throw new Error(`No se pudo descargar el audio generado (HTTP ${res.status}).`);
  }
  const contentType = res.headers.get("content-type") || "audio/mpeg";
  const buffer = Buffer.from(await res.arrayBuffer());

  const fileName = `${fileBaseName}.${extensionForContentType(contentType)}`;
  fs.mkdirSync(outDir, { recursive: true });
  const filePath = path.join(outDir, fileName);
  fs.writeFileSync(filePath, buffer);

  return { filePath, fileName };
}

module.exports = { generateNarration };
