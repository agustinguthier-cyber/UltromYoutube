import React, { useMemo } from "react";
import { interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Montserrat";
import type { Caption } from "../schema";

const { fontFamily } = loadFont("normal", { weights: ["800"] });

const ACTIVE_COLOR = "#FFDD00"; // amarillo, estilo TikTok/MrBeast
const DEFAULT_COLOR = "#FFFFFF";
const POP_DURATION_FRAMES = 8;
const POP_SCALE = 1.18;

// >= 240 (valor anterior) para no quedar tapado por la UI de YouTube
// Shorts/TikTok (botones de la derecha, descripción/handle abajo) -- 460px
// sobre un frame de 1920px cae en la franja centro-inferior recomendada
// (~24% desde abajo), fuera de esa zona.
const BOTTOM_OFFSET = 460;
// Pedido explícito: al menos 40px de aire a los costados.
const HORIZONTAL_PADDING = 48;

const containerStyle: React.CSSProperties = {
  position: "absolute",
  bottom: BOTTOM_OFFSET,
  left: 0,
  right: 0,
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  alignItems: "center",
  rowGap: 20, // separación entre líneas si el bloque envuelve a una segunda fila
  columnGap: 32,
  padding: `0 ${HORIZONTAL_PADDING}px`,
  boxSizing: "border-box",
  maxWidth: "100%",
};

const wordStyle: React.CSSProperties = {
  fontFamily,
  fontWeight: 800,
  fontSize: 80,
  lineHeight: 1.2,
  textAlign: "center",
  textTransform: "uppercase",
  WebkitTextStroke: "14px black",
  paintOrder: "stroke",
  display: "inline-block",
  // Red de seguridad: si una palabra puntual fuera más ancha que el espacio
  // disponible (rarísimo a fontSize 80, pero posible con una palabra muy
  // larga), que se parta a que quede cortada fuera del cuadro.
  maxWidth: "100%",
  overflowWrap: "break-word",
};

/**
 * Subtítulo dinámico: muestra la línea (varias palabras) cuya ventana
 * [start, end) contiene el frame actual, resaltando en amarillo la palabra
 * puntual que se está pronunciando (word.start <= t < word.end) con un
 * pequeño "pop" de escala al entrar. Sin "words" (captions viejos, o
 * whisper.cpp sin desglose por palabra) cae a texto plano sin resaltado --
 * nunca rompe por datos incompletos.
 */
export const Captions: React.FC<{ captions: Caption[] }> = ({ captions }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const currentTime = frame / fps;

  const activeCaption = useMemo(
    () => captions.find((c) => currentTime >= c.start && currentTime < c.end),
    [captions, currentTime]
  );

  if (!activeCaption) {
    return null;
  }

  if (!activeCaption.words || activeCaption.words.length === 0) {
    return (
      <div style={containerStyle}>
        <span style={{ ...wordStyle, color: DEFAULT_COLOR }}>{activeCaption.text}</span>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      {activeCaption.words.map((word, i) => {
        const isActive = currentTime >= word.start && currentTime < word.end;
        const wordStartFrame = Math.round(word.start * fps);
        const pop = spring({
          frame: frame - wordStartFrame,
          fps,
          config: { damping: 12, stiffness: 200 },
          durationInFrames: POP_DURATION_FRAMES,
        });
        const scale = isActive ? interpolate(pop, [0, 1], [1, POP_SCALE]) : 1;

        return (
          <span
            key={i}
            style={{
              ...wordStyle,
              color: isActive ? ACTIVE_COLOR : DEFAULT_COLOR,
              // scaleY (NO scale/scaleX): el "pop" tiene que crecer en alto
              // pero nunca en ancho -- probado en un render real que un
              // scale() uniforme sobre una palabra larga (ej. "REVELABA",
              // ~500px) desborda cualquier columnGap razonable (crece ~45px
              // por lado, más que el gap) y termina pegada a la palabra de
              // al lado. scaleY no tiene ese riesgo pase lo que pase con el
              // ancho de la palabra.
              transform: `scaleY(${scale})`,
            }}
          >
            {word.text}
          </span>
        );
      })}
    </div>
  );
};
