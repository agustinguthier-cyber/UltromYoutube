const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_BACKGROUND = { type: "color", value: "#000000" };

/**
 * Arma el objeto guion.json final, matcheando backgroundSchema/guionSchema
 * (src/schema.ts).
 *
 * "background" SIEMPRE se escribe explícito (nunca se omite la clave).
 * Motivo real (no cosmético): `remotion render --props=<archivo>` no
 * reemplaza los defaultProps de la composición, los mezcla por encima -- si
 * esta clave faltara en el JSON, el render heredaría en silencio el valor
 * de demo de Root.tsx (sampleProps) en vez del default documentado. Visto
 * en un render real: un guion.json sin "background" terminó usando
 * backgrounds/sample-bg.mp4 igual.
 *
 * BGM y SFX no van acá -- Remotion solo produce visuales + narración, la
 * música y los efectos se mezclan después con FFmpeg (ver
 * scripts/lib/mixAudio.js), sobre el .mp4 que sale de este guion.
 */
function buildGuion({ title, audioRelativePath, background, captions, durationInSeconds }) {
  const guion = {
    title,
    audio: audioRelativePath,
    background: background || DEFAULT_BACKGROUND,
    captions,
  };
  if (durationInSeconds) guion.durationInSeconds = Math.round(durationInSeconds * 1000) / 1000;
  return guion;
}

function writeGuion(guion, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(guion, null, 2) + "\n", "utf8");
  return outPath;
}

module.exports = { buildGuion, writeGuion };
