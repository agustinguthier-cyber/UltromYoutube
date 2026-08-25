#!/usr/bin/env python3
"""
Puente Node -> Wan2GP: recibe un prompt + duracion por linea de comando,
usa el SDK in-process real de Wan2GP (shared/api.py) para generar un clip de
video, y copia el resultado a --out. Comunica el resultado a Node via una
sola linea de JSON en stdout ({"ok": true, "file": ...} o {"ok": false,
"error": ...}).

NO VERIFICADO end-to-end -- no hubo una instalacion real de Wan2GP
disponible en este entorno para probarlo en vivo. El shape de "settings" y
el flujo de submit_task/events/result siguen al pie de la letra el unico
ejemplo documentado que se pudo confirmar via su docs/API.md
(https://github.com/deepbeepmeep/Wan2GP). Si tu instalacion real espera
otro "model_type" u otros parametros, ese es el lugar para ajustar
(construccion de SETTINGS mas abajo).

Uso:
  python wan2gp_bridge.py --root "C:\\WanGP" --prompt "..." --duration 4 --out clip.mp4
"""
import argparse
import json
import shutil
import sys
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, help="Carpeta raiz de la instalacion de Wan2GP")
    parser.add_argument("--prompt", required=True)
    parser.add_argument("--duration", type=float, default=4.0, help="Duracion del clip en segundos")
    parser.add_argument("--resolution", default="768x1344", help="WxH -- vertical por default, como el resto del pipeline")
    parser.add_argument("--model", default="ltx2_22B_distilled")
    parser.add_argument("--out", required=True, help="Ruta donde copiar el .mp4 resultante")
    parser.add_argument("--timeout", type=float, default=300.0, help="Segundos maximos de espera")
    args = parser.parse_args()

    def fail(message):
        print(json.dumps({"ok": False, "error": message}))
        sys.exit(1)

    root = Path(args.root)
    if not root.exists():
        fail(f"WAN2GP_ROOT no existe: {root}")

    sys.path.insert(0, str(root))

    try:
        from shared.api import init  # type: ignore
    except ImportError as e:
        fail(f"No se pudo importar shared.api desde {root} (¿es realmente la raiz de Wan2GP? ¿estan instaladas sus dependencias en este Python?): {e}")
        return

    try:
        session = init(root=root)
        settings = {
            "model_type": args.model,
            "prompt": args.prompt,
            "resolution": args.resolution,
            "duration_seconds": args.duration,
            "force_fps": 24,
        }
        job = session.submit_task(settings)

        deadline = time.monotonic() + args.timeout
        for event in job.events.iter(timeout=0.5):
            if getattr(event, "kind", None) == "error":
                fail(f"Wan2GP reporto un error durante la generacion: {event.data}")
                return
            if time.monotonic() > deadline:
                fail(f"Wan2GP no termino en {args.timeout}s")
                return

        result = job.result()
        if not getattr(result, "success", False) or not getattr(result, "generated_files", None):
            fail(f"Wan2GP no genero ningun archivo: {getattr(result, 'error', '(sin detalle)')}")
            return

        source = Path(result.generated_files[0])
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, args.out)
        print(json.dumps({"ok": True, "file": args.out}))
    except Exception as e:  # cualquier fallo del SDK -- nunca dejar un traceback crudo, Node espera JSON
        fail(f"{type(e).__name__}: {e}")


if __name__ == "__main__":
    main()
