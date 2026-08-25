const { getJson } = require("./httpJson");

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function wordOverlapScore(a, b) {
  const wordsA = new Set(normalize(a).split(/\s+/).filter(Boolean));
  const wordsB = new Set(normalize(b).split(/\s+/).filter(Boolean));
  let score = 0;
  for (const w of wordsA) if (wordsB.has(w)) score++;
  return score;
}

/**
 * Busca, entre los perfiles de voz reales de Voicebox (GET
 * /api/voice-profiles), el que mejor coincide con "channelName" -- el
 * nombre del canal en channels_data.json no siempre es idéntico al nombre
 * del perfil en Voicebox (probado en vivo: canal "Enigmas Ocultos", perfil
 * de Voicebox solo "Enigmas" -- un match por igualdad exacta falla con
 * HTTP 404 "Voice profile not found"). Match por cantidad de palabras en
 * común (sin acentos/mayúsculas), no por substring exacto, para tolerar
 * variantes cortas/con errores de tipeo entre ambos nombres.
 *
 * @returns {Promise<string|null>} nombre EXACTO del perfil tal como lo
 * espera Voicebox, o null si ninguno comparte ni una palabra con channelName
 * (en ese caso el llamador sigue sin voz forzada, no rompe el pipeline).
 */
async function resolveVoiceProfile(channelName, serverUrl) {
  let profiles;
  try {
    ({ profiles } = await getJson(`${serverUrl}/api/voice-profiles`));
  } catch (err) {
    console.warn(
      `[ULTRON] No se pudo consultar /api/voice-profiles (${err.message.split("\n")[0]}) -- sigo sin auto-seleccionar voz.`
    );
    return null;
  }
  if (!Array.isArray(profiles) || profiles.length === 0) return null;

  let best = null;
  let bestScore = 0;
  for (const profile of profiles) {
    const score = wordOverlapScore(channelName, profile.name);
    if (score > bestScore) {
      bestScore = score;
      best = profile;
    }
  }
  return best ? best.name : null;
}

module.exports = { resolveVoiceProfile };
