import React from "react";
import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from "remotion";

// Zoom sutil (1.0 -> 1.12) parejo a lo largo de toda la escena -- clásico
// Ken Burns, sin paneo (mantenerlo simple hasta que haga falta más).
const START_SCALE = 1;
const END_SCALE = 1.12;

export const KenBurnsImage: React.FC<{ src: string; durationInFrames: number }> = ({
  src,
  durationInFrames,
}) => {
  // useCurrentFrame() acá es LOCAL a la <Sequence> que envuelve esto (0-based
  // desde que arranca la escena) -- por eso durationInFrames se recibe como
  // prop en vez de leerlo de useVideoConfig(), que da la duración de TODO el
  // video, no la de esta escena puntual.
  const frame = useCurrentFrame();

  const scale = interpolate(frame, [0, durationInFrames], [START_SCALE, END_SCALE], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill style={{ overflow: "hidden", backgroundColor: "#000" }}>
      <Img
        src={staticFile(src)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          transform: `scale(${scale})`,
        }}
      />
    </AbsoluteFill>
  );
};
