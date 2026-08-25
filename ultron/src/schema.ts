import { z } from "zod";

/**
 * Una palabra individual con su propia ventana de tiempo -- lo que permite
 * resaltarla en pantalla justo cuando se pronuncia (ver Captions.tsx).
 */
export const wordTimingSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

/**
 * Una línea de subtítulo (varias palabras que quedan juntas en pantalla) con
 * su ventana de tiempo total. "words" es opcional para no romper guion.json
 * viejos que solo tenían start/end/text por bloque -- sin "words",
 * Captions.tsx cae a texto plano sin resaltado palabra por palabra.
 */
export const captionSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(wordTimingSchema).optional(),
});

/**
 * El contenido visual de UNA escena con su ventana de tiempo -- mismo
 * concepto que un caption, pero para el fondo de ese tramo del guion. Dos
 * formas: una imagen fija (Ken Burns) o un clip de video real (generado por
 * IA, ej. Wan2GP -- ver scripts/lib/generateBrolls.js). "image"/"video" son
 * relativos a /public, igual que "audio".
 *
 * "startFromSeconds" (solo video, opcional): un mismo archivo de video puede
 * cubrir VARIAS escenas consecutivas -- ej. un B-roll manual de 10s que un
 * usuario recorta él mismo en 2-3 tomas y asigna a 2-3 escenas seguidas del
 * turboscript (ver paso 8 de la app, agrupación manual de clips). Sin este
 * campo, cada escena arrancaría el mismo archivo desde 0:00 (se "reinicia"
 * en cada corte); con él, cada escena del grupo reproduce el tramo del
 * archivo que le toca, como si fuera un único video continuo cortado en
 * pedazos. Default 0 (comportamiento de siempre: arranca desde el inicio).
 */
export const sceneMediaSchema = z.union([
  z.object({ start: z.number(), end: z.number(), image: z.string() }),
  z.object({
    start: z.number(),
    end: z.number(),
    video: z.string(),
    muted: z.boolean().optional(),
    startFromSeconds: z.number().optional(),
  }),
]);

/**
 * Fondo detrás de los subtítulos. Tres formas:
 * - color sólido
 * - un único video local (B-roll) que se recorta a pantalla completa (cover)
 * - una secuencia por escena/segmento del guion (`sceneMediaSchema`): cada
 *   una puede ser una imagen fija con Ken Burns (zoom suave) o un clip de
 *   video real, durante su propia ventana de tiempo.
 * "src"/"image"/"video" son relativos a /public, igual que "audio".
 */
export const backgroundSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("color"), value: z.string() }),
  z.object({
    type: z.literal("video"),
    src: z.string(),
    muted: z.boolean().optional(),
    // Calculado automáticamente por calculateMetadata.ts (vía ffprobe) para
    // poder loopear el clip -- no completar a mano en guion.json.
    durationInFrames: z.number().optional(),
  }),
  z.object({
    type: z.literal("scenes"),
    scenes: z.array(sceneMediaSchema),
  }),
]);

export const guionSchema = z.object({
  title: z.string(),
  // Ruta relativa a /public (ej: "audio/locucion.mp3")
  audio: z.string(),
  // Opcional: si no viene, la duración se calcula desde el último caption.end
  durationInSeconds: z.number().optional(),
  // Opcional: si no viene, el fondo es negro sólido (comportamiento anterior)
  background: backgroundSchema.optional(),
  captions: z.array(captionSchema),
});
// Nota: BGM y SFX NO son parte de este schema -- Remotion solo renderiza
// visuales + narración. La música de fondo (con ducking real vía
// sidechaincompress) y los SFX de transición se mezclan en un paso de
// FFmpeg aparte, DESPUÉS de este render (ver scripts/lib/mixAudio.js) --
// mismo enfoque que ya usa render.js del proyecto padre.

export type WordTiming = z.infer<typeof wordTimingSchema>;
export type Caption = z.infer<typeof captionSchema>;
export type SceneMedia = z.infer<typeof sceneMediaSchema>;
export type Background = z.infer<typeof backgroundSchema>;
export type GuionProps = z.infer<typeof guionSchema>;
