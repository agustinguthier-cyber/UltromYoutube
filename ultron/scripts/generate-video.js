#!/usr/bin/env node

/**
 * Orquestador end-to-end de ULTRON:
 *   1. Tema (CLI) -> 2. Guion (LLM) -> 3. Locución + timestamps -> 4. guion.json + render
 *   -> 5. Mezcla de audio (BGM + SFX) + carpeta final (video/portada/metadata)
 *
 * Requiere que el servidor de UltromYoutube (proyecto padre: `node
 * server.js`, por default en localhost:3000) esté corriendo -- reusa sus
 * rutas /api/generate-script y /api/generate-audio/* en vez de reimplementar
 * clientes de LLM/TTS acá adentro (ver CLAUDE.md del proyecto padre).
 *
 * Uso:
 *   node scripts/generate-video.js --prompt "3 datos sobre el espacio"
 *   node scripts/generate-video.js --prompt "..." --voice MiCanal --skip-render
 *   node scripts/generate-video.js --prompt "..." --server http://localhost:3000 --out out/mi-video.mp4
 *
 *   node scripts/generate-video.js --channel "Enigmas Ocultos"
 *   node scripts/generate-video.js --channel "Enigmas Ocultos" --prompt "El manuscrito que contradice la version oficial"
 *
 * Con --channel, lee tono/nicho/estilo visual/voz de channels_data.json
 * (proyecto padre) por nombre -- ver lib/loadChannel.js. Sin --prompt, elige
 * un tema al azar de las ideasSEO del canal. La voz de Voicebox se
 * auto-selecciona con el nombre del canal salvo que --voice la pise.
 *
 * Todo 100% local -- no hay subida a ningún servicio externo. El resultado
 * queda en out/YYYY-MM-DD_<título>/ (video.mp4, portada.png, metadata.txt),
 * salvo que se pase --out (ahí ese path pisa toda la carpeta estructurada,
 * pensado para integraciones/scripts externos que solo quieren el .mp4).
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = path.resolve(__dirname, "..");

// Carga ultron/.env si existe (IMAGE_PROVIDER, NVIDIA_IMAGE_API_KEY,
// SKYREELS_URL, ULTRON_WHISPER_MODEL, etc.) -- soporte nativo de Node 20+,
// sin agregar dotenv como dependencia. Opcional: sin el archivo, sigue
// andando con el comportamiento default (sin generación de imágenes IA).
try {
  process.loadEnvFile(path.join(projectRoot, ".env"));
} catch {
  // sin .env -- ok, todo lo que depende de sus vars ya tiene fallback seguro
}

const { generateScript } = require("./lib/generateScript");
const { generateNarration } = require("./lib/generateNarration");
const { getWordTimestamps } = require("./lib/alignTimestamps");
const { selectBackground } = require("./lib/selectBackground");
const { buildGuion, writeGuion } = require("./lib/buildGuion");
const { getDurationInSeconds } = require("./lib/ffprobeDuration");
const { findChannel, listChannelNames } = require("./lib/loadChannel");
const { resolveVoiceProfile } = require("./lib/resolveVoiceProfile");
const { listAudioFiles, pickRandom } = require("./lib/audioAssets");
const { buildSfxCues } = require("./lib/buildSfxCues");
const { mixAudio } = require("./lib/mixAudio");
const { generateThumbnail } = require("./lib/generateThumbnail");
const { buildMetadataTxt, writeMetadataTxt } = require("./lib/buildMetadataTxt");

// channels_data.json vive en la raíz del proyecto padre (UltromYoutube), no
// dentro de ultron/.
const CHANNELS_DATA_PATH = path.resolve(projectRoot, "..", "channels_data.json");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    if (eq !== -1) {
      args[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args[key] = next;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function slugify(text) {
  const slug = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
  return slug || "video";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/** Un tema al azar de la lista de ideas SEO del canal (si las tiene). */
function pickTopicFromChannel(channel) {
  const ideas = channel.ideasSEO?.muestra;
  if (Array.isArray(ideas) && ideas.length > 0) {
    return ideas[Math.floor(Math.random() * ideas.length)];
  }
  return channel.nicho || null;
}

