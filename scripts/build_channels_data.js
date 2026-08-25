#!/usr/bin/env node
/**
 * Unifica vol1_channels_extracted.txt .. vol4_channels_extracted.txt (el "Manual Maestro")
 * en un unico channels_data.json, facil de consumir por ultrom-estudio.html.
 *
 * Uso: node scripts/build_channels_data.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_FILES = ['vol1_channels_extracted.txt', 'vol2_channels_extracted.txt', 'vol3_channels_extracted.txt', 'vol4_channels_extracted.txt'];
const OUTPUT_FILE = path.join(ROOT, 'channels_data.json');

const SIMPLE_FIELDS = new Set([
  'name', 'nicho', 'premisa', 'tono', 'vozMezcla',
  'musicPrompt', 'thumbnailBase', 'styleBase', 'animationBase', 'lineasRojas'
]);

function parseBulletList(block) {
  return block
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('•'))
    .map(line => line.replace(/^•\s*/, '').trim());
}

function parseChannelBlock(id, block, sourceFile) {
  const channel = { id, source: sourceFile };
  // Parte el bloque en [preambulo, label1, contenido1, label2, contenido2, ...]
  // usando cada linea "--- fieldName (extra info) ---" como separador.
  const parts = block.split(/^---\s*(.+?)\s*---\s*$/gm);

  for (let i = 1; i < parts.length; i += 2) {
    const rawLabel = parts[i].trim();
    const content = (parts[i + 1] || '').trim();

    const tiemposMatch = rawLabel.match(/^tiempos\s*\((\d+)\)$/i);
    const ideasMatch = rawLabel.match(/^ideas SEO\s*\(primeras (\d+) de (\d+)\)$/i);

    if (tiemposMatch) {
      channel.tiempos = parseBulletList(content);
    } else if (ideasMatch) {
      channel.ideasSEO = {
        total: Number(ideasMatch[2]),
        muestra: parseBulletList(content)
      };
    } else if (SIMPLE_FIELDS.has(rawLabel)) {
      channel[rawLabel] = content;
    }
  }
  return channel;
}

function parseFile(fileName) {
  const raw = fs.readFileSync(path.join(ROOT, fileName), 'utf8');
  // Quita las lineas separadoras "====...====" y parte por "CANAL: <id>"
  const cleaned = raw.replace(/^=+\s*$/gm, '');
  const parts = cleaned.split(/^CANAL:\s*(.+)$/m).slice(1); // [id, block, id, block, ...]

  const channels = [];
  for (let i = 0; i < parts.length; i += 2) {
    const id = parts[i].trim();
    const block = parts[i + 1] || '';
    channels.push(parseChannelBlock(id, block, fileName));
  }
  return channels;
}

function build() {
  const allChannels = SOURCE_FILES.flatMap(parseFile);

  const output = {
    generatedAt: new Date().toISOString(),
    sourceFiles: SOURCE_FILES,
    totalChannels: allChannels.length,
    channels: allChannels
  };

  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`OK: ${allChannels.length} canales escritos en ${path.relative(ROOT, OUTPUT_FILE)}`);
}

build();
