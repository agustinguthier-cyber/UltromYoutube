const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/**
 * Extrae un frame representativo del video ya renderizado como thumbnail.png
 * -- no hay generación de portada dedicada todavía (ej. vía IA), esto es el
 * MVP: agarrar un frame real del propio video en vez de no tener portada.
 * Al 15% de la duración para saltear cualquier intro/fade y caer ya con
 * imagen de fondo + título en pantalla.
 */
async function generateThumbnail(videoPath, outPath, durationInSeconds) {
  const timestamp = Math.max(0.5, durationInSeconds * 0.15);
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    String(timestamp),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-loglevel",
    "error",
    outPath,
  ]);
  return outPath;
}

module.exports = { generateThumbnail };
