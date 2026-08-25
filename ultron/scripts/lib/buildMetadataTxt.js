const fs = require("node:fs");

function toHashtag(text) {
  const clean = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  return clean ? `#${clean}` : null;
}

/**
 * metadata.txt legible: título, descripción (los "text" del guion
 * concatenados) y hashtags (keywords de cada segmento + el canal, si hay).
 */
function buildMetadataTxt({ title, segments, channelName }) {
  const description = segments.map((s) => s.text).join(" ");

  const rawTags = [...new Set(segments.flatMap((s) => s.keywords || []))];
  if (channelName) rawTags.unshift(channelName);
  const hashtags = [...new Set(rawTags.map(toHashtag).filter(Boolean))];

  return `Título: ${title}\n\nDescripción:\n${description}\n\nHashtags: ${hashtags.join(" ")}\n`;
}

function writeMetadataTxt(text, outPath) {
  fs.writeFileSync(outPath, text, "utf8");
  return outPath;
}

module.exports = { buildMetadataTxt, writeMetadataTxt };
