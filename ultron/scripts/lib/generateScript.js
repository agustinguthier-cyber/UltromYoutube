const { postJson } = require("./httpJson");

const MIN_SEGMENTS = 5;
const MAX_SEGMENTS = 7;

/**
 * Reusa /api/generate-script del servidor de UltromYoutube (proyecto padre)
 * en modo "prompt libre" ({message, maxTokens}) -- ya trae resuelto el
 * orquestado primario/fallback/reintento de proveedores LLM (ver CLAUDE.md),
 * no hace falta duplicar esa lógica acá.
 *
 * El requisito de cantidad de segmentos está repetido a propósito (arriba
 * de todo Y al final -- primacía y recencia) y el ejemplo del JSON tiene 6
 * segmentos con contenido real, no placeholders vacíos -- probado que un
 * modelo chico (llama-3.1-8b-instruct) copia mejor la FORMA de un ejemplo
 * concreto que una regla abstracta en prosa (ver nota en
 * warnIfScriptDoesNotMatchRules). Aun así esto es best-effort -- la garantía
 * real de cantidad la da el reintento en generateScript(), no el prompt.
 *
 * channelContext (opcional, ver loadChannel.js) inyecta el tono y la guía de
 * estilo visual de un canal real de channels_data.json -- si viene, tanto
 * "text" como cada "image_prompt" tienen que respetarlo.
 */
const promptTemplate = (tema, channelContext) => `Sos un guionista de videos faceless de YouTube en español, estilo canales de datos curiosos / listas rápidas.

REQUISITO NO NEGOCIABLE ANTES QUE NADA: el array "segments" tiene que tener ENTRE 5 Y 7 elementos, NUNCA menos de 5. Si se te ocurren solo 3 o 4 datos, seguí pensando hasta tener al menos 5.
${
  channelContext
    ? `
CONTEXTO DE CANAL -- OBLIGATORIO seguir esto para "text" y para cada "image_prompt":
- Nicho: ${channelContext.nicho || "-"}
- Tono narrativo: ${channelContext.tono || "-"}
${channelContext.styleBase ? `- Estilo visual (usalo como base de CADA "image_prompt", en inglés, sumado a lo específico de esa escena): ${channelContext.styleBase}` : ""}
`
    : ""
}
Tema: "${tema}"

Devolvé ÚNICAMENTE un JSON válido (sin texto extra, sin markdown, sin \`\`\`). Este ejemplo tiene 6 segmentos -- tu respuesta tiene que tener una cantidad similar (5, 6 o 7), nunca menos:
{
  "title": "título corto y llamativo para mostrar en pantalla (máx 8 palabras)",
  "segments": [
    { "text": "Primer dato corto, una sola oración.", "keywords": ["space", "galaxy"], "image_prompt": "cinematic wide shot of a galaxy in deep space, dramatic lighting, no text, no people" },
    { "text": "Segundo dato corto, una sola oración.", "keywords": ["black hole"], "image_prompt": "hyperrealistic black hole bending light, dark cosmic background, no text, no people" },
    { "text": "Tercer dato corto, una sola oración.", "keywords": ["star", "explosion"], "image_prompt": "a massive star collapsing in space, cinematic lighting, no text, no people" },
    { "text": "Cuarto dato corto, una sola oración.", "keywords": ["event horizon"], "image_prompt": "light bending around an event horizon, cinematic, no text, no people" },
    { "text": "Quinto dato corto, una sola oración.", "keywords": ["universe"], "image_prompt": "a vast starfield with nebulae, cinematic wide shot, no text, no people" },
    { "text": "Sexto dato, cierre breve.", "keywords": ["cosmos"], "image_prompt": "deep space cosmic scene, cinematic lighting, no text, no people" }
  ]
}

Reglas OBLIGATORIAS -- no las incumplas:

1. CANTIDAD DE SEGMENTOS: entre 5 y 7 (nunca menos de 5, nunca más de 7). Preferí varios segmentos CORTOS (una sola oración cada uno) antes que pocos segmentos largos -- más cortes = más ritmo visual, cada segmento es una imagen distinta en el video final.
2. DURACIÓN: todos los "text" concatenados, leídos en voz alta a ritmo normal, tienen que sumar entre 30 y 40 segundos de locución -- aproximadamente 90 a 110 palabras en total, repartidas en esos 5-7 segmentos cortos.
3. IDIOMA DEL TEXTO: "text" va SIEMPRE en español, sin numerar, sin encabezados, sin emojis -- debe leerse como un guion narrado natural y fluido.
4. IDIOMA DE LAS KEYWORDS: "keywords" va SIEMPRE en inglés, sin excepción, aunque "text" esté en español.
   - Correcto: "keywords": ["space", "galaxy"]
   - INCORRECTO (nunca hagas esto): "keywords": ["espacio", "galaxia"]
5. Cada "keywords" tiene 2 a 4 términos en inglés, pensados para buscar video stock (B-roll) que ilustre ESE segmento puntual.
6. IDIOMA DEL image_prompt: SIEMPRE en inglés, una frase visual concreta y detallada de UNA sola escena que ilustre este segmento puntual, para generarla con un modelo de imágenes IA.${
  channelContext?.styleBase
    ? " Tiene que incluir el estilo visual del canal (ver CONTEXTO DE CANAL arriba), no un estilo genérico."
    : " Estilo cinematográfico/fotorrealista."
} Nunca pidas texto, letras, logos ni marcas de agua dentro de la imagen. Evitá caras de personas reconocibles o famosas (mejor paisajes, objetos, fenómenos, escenas generales) -- es contenido faceless.

RECORDATORIO FINAL: contá los elementos de "segments" antes de responder. Tiene que haber 5, 6 o 7. Ni 3, ni 4, ni 8 o más.`;

function extractJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`El LLM no devolvió JSON reconocible:\n${text.slice(0, 300)}`);
  }
  return JSON.parse(text.slice(start, end + 1));
}

// Heurística simple (no un detector de idioma real): marca una keyword como
// "probablemente en español" si tiene tildes/ñ/signos propios del español.
// Solo se usa para el warning de abajo, nunca para bloquear el pipeline --
// modelos chicos (ej. llama-3.1-8b-instruct) a veces ignoran esta regla del
// prompt, mejor avisar que fallar en silencio.
//
// Nota (probado 2026-08-20): incluso con esta regla reforzada y ejemplos
// correcto/incorrecto explícitos en el prompt, llama-3.1-8b-instruct sigue
// devolviendo la mayoría de las keywords en español (~14 de 15 en la
// prueba real) -- limitación real del modelo, no del prompt. Ademas esta
// regex solo agarra palabras CON tilde/ñ, así que subestima el problema
// (deja pasar cosas como "estrellas" o "espacio"). Decisión consciente: no
// vale la pena invertir más en esto ahora porque selectBackground.js no usa
// "keywords" para nada -- retomar si hace falta más adelante (traducción
// automática, o swap de modelo puntual para ese campo).
const SPANISH_CHARS = /[áéíóúñ¿¡]/i;

function warnIfScriptDoesNotMatchRules(parsed) {
  const count = parsed.segments.length;
  if (count < MIN_SEGMENTS || count > MAX_SEGMENTS) {
    console.warn(
      `[ULTRON] El LLM devolvió ${count} segmentos (se pidieron ${MIN_SEGMENTS}-${MAX_SEGMENTS}). El video puede salir más corto/largo de lo esperado.`
    );
  }

  const sospechosas = parsed.segments
    .flatMap((s) => s.keywords || [])
    .filter((k) => SPANISH_CHARS.test(k));
  if (sospechosas.length > 0) {
    console.warn(
      `[ULTRON] Algunas keywords parecen estar en español, no en inglés: ${JSON.stringify(sospechosas)}`
    );
  }

  const sinImagePrompt = parsed.segments.filter((s) => !s.image_prompt).length;
  if (sinImagePrompt > 0) {
    console.warn(
      `[ULTRON] ${sinImagePrompt}/${parsed.segments.length} segmentos no trajeron "image_prompt" -- esas escenas van a quedar sin imagen generada.`
    );
  }
}

