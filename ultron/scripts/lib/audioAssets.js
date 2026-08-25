const fs = require("node:fs");
const path = require("node:path");

const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".ogg", ".m4a"]);

/** Archivos de audio dentro de dir (no recursivo). [] si no existe o está vacío. */
function listAudioFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => AUDIO_EXTENSIONS.has(path.extname(f).toLowerCase()))
    .map((f) => path.join(dir, f));
}

function pickRandom(list) {
  if (!list || list.length === 0) return null;
  return list[Math.floor(Math.random() * list.length)];
}

module.exports = { listAudioFiles, pickRandom };
