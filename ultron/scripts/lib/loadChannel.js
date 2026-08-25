const fs = require("node:fs");

function normalize(text) {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function loadChannelsData(channelsDataPath) {
  const raw = fs.readFileSync(channelsDataPath, "utf8");
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed) ? parsed : parsed.channels || Object.values(parsed);
}

/**
 * Busca un canal por nombre en channels_data.json (proyecto padre) --
 * insensible a mayúsculas/acentos, primero match exacto y si no hay,
 * match parcial (contiene). Devuelve null si no encuentra ninguno.
 *
 * @param {string} channelsDataPath ruta absoluta a channels_data.json
 * @param {string} channelName ej. "Enigmas Ocultos"
 */
function findChannel(channelsDataPath, channelName) {
  const channels = loadChannelsData(channelsDataPath);
  const target = normalize(channelName);

  const exact = channels.find((c) => normalize(c.name || c.nombre) === target);
  if (exact) return exact;

  return channels.find((c) => normalize(c.name || c.nombre).includes(target)) || null;
}

function listChannelNames(channelsDataPath) {
  return loadChannelsData(channelsDataPath).map((c) => c.name || c.nombre);
}

module.exports = { findChannel, listChannelNames, loadChannelsData };
