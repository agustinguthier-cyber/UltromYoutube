import { ALL_FORMATS, Input, UrlSource } from "mediabunny";

/**
 * Duración en segundos de un video servido como estático (staticFile url).
 *
 * Nota: NO usar ffprobe/child_process acá -- calculateMetadata.ts se empaqueta
 * junto con el resto de src/ en el bundle de Remotion (webpack apunta a
 * browser), así que cualquier import de "node:*" rompe el build aunque la
 * función semánticamente "corra en Node". mediabunny es puro JS/fetch y
 * funciona en ambos contextos -- por eso es la recomendación oficial de
 * Remotion para este caso (ver docs: mediabunny/metadata).
 */
export const getMediaDurationInSeconds = async (url: string): Promise<number> => {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new UrlSource(url, { getRetryDelay: () => null }),
  });

  return input.computeDuration();
};