function isSegmentCountInRange(parsed) {
  return parsed.segments.length >= MIN_SEGMENTS && parsed.segments.length <= MAX_SEGMENTS;
}

// Qué tan lejos está la cantidad de segmentos del rango pedido -- 0 si ya
// está adentro. Se usa para quedarse con el "menos peor" de los intentos
// fallidos si ninguno cae en rango (ver generateScript()).
function distanceFromRange(parsed) {
  const count = parsed.segments.length;
  if (count < MIN_SEGMENTS) return MIN_SEGMENTS - count;
  if (count > MAX_SEGMENTS) return count - MAX_SEGMENTS;
  return 0;
}

async function generateScriptOnce(prompt, serverUrl, channelContext) {
  const { script } = await postJson(`${serverUrl}/api/generate-script`, {
    message: promptTemplate(prompt, channelContext),
    maxTokens: 1500,
  });

  const parsed = extractJson(script);
  if (!parsed.title || !Array.isArray(parsed.segments) || parsed.segments.length === 0) {
    throw new Error(`JSON del guion incompleto: ${JSON.stringify(parsed).slice(0, 300)}`);
  }
  return parsed;
}

const MAX_ATTEMPTS = 4;

/**
 * Con temperature=0.9 y un modelo chico (ver CLAUDE.md), el LLM a veces
 * devuelve JSON mal formado, y a veces devuelve menos de MIN_SEGMENTS
 * segmentos pese al prompt (probado en vivo: 3 en vez de 5-7). Se reintenta
 * en ambos casos -- la cantidad de segmentos NO es solo una preferencia de
 * prompt, es una condición que este código verifica y por la que reintenta.
 *
 * Si ningún intento cae en rango (mala suerte con MAX_ATTEMPTS reintentos),
 * no tira el pipeline entero: sigue con el intento más CERCANO al rango
 * pedido en vez de siempre quedarse con el último al azar.
 *
 * @param {{serverUrl: string, channelContext?: {nicho?: string, tono?: string, styleBase?: string}}} options
 * @returns {Promise<{title: string, segments: {text: string, keywords: string[], image_prompt?: string}[]}>}
 */
async function generateScript(prompt, { serverUrl, channelContext }) {
  let lastError;
  let bestAttempt = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const parsed = await generateScriptOnce(prompt, serverUrl, channelContext);

      if (isSegmentCountInRange(parsed)) {
        warnIfScriptDoesNotMatchRules(parsed);
        return parsed;
      }

      if (!bestAttempt || distanceFromRange(parsed) < distanceFromRange(bestAttempt)) {
        bestAttempt = parsed;
      }
      console.warn(
        `[ULTRON] Intento ${attempt}/${MAX_ATTEMPTS}: ${parsed.segments.length} segmentos (se pidieron ${MIN_SEGMENTS}-${MAX_SEGMENTS}).${attempt < MAX_ATTEMPTS ? " Reintentando..." : ""}`
      );
    } catch (err) {
      lastError = err;
      console.warn(
        `[ULTRON] Intento ${attempt}/${MAX_ATTEMPTS} de generar guion falló (${err.message.split("\n")[0]}).${attempt < MAX_ATTEMPTS ? " Reintentando..." : ""}`
      );
    }
  }

  if (bestAttempt) {
    console.warn(
      `[ULTRON] Ningún intento cayó en el rango ${MIN_SEGMENTS}-${MAX_SEGMENTS} tras ${MAX_ATTEMPTS} intentos -- sigo con el más cercano (${bestAttempt.segments.length} segmentos).`
    );
    warnIfScriptDoesNotMatchRules(bestAttempt);
    return bestAttempt;
  }

  throw new Error(`No se pudo generar un guion válido tras ${MAX_ATTEMPTS} intentos: ${lastError.message}`);
}

module.exports = { generateScript, extractJson, promptTemplate };
