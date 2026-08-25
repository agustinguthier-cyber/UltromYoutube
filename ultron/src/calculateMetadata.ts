import type { CalculateMetadataFunction } from "remotion";
import { staticFile } from "remotion";
import type { GuionProps } from "./schema";
import { FPS } from "./constants";
import { getMediaDurationInSeconds } from "./utils/probeMediaDuration";

/**
 * Mide la duración real (en frames) de un archivo de video servido como
 * estático, para poder loopearlo con <Loop> sin que se congele si es más
 * corto que el video final. Devuelve null si falla (archivo inválido,
 * etc.) -- el llamador se degrada reproduciendo sin loop, nunca rompe el
 * render por esto.
 */
async function probeDurationInFrames(src: string, label: string): Promise<number | null> {
  try {
    const seconds = await getMediaDurationInSeconds(staticFile(src));
    return Math.max(1, Math.round(seconds * FPS));
  } catch (err) {
    console.warn(
      `[ULTRON] No se pudo medir la duración de "${src}" (${label}) -- se reproduce sin loop. Detalle: ${(err as Error).message}`
    );
    return null;
  }
}

/**
 * La duración del video depende de guion.json (no es un valor fijo).
 * Prioridad: durationInSeconds explícito > fin del último caption.
 *
 * Si el fondo es un video, además mide su duración real e inyecta
 * `background.durationInFrames` -- Background.tsx lo envuelve en <Loop>
 * para que no se corte si es más corto que el video final.
 */
export const calculateVideoMetadata: CalculateMetadataFunction<
  GuionProps
> = async ({ props }) => {
  const lastCaptionEnd = props.captions.reduce(
    (max, caption) => Math.max(max, caption.end),
    0
  );
  const durationInSeconds = props.durationInSeconds ?? lastCaptionEnd;
  const durationInFrames = Math.max(1, Math.round(durationInSeconds * FPS));

  if (props.background?.type !== "video" || props.background.durationInFrames) {
    return { durationInFrames };
  }

  const backgroundDurationInFrames = await probeDurationInFrames(
    props.background.src,
    "fondo de video"
  );

  return {
    durationInFrames,
    props: backgroundDurationInFrames
      ? {
          ...props,
          background: { ...props.background, durationInFrames: backgroundDurationInFrames },
        }
      : props,
  };
};
