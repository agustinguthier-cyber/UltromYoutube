#!/usr/bin/env node

/**
 * Wrapper de producción sobre el CLI de Remotion: recibe la ruta a un
 * guion.json arbitrario (no tiene que vivir en /public, solo los assets que
 * referencia -- audio/background -- sí) y renderiza VerticalVideo con él.
 *
 * La validación del contenido (título, captions, background, etc.) la hace
 * el propio CLI de Remotion contra el `schema` de la composición -- no se
 * duplica esa lógica acá.
 *
 * Uso:
 *   node scripts/render.js [ruta/a/guion.json] [ruta/de/salida.mp4]
 *
 * Sin argumentos, usa public/guion.json como entrada de ejemplo.
 */

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const projectRoot = path.resolve(__dirname, "..");

const guionPathArg = process.argv[2] ?? "public/guion.json";
const outputArg = process.argv[3];

const guionPath = path.resolve(projectRoot, guionPathArg);

if (!fs.existsSync(guionPath)) {
  console.error(`No se encontró el archivo de guion: ${guionPath}`);
  process.exit(1);
}

const baseName = path.basename(guionPath, path.extname(guionPath));
const output = outputArg
  ? path.resolve(projectRoot, outputArg)
  : path.resolve(projectRoot, "out", `${baseName}.mp4`);

fs.mkdirSync(path.dirname(output), { recursive: true });

console.log(`Guion:  ${guionPath}`);
console.log(`Salida: ${output}\n`);

const result = spawnSync(
  "npx",
  ["remotion", "render", "VerticalVideo", output, `--props=${guionPath}`],
  { stdio: "inherit", cwd: projectRoot, shell: process.platform === "win32" }
);

if (result.error) {
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? 1);
