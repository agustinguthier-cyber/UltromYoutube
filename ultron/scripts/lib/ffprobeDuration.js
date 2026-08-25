const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

/** Duración en segundos de un archivo local de audio/video, vía ffprobe. */
async function getDurationInSeconds(filePath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "csv=p=0",
    filePath,
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) {
    throw new Error(`ffprobe no devolvió una duración válida para ${filePath}`);
  }
  return seconds;
}

module.exports = { getDurationInSeconds };
