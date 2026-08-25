/**
 * Cliente de generación de imágenes por IA (paso 4, escenas). Proveedor
 * elegido por la env var IMAGE_PROVIDER: "pollinations" (default) | "nvidia"
 * | "skyreels" | "none"/"off" (deshabilita el paso, ver selectBackground.js).
 *
 * - pollinations (DEFAULT, 2026-08-21): https://pollinations.ai -- servicio
 *   gratuito, SIN API key, HTTP GET directo (`image.pollinations.ai/prompt/
 *   <prompt>`), devuelve la imagen ya renderizada (JPEG). Elegido después de
 *   evaluar en vivo: NVIDIA flux.1-schnell no respondía (ver nota abajo) y
 *   Fal.ai/servicios pagos exigen una API key que no tenemos todavía --
 *   Pollinations es la única opción 100% automatizable YA MISMO sin
 *   bloquear el pipeline esperando credenciales. Probado en vivo: ~2-3s por
 *   imagen, calidad cinematográfica razonable, sin watermark (nologo=true).
 *   Es un servicio gratuito comunitario sin SLA -- si en el futuro hace
 *   falta más calidad/consistencia garantizada, Fal.ai (FLUX vía API paga)
 *   es el upgrade natural, mismo shape de función.
 *
 * - nvidia: NVIDIA NIM, modelo black-forest-labs/flux.1-schnell. Contrato
 *   verificado contra la documentación oficial de NVIDIA (build.nvidia.com /
 *   docs.api.nvidia.com), NO es el mismo endpoint OpenAI-compatible que usa
 *   generateScript.js -- este es el endpoint de "Cloud Functions" de NVIDIA
 *   (ai.api.nvidia.com/v1/genai/...), con su propio formato de request/
 *   response. Probado en vivo (2026-08-20) con la LLM_API_KEY del proyecto:
 *   la conexión TCP/TLS se establece pero el servidor nunca responde (0
 *   bytes en 90s, dos intentos) -- probablemente esta cuenta no tiene
 *   habilitado el entitlement de NVCF para modelos de imagen (es un producto
 *   separado de los NIM de chat). Se deja implementado por si se habilita
 *   ese entitlement más adelante.
 *
 * - skyreels: servidor local propio, sin contrato público documentado --
 *   mismo enfoque best-effort que el resto de proveedores locales de este
 *   proyecto: se asume el esquema más común (POST {prompt,width,height} ->
 *   bytes de imagen o JSON con base64/url). Ajustar acá si el servidor real
 *   devuelve otra cosa.
 *
 * Cualquiera sea el proveedor, si falla (timeout, error, respuesta rara)
 * selectBackground.js lo trata como "sin imagen" para ese segmento puntual
 * -- nunca rompe el pipeline completo por una escena.
 */

const IMAGE_TIMEOUT_MS = Number(process.env.IMAGE_TIMEOUT_MS) || 45000;

// 768x1344 ~= 9:16 -- la resolución vertical soportada por flux.1-schnell
// más cercana al 1080x1920 real del video; se reusa igual para los demás
// proveedores por consistencia (Remotion la recorta a cover de todas formas).
const IMAGE_WIDTH = 768;
const IMAGE_HEIGHT = 1344;

const POLLINATIONS_ENDPOINT = "https://image.pollinations.ai/prompt";

async function generateImagePollinations(prompt) {
  const seed = Math.floor(Math.random() * 1_000_000);
  const url = `${POLLINATIONS_ENDPOINT}/${encodeURIComponent(prompt)}?width=${IMAGE_WIDTH}&height=${IMAGE_HEIGHT}&nologo=true&seed=${seed}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Pollinations: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  // Una imagen real de este tamaño no baja de unos pocos KB -- si viene mas
  // chica, probablemente es un placeholder de error, no una foto real.
  if (buffer.length < 1000) {
    throw new Error(`Pollinations: respuesta sospechosamente chica (${buffer.length} bytes)`);
  }
  return buffer;
}

async function generateImageNvidiaFlux(prompt) {
  const endpoint = "https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-schnell";
  const apiKey = process.env.NVIDIA_IMAGE_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error(
      "IMAGE_PROVIDER=nvidia pero no hay NVIDIA_IMAGE_API_KEY ni LLM_API_KEY configurada (ver ultron/.env)."
    );
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      prompt,
      width: IMAGE_WIDTH,
      height: IMAGE_HEIGHT,
      steps: 4,
      seed: 0,
    }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`NVIDIA flux.1-schnell: HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const artifact = data.artifacts?.[0];
  if (!artifact?.base64) {
    throw new Error(`NVIDIA flux.1-schnell: respuesta sin imagen: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return Buffer.from(artifact.base64, "base64");
}

async function generateImageSkyReels(prompt) {
  const baseUrl = (process.env.SKYREELS_URL || "http://localhost:8000").replace(/\/+$/, "");

  const res = await fetch(`${baseUrl}/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, width: IMAGE_WIDTH, height: IMAGE_HEIGHT }),
    signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SkyReels (${baseUrl}): HTTP ${res.status} ${text.slice(0, 300)}`);
  }

  const contentType = res.headers.get("content-type") || "";
  if (contentType.startsWith("image/")) {
    return Buffer.from(await res.arrayBuffer());
  }

  const data = await res.json();
  const base64 = data.image || data.base64 || data.images?.[0];
  if (!base64) {
    throw new Error(`SkyReels: respuesta sin imagen reconocible: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return Buffer.from(base64, "base64");
}

/**
 * @returns {Promise<Buffer>} bytes de la imagen generada (JPEG/PNG)
 * @throws si el proveedor falla o no es reconocido
 */
async function generateImage(prompt) {
  const provider = (process.env.IMAGE_PROVIDER || "pollinations").toLowerCase();
  if (provider === "pollinations") return generateImagePollinations(prompt);
  if (provider === "nvidia") return generateImageNvidiaFlux(prompt);
  if (provider === "skyreels") return generateImageSkyReels(prompt);
  throw new Error(
    `IMAGE_PROVIDER desconocido ("${provider}"). Valores válidos: "pollinations" | "nvidia" | "skyreels" | "none"/"off".`
  );
}

module.exports = { generateImage };
