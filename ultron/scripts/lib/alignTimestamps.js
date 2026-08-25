const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

const WORDS_PER_LINE = 4; // cuántas palabras quedan juntas en pantalla por bloque de subtítulo

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

function splitIntoWords(text) {
  return text.trim().split(/\s+/).filter(Boolean);
}

/**
 * Reparte "items" proporcionalmente a su longitud en caracteres dentro de la
 * ventana [startSec, endSec). Misma aproximación que ya usa el pipeline
 * hermano (render.js del proyecto padre, buildAssSubtitles) cuando no hay
 * alineación forzada real disponible -- ver CLAUDE.md de UltromYoutube.
 */
function distributeProportionally(items, startSec, endSec) {
  const totalChars = items.reduce((sum, s) => sum + s.length, 0) || 1;
  const windowDuration = Math.max(0, endSec - startSec);
  let cursor = startSec;
  return items.map((text) => {
    const share = (text.length / totalChars) * windowDuration;
    const start = cursor;
    const end = cursor + share;
    cursor = end;
    return { start: round3(start), end: round3(end), text: text.toUpperCase() };
  });
}

/**
 * Agrupa palabras individuales (ya con su propio [start,end]) en líneas de
 * WORDS_PER_LINE para pantalla -- cada línea es lo que Captions.tsx muestra
 * a la vez, con "words" adentro para resaltar la que se está pronunciendo.
 */
function groupWordsIntoLines(wordTimings, wordsPerLine = WORDS_PER_LINE) {
  const lines = [];
  for (let i = 0; i < wordTimings.length; i += wordsPerLine) {
    const chunk = wordTimings.slice(i, i + wordsPerLine);
    if (chunk.length === 0) continue;
    lines.push({
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
      text: chunk.map((w) => w.text).join(" "),
      words: chunk.map((w) => ({ start: w.start, end: w.end, text: w.text })),
    });
  }
  return lines;
}

/**
 * Le asigna a cada segmento del guion (los que devuelve generateScript.js)
 * una ventana [start, end] en segundos, proporcional a la longitud de su
 * "text" sobre el total de la locución. Se usa tanto para las escenas de
 * imagen (selectBackground.js) como, dentro de cada ventana, para repartir
 * las palabras de ese segmento en captions.
 */
function computeSegmentWindows(segments, audioDurationSeconds) {
  const totalChars = segments.reduce((sum, s) => sum + s.text.length, 0) || 1;
  let cursor = 0;
  return segments.map((seg) => {
    const share = (seg.text.length / totalChars) * audioDurationSeconds;
    const start = round3(cursor);
    const end = round3(cursor + share);
    cursor += share;
    return { ...seg, start, end };
  });
}

/**
 * Fallback SIN dependencias externas: reparte cada PALABRA (no bloques)
 * proporcionalmente dentro de la ventana de su segmento (ver
 * computeSegmentWindows), y las agrupa en líneas de pantalla. No conoce
 * pausas ni ritmo real de la locución -- es una aproximación, no forced
 * alignment de verdad. Siempre funciona, cero configuración.
 */
function captionsFromSegmentWindows(segmentWindows) {
  return segmentWindows.flatMap((w) => {
    const wordTimings = distributeProportionally(splitIntoWords(w.text), w.start, w.end);
    return groupWordsIntoLines(wordTimings);
  });
}

