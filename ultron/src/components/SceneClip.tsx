import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useVideoConfig } from "remotion";

/**
 * Un clip de video real para UNA escena (ej. generado por Wan2GP -- ver
 * scripts/lib/generateBrolls.js), a pantalla completa. Se le pide a Wan2GP
 * la duración exacta de la escena, así que no hace falta loop en el caso
 * normal -- si el clip real sale más corto o más largo, la <Sequence> que
 * lo envuelve (ver Background.tsx) lo recorta igual en los bordes de la
 * ventana de la escena, sin romper nada.
 *
 * startFromSeconds (opcional): cuando este mismo archivo cubre varias
 * escenas seguidas (clip manual de 10s recortado en 2-3 tomas, ver
 * schema.ts), cada escena del grupo pasa el punto del archivo donde le toca
 * arrancar -- si el archivo es más corto que start+duración de la última
 * escena del grupo, OffthreadVideo simplemente se queda en su último frame
 * (no hace loop), igual que ya pasa hoy con un clip corto sin agrupar.
 */
export const SceneClip: React.FC<{ src: string; muted?: boolean; startFromSeconds?: number }> = ({
  src,
  muted = true,
  startFromSeconds = 0,
}) => {
  const { fps } = useVideoConfig();
  const startFrom = Math.round(startFromSeconds * fps);
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <OffthreadVideo
        src={staticFile(src)}
        muted={muted}
        startFrom={startFrom}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
    </AbsoluteFill>
  );
};
