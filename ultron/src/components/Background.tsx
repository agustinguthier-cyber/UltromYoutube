import React from "react";
import { AbsoluteFill, Loop, OffthreadVideo, Sequence, staticFile, useVideoConfig } from "remotion";
import type { Background as BackgroundProps } from "../schema";
import { KenBurnsImage } from "./KenBurnsImage";
import { SceneClip } from "./SceneClip";

const DEFAULT_BACKGROUND: BackgroundProps = {
  type: "color",
  value: "#000000",
};

export const Background: React.FC<{ background?: BackgroundProps }> = ({
  background = DEFAULT_BACKGROUND,
}) => {
  const { fps } = useVideoConfig();

  if (background.type === "color") {
    return <AbsoluteFill style={{ backgroundColor: background.value }} />;
  }

  if (background.type === "scenes") {
    return (
      <AbsoluteFill style={{ backgroundColor: "#000" }}>
        {background.scenes.map((scene, i) => {
          const from = Math.round(scene.start * fps);
          const durationInFrames = Math.round((scene.end - scene.start) * fps);
          // Escena inválida o demasiado corta (ej. redondeo a 0 frames) --
          // se salta en vez de crashear el render entero.
          if (durationInFrames <= 0) return null;
          return (
            <Sequence key={i} from={from} durationInFrames={durationInFrames}>
              {"video" in scene ? (
                <SceneClip src={scene.video} muted={scene.muted} startFromSeconds={scene.startFromSeconds} />
              ) : (
                <KenBurnsImage src={scene.image} durationInFrames={durationInFrames} />
              )}
            </Sequence>
          );
        })}
      </AbsoluteFill>
    );
  }

  const video = (
    <OffthreadVideo
      src={staticFile(background.src)}
      muted={background.muted ?? true}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );

  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      {background.durationInFrames ? (
        // Sin "times": Loop repite el clip lo necesario para cubrir toda la
        // duración del video final (la calcula calculateMetadata.ts).
        <Loop durationInFrames={background.durationInFrames}>{video}</Loop>
      ) : (
        video
      )}
    </AbsoluteFill>
  );
};
