import React from "react";
import { AbsoluteFill, Audio, staticFile } from "remotion";
import type { GuionProps } from "./schema";
import { Background } from "./components/Background";
import { Captions } from "./components/Captions";

export const VerticalVideo: React.FC<GuionProps> = ({ audio, background, captions }) => {
  return (
    <AbsoluteFill style={{ backgroundColor: "#000" }}>
      <Background background={background} />
      <Audio src={staticFile(audio)} />
      <Captions captions={captions} />
    </AbsoluteFill>
  );
};
