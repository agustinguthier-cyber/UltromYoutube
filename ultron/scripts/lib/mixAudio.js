const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const execFileAsync = promisify(execFile);

// Preset de ducking estándar (ataque rápido, release suave) -- mismo enfoque
// que ya usa render.js del proyecto padre con sidechaincompress. threshold
// bajo + ratio alto para que la música baje claramente apenas hay narración.
const DUCK_THRESHOLD = 0.05;
const DUCK_RATIO = 8;
const DUCK_ATTACK_MS = 5;
const DUCK_RELEASE_MS = 250;
const BGM_BASE_VOLUME = 0.35; // antes de ducking -- volumen "de fondo" en los huecos sin narración

/**
 * Mezcla narración + BGM (con ducking real vía sidechaincompress, activado
 * por la narración) + SFX puntuales, y mux-ea el resultado con el video de
 * Remotion (solo se copia el stream de video, sin recodificar -- rápido y
 * sin pérdida).
 *
 * Nunca toca el audio que Remotion ya horneó en videoPath -- usa
 * narrationPath (el .wav original) como fuente de voz para la mezcla, así
 * no hay narración duplicada.
 *
 * @param {object} params
 * @param {string} params.videoPath .mp4 renderizado por Remotion (se usa solo su video)
 * @param {string} params.narrationPath .wav de la locución original
 * @param {string|null} [params.bgmPath] pista de música (se loopea sola si es más corta que la narración)
 * @param {Array<{path:string, atSeconds:number}>} [params.sfxCues] SFX puntuales
 * @param {string} params.outPath
 */
async function mixAudio({ videoPath, narrationPath, bgmPath, sfxCues = [], outPath }) {
  const inputArgs = ["-i", videoPath, "-i", narrationPath];
  const filterParts = [];
  const amixLabels = ["[1:a]"]; // narración siempre primera -> amix duration=first se ancla a su duración

  let nextInputIndex = 2;

  if (bgmPath) {
    inputArgs.push("-stream_loop", "-1", "-i", bgmPath);
    const bgmIndex = nextInputIndex++;
    filterParts.push(`[${bgmIndex}:a]volume=${BGM_BASE_VOLUME}[bgm_base]`);
    filterParts.push(
      `[bgm_base][1:a]sidechaincompress=threshold=${DUCK_THRESHOLD}:ratio=${DUCK_RATIO}:attack=${DUCK_ATTACK_MS}:release=${DUCK_RELEASE_MS}:makeup=1[bgm_ducked]`
    );
    amixLabels.push("[bgm_ducked]");
  }

  for (const cue of sfxCues) {
    inputArgs.push("-i", cue.path);
    const index = nextInputIndex++;
    const delayMs = Math.max(0, Math.round(cue.atSeconds * 1000));
    const label = `sfx${index}`;
    filterParts.push(`[${index}:a]adelay=${delayMs}|${delayMs}[${label}]`);
    amixLabels.push(`[${label}]`);
  }

  filterParts.push(
    `${amixLabels.join("")}amix=inputs=${amixLabels.length}:duration=first:dropout_transition=0[mixed]`
  );

  await execFileAsync("ffmpeg", [
    "-y",
    ...inputArgs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    "0:v",
    "-map",
    "[mixed]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-shortest",
    "-loglevel",
    "error",
    outPath,
  ]);

  return outPath;
}

module.exports = { mixAudio };
