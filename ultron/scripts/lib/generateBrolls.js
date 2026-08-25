const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);

const BRIDGE_SCRIPT = path.join(__dirname, "..", "wan2gp_bridge.py");
const DEFAULT_TIMEOUT_S = Number(process.env.WAN2GP_TIMEOUT_S) || 300;

/** Sin WAN2GP_ROOT configurado, este paso ni se intenta -- no rompe nada. */
function isWan2GpConfigured() {
  return Boolean(process.env.WAN2GP_ROOT);
}

/**
 * Genera UN clip de B-roll con Wan2GP para un prompt puntual, vía un
 * subproceso Python que habla con el SDK real de Wan2GP (ver
 * scripts/wan2gp_bridge.py). Devuelve la ruta del .mp4 generado, o `null`
 * si Wan2GP no está configurado/disponible o la generación falla -- nunca
 * tira una excepción hacia arriba, el llamador (selectBackground.js) decide
 * cómo seguir (fallback a imágenes IA).
 *
 * NO VERIFICADO end-to-end (ver nota en wan2gp_bridge.py) -- no hubo una
 * instalación real de Wan2GP disponible en este entorno para probarlo en
 * vivo. El contrato sigue al pie de la letra la única documentación
 * confirmada del proyecto.
 *
 * @param {string} prompt descripción visual de la escena (en inglés, mismo
 *   campo image_prompt que ya usa selectBackground.js para imágenes)
 * @param {{durationSeconds: number, outPath: string}} options
 * @returns {Promise<string|null>}
 */
async function generateBroll(prompt, { durationSeconds, outPath }) {
  if (!isWan2GpConfigured()) return null;

  const pythonBin = process.env.WAN2GP_PYTHON || "python";
  const root = process.env.WAN2GP_ROOT;

  try {
    const { stdout } = await execFileAsync(
      pythonBin,
      [
        BRIDGE_SCRIPT,
        "--root",
        root,
        "--prompt",
        prompt,
        "--duration",
        String(durationSeconds),
        "--out",
        outPath,
        "--timeout",
        String(DEFAULT_TIMEOUT_S),
      ],
      { timeout: (DEFAULT_TIMEOUT_S + 30) * 1000 }
    );

    const lastLine = stdout.trim().split("\n").pop();
    const result = JSON.parse(lastLine);
    if (!result.ok) throw new Error(result.error);
    return result.file;
  } catch (err) {
    // execFile con proceso que sale con código != 0 tira un error cuyo
    // .stdout puede tener igual el JSON {"ok":false,...} -- intentar
    // parsearlo para un mensaje más claro antes de resignarse al genérico.
    let message = err.message.split("\n")[0];
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.trim().split("\n").pop());
        if (parsed.error) message = parsed.error;
      } catch {
        // stdout no era el JSON esperado -- nos quedamos con el mensaje genérico
      }
    }
    console.warn(`[ULTRON] Wan2GP no generó el B-roll ("${prompt.slice(0, 60)}..."): ${message}`);
    return null;
  }
}

module.exports = { generateBroll, isWan2GpConfigured };
