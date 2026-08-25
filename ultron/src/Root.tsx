import React from "react";
import { Composition } from "remotion";
import { VerticalVideo } from "./VerticalVideo";
import { guionSchema } from "./schema";
import { calculateVideoMetadata } from "./calculateMetadata";
import { FPS, WIDTH, HEIGHT } from "./constants";

// Props de ejemplo para que "npx remotion studio" tenga algo que mostrar
// sin necesitar todavia un guion.json real. El pipeline real pisa esto con
// --props=./guion.json al renderizar (ver README.md).
const sampleProps = {
  title: "Título de ejemplo del canal",
  audio: "audio/ejemplo.mp3",
  background: { type: "video" as const, src: "backgrounds/sample-bg.mp4" },
  captions: [
    {
      start: 0,
      end: 1.7,
      text: "ESTO ES UN EJEMPLO",
      words: [
        { start: 0, end: 0.4, text: "ESTO" },
        { start: 0.4, end: 0.75, text: "ES" },
        { start: 0.75, end: 1.05, text: "UN" },
        { start: 1.05, end: 1.7, text: "EJEMPLO" },
      ],
    },
    {
      start: 1.7,
      end: 3,
      text: "DE SUBTÍTULOS ANIMADOS",
      words: [
        { start: 1.7, end: 2.05, text: "DE" },
        { start: 2.05, end: 2.5, text: "SUBTÍTULOS" },
        { start: 2.5, end: 3, text: "ANIMADOS" },
      ],
    },
  ],
  durationInSeconds: 3,
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="VerticalVideo"
      component={VerticalVideo}
      width={WIDTH}
      height={HEIGHT}
      fps={FPS}
      durationInFrames={FPS * 3}
      schema={guionSchema}
      defaultProps={sampleProps}
      calculateMetadata={calculateVideoMetadata}
    />
  );
};
