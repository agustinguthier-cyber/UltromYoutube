const { listAudioFiles, pickRandom } = require("./audioAssets");

/**
 * Un SFX por cada corte de escena (el inicio de cada segmento salvo el
 * primero -- start=0 es el arranque del video, no una "transición"). Elige
 * un archivo al azar de sfxDir por cada corte, para variar. [] si sfxDir no
 * tiene archivos -- el video sale sin SFX, no rompe nada.
 *
 * @param {Array<{start:number}>} segmentWindows
 * @param {string} sfxDir ruta absoluta a public/assets/audio/sfx
 * @returns {Array<{path:string, atSeconds:number}>}
 */
function buildSfxCues(segmentWindows, sfxDir) {
  const files = listAudioFiles(sfxDir);
  if (files.length === 0) return [];

  return segmentWindows.slice(1).map((seg) => ({
    path: pickRandom(files),
    atSeconds: seg.start,
  }));
}

module.exports = { buildSfxCues };
