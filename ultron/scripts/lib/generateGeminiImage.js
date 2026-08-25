const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = path.join(__dirname, "..", "..", "..");
const BRIDGE_SCRIPT = path.join(__dirname, "..", "gemini_image_bridge.py");
const DEFAULT_SKILL_ROOT = path.join(PROJECT_ROOT, "image-generation-skill");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "output");
const DEFAULT_TIMEOUT_S = Number(process.env.GEMINI_IMAGE_TIMEOUT_S) || 90;

/** Sin GEMINI_API_KEY/GOOGLE_API_KEY configurada, ni lo intentamos. */
function isGeminiSkillConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
}

/**
 * Resuelve qué Python usar: el del venv que crea `uv venv` dentro del repo
 * clonado (image-generation-skill/.venv), si existe -- ahí es donde quedó
 * instalado google-genai (`uv pip install -e .`). Si no existe (todavía no
 * se corrió el setup, o GEMINI_SKILL_ROOT apunta a otro lado), cae a
 * GEMINI_SKILL_PYTHON o al "python" del PATH.
 */
function resolvePython() {
  if (process.env.GEMINI_SKILL_PYTHON) return process.env.GEMINI_SKILL_PYTHON;

  const skillRoot = process.env.GEMINI_SKILL_ROOT || DEFAULT_SKILL_ROOT;
  const venvPython = path.join(
    skillRoot,
    ".venv",
    process.platform === "win32" ? "Scripts/python.exe" : "bin/python"
  );
  if (fs.existsSync(venvPython)) return venvPython;

  return "python";
}

function randomOutPath() {
  const name = `gemini_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.png`;
  return path.join(DEFAULT_OUTPUT_DIR, name);
}

/**
 * Genera una imagen con Gemini a partir de un prompt, vía un subproceso
 * Python que habla con el SDK google-genai (ver scripts/gemini_image_bridge.py
 * para el detalle y las limitaciones de --seed). Devuelve la ruta absoluta
 * del archivo generado, o `null` si Gemini no está configurado o la
 * generación falla -- nunca tira una excepción, para que un fallo puntual no
 * tumbe el resto del flujo del llamador.
 *
 * @param {string} prompt descripción de la imagen a generar
 * @param {object} [options]
 * @param {string} [options.outPath] ruta donde guardar la imagen (default: output/gemini_<timestamp>.png)
 * @param {number} [options.seed] best-effort -- ver nota en gemini_image_bridge.py, no garantiza pixel a pixel
 * @param {string} [options.referenceImagePath] imagen previa para mantener consistencia visual (mecanismo real de continuidad de estos modelos)
 * @param {string} [options.aspectRatio] ej "16:9" | "9:16" | "1:1"
 * @param {string} [options.size] "1K" | "2K" (default "1K")
 * @param {string} [options.model] override del modelo (default: GEMINI_IMAGE_MODEL o gemini-3.1-flash-image-preview)
 * @returns {Promise<string|null>}
 */
async function generateGeminiImage(prompt, options = {}) {
  if (!isGeminiSkillConfigured()) return null;

  const outPath = options.outPath || randomOutPath();
  const pythonBin = resolvePython();

  const cliArgs = [BRIDGE_SCRIPT, "--prompt", prompt, "--out", outPath];
  if (options.seed !== undefined && options.seed !== null) cliArgs.push("--seed", String(options.seed));
  if (options.referenceImagePath) cliArgs.push("--reference", options.referenceImagePath);
  if (options.aspectRatio) cliArgs.push("--aspect-ratio", options.aspectRatio);
  if (options.size) cliArgs.push("--size", options.size);
  if (options.model) cliArgs.push("--model", options.model);

  try {
    const { stdout } = await execFileAsync(pythonBin, cliArgs, {
      timeout: (DEFAULT_TIMEOUT_S + 30) * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const lastLine = stdout.trim().split("\n").pop();
    const result = JSON.parse(lastLine);
    if (!result.ok) throw new Error(result.error);
    return result.file;
  } catch (err) {
    // Mismo patrón que generateBrolls.js: execFile con exit code != 0 tira un
    // error cuyo .stdout puede tener igual el JSON {"ok":false,...} -- vale
    // la pena intentar parsearlo para un mensaje más claro.
    let message = err.message.split("\n")[0];
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout.trim().split("\n").pop());
        if (parsed.error) message = parsed.error;
      } catch {
        // stdout no era el JSON esperado -- nos quedamos con el mensaje genérico
      }
    }
    console.warn(`[Gemini] No se generó la imagen ("${prompt.slice(0, 60)}..."): ${message}`);
    return null;
  }
}

module.exports = { generateGeminiImage, isGeminiSkillConfigured };
