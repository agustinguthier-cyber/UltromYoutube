const fs = require("node:fs");
const path = require("node:path");
const { generateImage } = require("./generateImage");
const { generateBroll, isWan2GpConfigured } = require("./generateBrolls");

function detectImageExtension(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "png";
  return "jpg";
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DISABLED_PROVIDERS = new Set(["none", "off", "disabled"]);
const RETRY_DELAY_MS = 1500;

/**
 * Una imagen por prompt, con UN reintento rápido si el primer intento falla
 * (timeout, error del proveedor, etc.) -- antes de resignarse a dejarle el
 * hueco a la escena. Devuelve null si los dos intentos fallan (lo resuelve
 * selectBackground() reutilizando otra escena, ver más abajo).
 */
async function generateImageWithRetry(prompt, label) {
  try {
    return await generateImage(prompt);
  } catch (err) {
    console.warn(
      `[ULTRON] ${label}: primer intento falló (${err.message.split("\n")[0]}) -- reintentando...`
    );
  }

  await sleep(RETRY_DELAY_MS);

  try {
    return await generateImage(prompt);
  } catch (err) {
    console.warn(`[ULTRON] ${label}: el reintento también falló (${err.message.split("\n")[0]}).`);
    return null;
  }
}

/**
 * Resuelve el fondo de UNA escena: primero intenta un clip de video real
 * con Wan2GP (si WAN2GP_ROOT está configurado -- ver generateBrolls.js),
 * y si no está disponible o falla, cae a una imagen IA (con su propio
 * reintento). Devuelve `{ image }`, `{ video }` o `{}` (ninguna de las dos
 * funcionó) -- nunca tira, el llamador decide cómo seguir.
 */
async function resolveSceneMedia(seg, label, { brollsDir, scenesDir, index }) {
  if (!seg.image_prompt) {
    console.warn(`[ULTRON] ${label}: sin "image_prompt".`);
    return {};
  }

  if (isWan2GpConfigured()) {
    const outPath = path.join(brollsDir, `scene-${index + 1}-${Date.now()}.mp4`);
    const file = await generateBroll(seg.image_prompt, {
      durationSeconds: Math.max(0.5, seg.end - seg.start),
      outPath,
    });
    if (file) {
      console.log(`[ULTRON] ${label}: B-roll generado con Wan2GP (${path.basename(file)}).`);
      return { video: `assets/brolls/${path.basename(file)}` };
    }
    console.warn(`[ULTRON] ${label}: Wan2GP no dio un clip -- caigo a imagen IA.`);
  }

  const buffer = await generateImageWithRetry(seg.image_prompt, label);
  if (!buffer) return {};

  const ext = detectImageExtension(buffer);
  const fileName = `scene-${index + 1}-${Date.now()}.${ext}`;
  fs.writeFileSync(path.join(scenesDir, fileName), buffer);
  console.log(`[ULTRON] ${label}: imagen generada (${fileName}).`);
  return { image: `scenes/${fileName}` };
}

/**
 * Arma `{ type: "scenes", scenes: [...] }` compatible con backgroundSchema
 * (src/schema.ts) -- un clip de Wan2GP, o si no, una imagen IA con Ken
 * Burns, por cada ventana [start, end] de segmentWindows (la arma
 * alignTimestamps.js).
 *
 * Wan2GP (opcional, ver generateBrolls.js): con WAN2GP_ROOT configurado,
 * cada escena intenta primero un B-roll de video real. Sin eso configurado
 * -- o si Wan2GP falla para una escena puntual -- cae directo a la
 * generación de imágenes (IMAGE_PROVIDER, default Pollinations.ai, gratis,
 * sin API key). Para desactivar TODO este paso (fondo negro sólido, cero
 * llamadas de red) poné IMAGE_PROVIDER=none (o "off"/"disabled").
 *
 * "Cero fondos negros": si una escena no consigue ni video ni imagen, NO
 * queda un hueco -- se rellena reutilizando el fondo de la escena exitosa
 * más cercana (primero mirando hacia atrás; si falló la primera escena y no
 * hay ninguna anterior, mira hacia adelante). Cada escena reutilizada sigue
 * siendo su propia <Sequence> en Remotion. El negro sólido queda como
 * último recurso solo si TODAS las escenas del video fallan.
 *
 * @param {Array<{start:number, end:number, text:string, image_prompt?:string}>} segmentWindows
 * @param {{ publicDir: string }} options ruta absoluta a ultron/public
 * @returns {Promise<{type:"scenes", scenes: Array<object>}|undefined>}
 */
async function selectBackground(segmentWindows, { publicDir }) {
  const provider = (process.env.IMAGE_PROVIDER || "pollinations").toLowerCase();
  const imagesDisabled = DISABLED_PROVIDERS.has(provider);
  if (imagesDisabled && !isWan2GpConfigured()) {
    return undefined;
  }

  const scenesDir = path.join(publicDir, "scenes");
  const brollsDir = path.join(publicDir, "assets", "brolls");
  fs.mkdirSync(scenesDir, { recursive: true });
  fs.mkdirSync(brollsDir, { recursive: true });

  // Paso 1: un intento por segmento (Wan2GP -> imagen IA). {} marca las que
  // fallaron -- se rellenan en el paso 2, no se descartan todavía.
  const results = [];
  for (let i = 0; i < segmentWindows.length; i++) {
    const seg = segmentWindows[i];
    const label = `Escena ${i + 1}/${segmentWindows.length}`;
    const media = await resolveSceneMedia(seg, label, { brollsDir, scenesDir, index: i });
    results.push({ start: seg.start, end: seg.end, ...media });
  }

  // Paso 2: rellenar huecos reutilizando el fondo de la escena exitosa más cercana.
  const hasMedia = (r) => Boolean(r.image || r.video);
  for (let i = 0; i < results.length; i++) {
    if (hasMedia(results[i])) continue;

    let reused = null;
    for (let j = i - 1; j >= 0; j--) {
      if (hasMedia(results[j])) {
        reused = results[j];
        break;
      }
    }
    if (!reused) {
      reused = results.slice(i + 1).find(hasMedia) || null;
    }

    if (reused) {
      if (reused.video) results[i].video = reused.video;
      else results[i].image = reused.image;
      console.warn(
        `[ULTRON] Escena ${i + 1}/${results.length}: sin fondo propio -- reutilizo el de otra escena en vez de dejarla en negro.`
      );
    }
  }

  const scenes = results.filter(hasMedia).map((r) =>
    r.video ? { start: r.start, end: r.end, video: r.video } : { start: r.start, end: r.end, image: r.image }
  );

  // Último recurso: ninguna escena del video consiguió fondo -- no hay nada
  // que reutilizar, cae al fondo negro sólido default (no rompe el pipeline).
  if (scenes.length === 0) return undefined;
  return { type: "scenes", scenes };
}

// generateImageWithRetry tambien se reusa desde el proyecto padre (server.js,
// /api/generate-scene-media) para no duplicar el mismo reintento con backoff.
module.exports = { selectBackground, generateImageWithRetry };