function resolveChannel(channelName) {
  const channel = findChannel(CHANNELS_DATA_PATH, channelName);
  if (!channel) {
    const names = listChannelNames(CHANNELS_DATA_PATH);
    throw new Error(
      `No se encontró el canal "${channelName}" en channels_data.json. Canales disponibles: ${names.join(", ")}`
    );
  }
  return channel;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.prompt && !args.channel) {
    console.error(
      'Uso: node scripts/generate-video.js --prompt "tema del video" [--voice <perfil>] [--server http://localhost:3000] [--out out/video.mp4] [--skip-render]\n' +
        '  o: node scripts/generate-video.js --channel "Nombre del canal" [--prompt "tema puntual"]'
    );
    process.exit(1);
  }

  if (args.channel !== undefined && typeof args.channel !== "string") {
    throw new Error('--channel necesita un valor, ej: --channel "Enigmas Ocultos"');
  }

  const channel = typeof args.channel === "string" ? resolveChannel(args.channel) : null;
  const channelContext = channel
    ? { nicho: channel.nicho, tono: channel.tono, styleBase: channel.styleBase }
    : undefined;

  const topic = typeof args.prompt === "string" ? args.prompt : channel && pickTopicFromChannel(channel);
  if (!topic) {
    throw new Error(`El canal "${channel.name}" no tiene ideasSEO ni nicho de donde sacar un tema -- pasá --prompt.`);
  }
  // (si "channel" fuera null acá, ya se hubiese tirado el error de "sin
  // prompt ni channel" al principio de main() -- topic solo puede ser falsy
  // en este punto si channel existe pero no tiene de dónde sacar un tema)

  const serverUrl = String(args.server || "http://localhost:3000").replace(/\/+$/, "");
  const baseName = `${slugify(topic)}-${Date.now()}`;

  console.log(
    `\n[1/5] Generando guion para: "${topic}"${channel ? ` (canal: "${channel.name}")` : ""}...`
  );
  const { title, segments } = await generateScript(topic, { serverUrl, channelContext });
  const fullText = segments.map((s) => s.text).join(" ");
  console.log(`      Título: "${title}" -- ${segments.length} segmentos.`);

  // El nombre del canal en channels_data.json no siempre coincide LETRA POR
  // LETRA con el perfil de voz real en Voicebox (ej. "Enigmas Ocultos" en el
  // canal vs "Enigmas" en Voicebox -- probado en vivo, un match exacto
  // devuelve HTTP 404). resolveVoiceProfile() busca el perfil real más
  // parecido por palabras en común.
  const voiceProfile =
    typeof args.voice === "string"
      ? args.voice
      : channel && (await resolveVoiceProfile(channel.name, serverUrl));

  console.log(`[2/5] Generando locución (TTS)${voiceProfile ? ` (voz: "${voiceProfile}")` : ""}...`);
  const audioDir = path.join(projectRoot, "public", "audio");
  const { fileName: audioFileName, filePath: audioFilePath } = await generateNarration(fullText, {
    serverUrl,
    voice: voiceProfile,
    outDir: audioDir,
    fileBaseName: baseName,
  });
  const audioDurationSeconds = await getDurationInSeconds(audioFilePath);
  console.log(`      Audio: public/audio/${audioFileName} (${audioDurationSeconds.toFixed(1)}s)`);

  console.log(`[3/5] Alineando timestamps...`);
  const { captions, segmentWindows } = await getWordTimestamps(
    segments,
    audioFilePath,
    audioDurationSeconds
  );
  console.log(`      ${captions.length} bloques de subtítulos.`);

  // Paso 4 (background): una imagen IA por segmento (IMAGE_PROVIDER=nvidia|
  // skyreels|pollinations en ultron/.env) o, sin eso configurado, undefined
  // -> fondo negro sólido default. Nunca tira el pipeline si falla (ver
  // lib/selectBackground.js).
  const publicDir = path.join(projectRoot, "public");
  const background = await selectBackground(segmentWindows, { publicDir });

  const guion = buildGuion({
    title,
    audioRelativePath: `audio/${audioFileName}`,
    background,
    captions,
    durationInSeconds: audioDurationSeconds,
  });

  const guionPath = path.join(projectRoot, "jobs", `${baseName}.json`);
  writeGuion(guion, guionPath);
  console.log(`[4/5] guion.json: jobs/${baseName}.json`);

  if (args["skip-render"]) {
    console.log("\n--skip-render: listo, no se renderizó.");
    return;
  }

  // Render de Remotion: visuales + narración horneada, SIN bgm/sfx todavía
  // -- eso se mezcla después con FFmpeg (ver [5/5]). Va a una ruta temporal
  // propia (nunca la ve el usuario final) salvo que --out la pise del todo.
  const renderPath = path.join(projectRoot, "out", `.tmp-${baseName}.mp4`);

  console.log(`\nRenderizando...`);
  const result = spawnSync(process.execPath, [path.join(__dirname, "render.js"), guionPath, renderPath], {
    stdio: "inherit",
    cwd: projectRoot,
  });

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    return; // el render falló -- no tiene sentido mezclar audio ni armar nada más
  }

  console.log(`\n[5/5] BGM + SFX + carpeta final...`);

  const bgmTrack = pickRandom(listAudioFiles(path.join(publicDir, "assets", "audio", "bgm")));
  const sfxCues = buildSfxCues(segmentWindows, path.join(publicDir, "assets", "audio", "sfx"));
  console.log(
    `      BGM: ${bgmTrack ? path.basename(bgmTrack) : "(ninguna pista en assets/audio/bgm/)"} -- SFX: ${sfxCues.length} corte(s) de escena`
  );

  // --out pisa TODA la carpeta estructurada (para integraciones externas
  // que solo quieren el .mp4 en una ruta fija). Sin --out, la salida es
  // out/YYYY-MM-DD_<título>/{video.mp4, portada.png, metadata.txt}.
  let finalVideoPath;
  let projectFolder = null;
  if (args.out) {
    finalVideoPath = path.resolve(projectRoot, args.out);
    fs.mkdirSync(path.dirname(finalVideoPath), { recursive: true });
  } else {
    projectFolder = path.join(projectRoot, "out", `${todayIso()}_${slugify(title)}`);
    fs.mkdirSync(projectFolder, { recursive: true });
    finalVideoPath = path.join(projectFolder, "video.mp4");
  }

  if (bgmTrack || sfxCues.length > 0) {
    await mixAudio({
      videoPath: renderPath,
      narrationPath: audioFilePath,
      bgmPath: bgmTrack,
      sfxCues,
      outPath: finalVideoPath,
    });
  } else {
    fs.copyFileSync(renderPath, finalVideoPath);
  }
  fs.rmSync(renderPath, { force: true });
  console.log(`      Video: ${path.relative(projectRoot, finalVideoPath)}`);

  if (!projectFolder) {
    console.log(`\n✅ Listo: ${path.relative(projectRoot, finalVideoPath)}`);
    return; // --out: solo el .mp4, sin portada/metadata (comportamiento explícito de power-user)
  }

  const portadaPath = path.join(projectFolder, "portada.png");
  try {
    await generateThumbnail(finalVideoPath, portadaPath, audioDurationSeconds);
    console.log(`      Portada: ${path.relative(projectRoot, portadaPath)}`);
  } catch (err) {
    console.warn(`[ULTRON] No se pudo generar la portada (${err.message.split("\n")[0]}).`);
  }

  const metadataPath = path.join(projectFolder, "metadata.txt");
  writeMetadataTxt(buildMetadataTxt({ title, segments, channelName: channel?.name }), metadataPath);
  console.log(`      Metadata: ${path.relative(projectRoot, metadataPath)}`);

  console.log(`\n✅ Listo: ${path.relative(projectRoot, projectFolder)}/`);
}

main().catch((err) => {
  console.error(`\n[ULTRON] Error: ${err.message}`);
  // process.exitCode (no process.exit()) -- forzar la salida acá puede
  // crashear en Windows si todavía hay conexiones de red (fetch a
  // server.js) cerrando en segundo plano (visto en pruebas reales:
  // "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)"). exitCode
  // deja que el event loop drene solo antes de terminar.
  process.exitCode = 1;
});
