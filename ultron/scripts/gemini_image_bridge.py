#!/usr/bin/env python3
"""
Puente Node -> Gemini: genera UNA imagen a partir de un prompt usando el SDK
google-genai (la misma dependencia que instala el repo vendorizado
image-generation-skill/ en la raiz del proyecto). Comunica el resultado a
Node via una sola linea de JSON en stdout ({"ok": true, "file": ...} o
{"ok": false, "error": ...}) -- mismo contrato que wan2gp_bridge.py.

Por que no llamar directo al CLI `generate-image` del repo clonado
(image-generation-skill/scripts/generate-image): su funcion generate() (ver
image-generation-skill/src/image_generation_skill/core.py, _generate_gemini)
arma el GenerateContentConfig SIN seed= -- no hay forma de pedirle
reproducibilidad por ese camino. Este bridge llama al SDK google-genai
directo (la misma libreria que ya usa ese repo) replicando esa misma
funcion, agregando --seed y --reference. Verificado en vivo (2026-08-24):
con una API key invalida a proposito, el request llega hasta
generativelanguage.googleapis.com y responde 400 API_KEY_INVALID -- confirma
que la construccion de Part/ImageConfig/GenerateContentConfig de aca abajo
esta bien formada para el SDK instalado (google-genai==1.75.0), aunque no
hubo una key real disponible para probar la generacion en si.

IMPORTANTE sobre --seed: el SDK documenta `seed` (GenerateContentConfig.seed)
como "best effort" -- sesga la generacion hacia un resultado similar, pero
Google NO lo garantiza bit a bit para salida de IMAGEN (a diferencia de
motores tipo Stable Diffusion, donde el mismo seed = mismo pixel a pixel).
Para consistencia visual real entre generaciones (mismo personaje/estilo),
combinar con --reference pasando una imagen previa -- el mecanismo que si
esta documentado y sostenido por estos modelos ("nano banana").

Uso:
  python gemini_image_bridge.py --prompt "..." --out img.jpg [--seed 42]
    [--reference previa.jpg] [--aspect-ratio 9:16] [--size 1K]
    [--model gemini-3.1-flash-image-preview]
"""
import argparse
import json
import mimetypes
import os
import sys
from pathlib import Path


def fail(message):
    print(json.dumps({"ok": False, "error": message}))
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--out", required=True, help="Ruta del archivo de imagen a escribir")
    parser.add_argument("--seed", type=int, default=None, help="Best-effort -- ver nota sobre --seed arriba")
    parser.add_argument("--reference", default=None, help="Imagen existente para mantener consistencia visual")
    parser.add_argument("--aspect-ratio", dest="aspect_ratio", default=None, help='Ej: "16:9", "9:16", "1:1"')
    parser.add_argument("--size", default="1K", help='"1K" | "2K" (ver docs de Gemini)')
    parser.add_argument("--model", default=None)
    args = parser.parse_args()

    try:
        from google import genai
        from google.genai import types
    except ImportError as e:
        fail(
            "No se pudo importar google-genai -- ¿corriste esto con el Python del venv de "
            f"image-generation-skill/.venv? ({e})"
        )
        return

    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        fail("Falta GEMINI_API_KEY (o GOOGLE_API_KEY) en el entorno")
        return

    model = args.model or os.environ.get("GEMINI_IMAGE_MODEL") or "gemini-3.1-flash-image-preview"

    try:
        client = genai.Client(api_key=api_key)

        parts = [types.Part.from_text(text=args.prompt)]
        if args.reference:
            ref_path = Path(args.reference).expanduser()
            if not ref_path.exists():
                fail(f"--reference no existe: {ref_path}")
                return
            mime, _ = mimetypes.guess_type(str(ref_path))
            parts.append(types.Part.from_bytes(data=ref_path.read_bytes(), mime_type=mime or "image/png"))

        image_config_kwargs = {"image_size": args.size}
        if args.aspect_ratio:
            image_config_kwargs["aspect_ratio"] = args.aspect_ratio
        image_config = types.ImageConfig(**image_config_kwargs)

        config_kwargs = {"response_modalities": ["IMAGE", "TEXT"], "image_config": image_config}
        if args.seed is not None:
            config_kwargs["seed"] = args.seed
        config = types.GenerateContentConfig(**config_kwargs)

        contents = {"role": "user", "parts": parts}

        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)

        saved = False
        for chunk in client.models.generate_content_stream(model=model, contents=contents, config=config):
            candidates = chunk.candidates or ()
            candidate = candidates[0] if candidates else None
            content = candidate.content if candidate else None
            chunk_parts = content.parts if content and content.parts else ()

            for part in chunk_parts:
                inline = getattr(part, "inline_data", None)
                if inline and inline.data:
                    out_path.write_bytes(inline.data)
                    saved = True
                    break
            if saved:
                break

        if not saved:
            fail("Gemini no devolvio ninguna imagen para este prompt (puede haber bloqueado el contenido por politica)")
            return

        print(json.dumps({"ok": True, "file": str(out_path)}))
    except Exception as e:  # nunca un traceback crudo -- Node espera JSON en stdout
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