/**
 * Alineación real vía el filtro nativo `whisper` de ffmpeg (whisper.cpp
 * embebido -- este build de ffmpeg lo trae compilado: `ffmpeg -h
 * filter=whisper`). Requiere un modelo ggml local, ver
 * https://github.com/ggml-org/whisper.cpp/blob/master/models/README.md --
 * la ruta se pasa por la env var ULTRON_WHISPER_MODEL.
 *
 * El filtro transcribe en SEGMENTOS (no expone timestamps por palabra en
 * sus opciones), así que dentro de cada segmento igual se reparte
 * proporcionalmente palabra por palabra -- pero al menos los cortes de
 * segmento son reales (silencios detectados por su VAD), no una
 * interpolación ciega sobre el audio entero. Nota: estos "segmentos" de
 * whisper son transcripción real, NO los mismos segmentos del guion -- por
 * eso esta función solo se usa para los captions (palabra por palabra),
 * nunca para las ventanas de escena/imagen, que siempre salen de
 * computeSegmentWindows() sobre el guion original.
 *
 * El formato JSON exacto de salida del filtro no está verificado en este
 * entorno (no hay un modelo ggml instalado para probarlo) -- por eso está
 * defendido con try/catch: si el parseo falla o el shape no es el esperado,
 * devuelve null y el llamador cae al fallback proporcional sin romper el
 * pipeline.
 *
 * @returns {Promise<Array<{start:number,end:number,text:string,words:Array<{start:number,end:number,text:string}>}>|null>}
 */
async function alignWithFfmpegWhisper(audioFilePath, { modelPath, language = "es" }) {
  if (!modelPath) return null;
  if (!fs.existsSync(modelPath)) {
    console.warn(`[ULTRON] ULTRON_WHISPER_MODEL apunta a un archivo inexistente: ${modelPath}`);
    return null;
  }

  const tmpJson = path.join(os.tmpdir(), `ultron-whisper-${Date.now()}.json`);
  try {
    await execFileAsync("ffmpeg", [
      "-v",
      "error",
      "-i",
      audioFilePath,
      "-af",
      `whisper=model=${modelPath}:language=${language}:format=json:destination=${tmpJson}`,
      "-f",
      "null",
      "-",
    ]);

    const raw = JSON.parse(fs.readFileSync(tmpJson, "utf8"));
    const segments = raw.transcription || raw.segments || [];
    if (!Array.isArray(segments) || segments.length === 0) return null;

    const captions = [];
    for (const seg of segments) {
      const startSec =
        typeof seg.offsets?.from === "number" ? seg.offsets.from / 1000 : seg.start;
      const endSec = typeof seg.offsets?.to === "number" ? seg.offsets.to / 1000 : seg.end;
      const text = (seg.text || "").trim();
      if (!text || !Number.isFinite(startSec) || !Number.isFinite(endSec)) continue;
      const wordTimings = distributeProportionally(splitIntoWords(text), startSec, endSec);
      captions.push(...groupWordsIntoLines(wordTimings));
    }
    return captions.length ? captions : null;
  } catch (err) {
    console.warn(
      `[ULTRON] Falló la alineación con whisper.cpp, uso el fallback proporcional. Detalle: ${err.message}`
    );
    return null;
  } finally {
    fs.rm(tmpJson, { force: true }, () => {});
  }
}

/**
 * Punto de entrada del paso 3b. Recibe los segmentos crudos del guion (con
 * su "text") y devuelve:
 *  - captions: líneas de hasta WORDS_PER_LINE palabras, cada una con "words"
 *    (timing individual por palabra) para el resaltado de Captions.tsx
 *  - segmentWindows: cada segmento original + su [start, end] en segundos,
 *    para asignarle una imagen de fondo a cada uno (selectBackground.js)
 *
 * Los captions intentan whisper.cpp primero (real, si hay modelo
 * configurado) y si no está disponible o falla, caen al split proporcional.
 * segmentWindows SIEMPRE sale del split proporcional sobre el guion original
 * -- independiente de qué método se haya usado para los captions.
 */
async function getWordTimestamps(segments, audioFilePath, audioDurationSeconds) {
  const segmentWindows = computeSegmentWindows(segments, audioDurationSeconds);

  const modelPath = process.env.ULTRON_WHISPER_MODEL;
  const viaWhisper = await alignWithFfmpegWhisper(audioFilePath, { modelPath });
  const captions = viaWhisper || captionsFromSegmentWindows(segmentWindows);

  return { captions, segmentWindows };
}

module.exports = {
  getWordTimestamps,
  computeSegmentWindows,
  captionsFromSegmentWindows,
  groupWordsIntoLines,
  splitIntoWords,
  distributeProportionally,
};
