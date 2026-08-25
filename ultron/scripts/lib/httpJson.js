/**
 * Helpers mínimos para hablarle a las rutas /api/* del servidor de
 * UltromYoutube (proyecto padre) -- generate-video.js reusa ese servidor en
 * vez de reimplementar clientes de LLM/TTS acá adentro.
 */

async function postJson(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} ${res.statusText} (${url})`);
  }
  return data;
}

async function getJson(url) {
  const res = await fetch(url);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `HTTP ${res.status} ${res.statusText} (${url})`);
  }
  return data;
}

module.exports = { postJson, getJson };
