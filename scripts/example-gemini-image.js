#!/usr/bin/env node
/**
 * Ejemplo de uso de generateGeminiImage(). Requiere GEMINI_API_KEY (ver
 * ultron/.env.example) y el setup de image-generation-skill/ (ver
 * CLAUDE.md, sección Gemini / image-generation-skill).
 *
 * Uso:
 *   node scripts/example-gemini-image.js
 */
const fs = require("fs");
const path = require("path");

function loadEnvFile(envPath) {
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, "..", ".env"));
loadEnvFile(path.join(__dirname, "..", "ultron", ".env"));

const { generateGeminiImage, isGeminiSkillConfigured } = require("../ultron/scripts/lib/generateGeminiImage.js");

async function main() {
  if (!isGeminiSkillConfigured()) {
    console.error(
      "Falta GEMINI_API_KEY (o GOOGLE_API_KEY). Configurala en ultron/.env o como variable de entorno del sistema."
    );
    process.exitCode = 1;
    return;
  }

  const prompt = "un paisaje futurista con montañas flotantes";
  console.log(`Generando imagen para: "${prompt}"...`);

  const filePath = await generateGeminiImage(prompt, {
    // Mismo seed => Gemini intenta (best-effort) un resultado parecido entre
    // corridas; no es determinístico pixel a pixel (ver gemini_image_bridge.py).
    seed: 42,
    aspectRatio: "16:9",
  });

  if (!filePath) {
    console.error("No se pudo generar la imagen (ver el warning \"[Gemini] ...\" de arriba para el detalle).");
    process.exitCode = 1;
    return;
  }

  console.log(`Imagen guardada en: ${filePath}`);
}

main();
