/**
 * Pipeline de renderizado de video 100% en el servidor, via FFmpeg nativo (sin
 * MediaRecorder, sin ffmpeg.wasm en el navegador). Se ejecuta en etapas, cada una
 * con su propio proceso de ffmpeg, para que sea facil de depurar/testear por separado:
 *
 *   1. renderSceneClip()   - una imagen (Ken Burns/zoompan) o video (crop+loop) por escena
 *   2. concatSceneClips()  - concatena todos los clips de escena en un solo video mudo
 *   3. burnSubtitles()     - quema el .ass de subtitulos encima (opcional)
 *   4. buildAudioMix()     - mezcla narracion + musica (con ducking) + sfx
 *   5. muxFinal()          - combina el video (con subtitulos) + el audio mezclado
 *
 * Todas las rutas de archivo dentro de un job se resuelven relativas a un directorio
 * temporal propio del job (jobDir) y los procesos de ffmpeg corren con cwd=jobDir, usando
 * SOLO nombres de archivo sueltos (nunca rutas absolutas) en los argumentos de filtro -vf
 * ass=... : en Windows, una ruta absoluta como "C:\..." rompe el parser interno de ese
 * filtro por el ":" despues de la letra de unidad, y evitarlo con cwd es mas simple y
 * confiable que escapar el string.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = __dirname;
const TMP_ROOT = path.join(ROOT, 'tmp', 'render');
const RENDERS_DIR = path.join(ROOT, 'public', 'assets', 'renders');
fs.mkdirSync(TMP_ROOT, { recursive: true });
fs.mkdirSync(RENDERS_DIR, { recursive: true });

const FFMPEG_BIN = process.env.FFMPEG_PATH || 'ffmpeg';

/* ================= ejecucion de ffmpeg ================= */
/* Corre un comando de ffmpeg, parseando "time=HH:MM:SS.mm" de stderr para reportar
   progreso (0-1) contra totalDurationSec si se pasa. Junta las ultimas lineas de stderr
   para el mensaje de error si el proceso termina con codigo != 0. */
function runFFmpeg(args, { cwd, totalDurationSec, onProgress } = {}){
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ['-y', '-hide_banner', ...args], { cwd });
    let stderrTail = '';
    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-4000);
      if(onProgress && totalDurationSec > 0){
        const m = text.match(/time=(\d+):(\d\d):(\d\d)\.(\d+)/);
        if(m){
          const secs = parseInt(m[1])*3600 + parseInt(m[2])*60 + parseInt(m[3]) + parseInt(m[4])/100;
          onProgress(Math.max(0, Math.min(1, secs / totalDurationSec)));
        }
      }
    });
    proc.on('error', (err) => reject(new Error(`No se pudo ejecutar ffmpeg (¿esta en el PATH?): ${err.message}`)));
    proc.on('close', (code) => {
      if(code === 0) resolve();
      else reject(new Error(`ffmpeg salio con codigo ${code}.\n${stderrTail.split('\n').slice(-25).join('\n')}`));
    });
  });
}

function newJobDir(jobId){
  const dir = path.join(TMP_ROOT, jobId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanupJobDir(dir){
  try{ fs.rmSync(dir, { recursive: true, force: true }); }catch(e){ /* best effort */ }
}

/* ================= etapa 1: un clip silencioso por escena ================= */
/* Imagenes: efecto Ken Burns (zoompan) centrado, con un upscale previo para que el zoom
   no se vea "a los saltos" (tecnica estandar: escalar 2x antes de zoompan). Videos: se
   recortan/loopean a la duracion exacta de la escena, sin zoompan (ya tienen movimiento
   propio). Ambos casos: scale+crop primero para llenar el cuadro WxH sin deformar,
   sea cual sea el aspecto original del archivo.

   offsetSeconds (solo video, opcional): un mismo archivo puede cubrir varias escenas
   seguidas -- ej. un clip manual de 10s que el usuario recorta el mismo en 2-3 tomas y
   asigna a 2-3 escenas seguidas del turboscript (ver paso 8 de la app). Sin esto, cada
   escena arrancaria el mismo archivo desde 0:00 y se veria "reiniciar" en cada corte; con
   esto, cada escena reproduce el tramo que le toca, como si fuera un unico video cortado
   en pedazos. Se implementa como seek de SALIDA (-ss despues de -i, no antes) para que
   siga funcionando bien combinado con -stream_loop -1: si el offset+duracion de la ultima
   escena del grupo supera la duracion real del archivo, sigue leyendo de la siguiente
   vuelta del loop en vez de trabarse. */
async function renderSceneClip({ mediaPath, mediaType, duration, index, offsetSeconds }, { W, H, fps, jobDir }){
  const outName = `clip_${String(index).padStart(3, '0')}.mp4`;
  const outPath = path.join(jobDir, outName);
  const d = Math.max(0.5, duration); // ffmpeg no banca -t 0
  const frames = Math.max(1, Math.round(d * fps));
  const upW = W * 2, upH = H * 2;

  let vf;
  const inputArgs = [];
  const outputSeekArgs = [];
  if(mediaType === 'video'){
    inputArgs.push('-stream_loop', '-1', '-i', mediaPath);
    if(offsetSeconds > 0) outputSeekArgs.push('-ss', String(offsetSeconds));
    vf = `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${fps},format=yuv420p`;
  } else {
    inputArgs.push('-loop', '1', '-i', mediaPath);
    vf = [
      `scale=${W}:${H}:force_original_aspect_ratio=increase`,
      `crop=${W}:${H}`,
      `scale=${upW}:${upH}`,
      `zoompan=z='min(zoom+0.0015,1.4)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${fps}`,
      'format=yuv420p'
    ].join(',');
  }

  await runFFmpeg([
    ...inputArgs,
    ...outputSeekArgs,
    '-t', String(d),
    '-vf', vf,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-an',
    outName
  ], { cwd: jobDir, totalDurationSec: d });

  return outName;
}

/* ================= etapa 2: concatenar todos los clips ================= */
async function concatSceneClips(clipNames, { jobDir }){
  const listName = 'concat_list.txt';
  const listContent = clipNames.map(n => `file '${n.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
  fs.writeFileSync(path.join(jobDir, listName), listContent, 'utf8');
  const outName = 'concatenated.mp4';
  await runFFmpeg([
    '-f', 'concat', '-safe', '0', '-i', listName,
    '-c', 'copy',
    outName
  ], { cwd: jobDir });
  return outName;
}

/* ================= subtitulos .ass estilo Reels/TikTok ================= */
/* Una sola palabra grande en pantalla a la vez (mayusculas, negrita, borde negro grueso),
   alternando amarillo/rojo por palabra para que "pegue" visualmente. El tiempo de cada
   palabra se reparte proporcional dentro de la ventana [start,end) de su escena (division
   pareja por cantidad de palabras — no hay alineacion forzada real disponible en este
   proyecto, asi que esta es la mejor aproximacion sin ese tooling). */
const ASS_COLOR_YELLOW = '&H0000FFFF&'; // formato ASS: &HAABBGGRR&
const ASS_COLOR_RED = '&H000000FF&';

function assTime(seconds){
  seconds = Math.max(0, seconds);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds - Math.floor(seconds)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
function assEscapeText(text){
  return text.replace(/[{}]/g, '').replace(/\\/g, '/').replace(/\n/g, ' ').trim();
}

function buildAssSubtitles(turboscript, { W, H, jobDir }){
  const fontSize = Math.round(H * (H > W ? 0.085 : 0.075));
  const outline = Math.max(3, Math.round(fontSize * 0.09));
  const marginV = Math.round(H > W ? H * 0.30 : H * 0.12);

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,Arial Black,${fontSize},${ASS_COLOR_YELLOW},&H000000FF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,${outline},0,2,20,20,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const lines = [];
  let globalWordIndex = 0;
  for(const scene of turboscript){
    const words = String(scene.text || '').trim().split(/\s+/).filter(Boolean);
    if(!words.length) continue;
    const sceneDur = Math.max(0.05, (scene.end - scene.start));
    const wordDur = sceneDur / words.length;
    words.forEach((word, i) => {
      const wStart = scene.start + i * wordDur;
      const wEnd = wStart + wordDur;
      const color = (globalWordIndex % 2 === 0) ? ASS_COLOR_YELLOW : ASS_COLOR_RED;
      globalWordIndex++;
      const text = assEscapeText(word).toUpperCase();
      if(!text) return;
      lines.push(`Dialogue: 0,${assTime(wStart)},${assTime(wEnd)},Word,,0,0,0,,{\\c${color}}${text}`);
    });
  }

  const assName = 'subtitles.ass';
  fs.writeFileSync(path.join(jobDir, assName), header + lines.join('\n') + '\n', 'utf8');
  return assName;
}

/* ================= etapa 3: quemar subtitulos ================= */
async function burnSubtitles(inputName, assName, { jobDir, totalDurationSec, onProgress }){
  const outName = 'subtitled.mp4';
  await runFFmpeg([
    '-i', inputName,
    '-vf', `ass=${assName}`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-an',
    outName
  ], { cwd: jobDir, totalDurationSec, onProgress });
  return outName;
}

/* ================= etapa 4: mezcla de audio (narracion + musica con ducking + sfx) =================
   La narracion es prioritaria: la musica se agacha automaticamente cuando hay voz
   (sidechaincompress, disparado por una copia de la narracion) y los SFX se insertan en
   los cortes entre escenas (adelay a cada timestamp de corte). Arma el filtro dinamicamente
   segun que insumos existan de verdad (musica y/o sfx son opcionales). */
async function buildAudioMix({ narrationPath, musicPath, sfxPaths, cutTimestamps, narrationVol, musicVol }, { jobDir, totalDurationSec }){
  const inputs = ['-i', narrationPath];
  let inputIdx = 1;
  let musicIdx = null, sfxStartIdx = null;
  if(musicPath){ inputs.push('-stream_loop', '-1', '-i', musicPath); musicIdx = inputIdx++; }
  if(sfxPaths && sfxPaths.length){
    sfxStartIdx = inputIdx;
    for(const p of sfxPaths){ inputs.push('-i', p); inputIdx++; }
  }

  const filters = [];
  const narrGain = (narrationVol == null ? 100 : narrationVol) / 100;
  const musGain = (musicVol == null ? 18 : musicVol) / 100;
  filters.push(`[0:a]volume=${narrGain}[narr]`);

  let voiceMusicLabel = 'narr';
  if(musicIdx !== null){
    filters.push(`[narr]asplit=2[narr_main][narr_sc]`);
    filters.push(`[${musicIdx}:a]volume=${musGain}[music_v]`);
    filters.push(`[music_v][narr_sc]sidechaincompress=threshold=0.03:ratio=10:attack=10:release=700:makeup=1[music_ducked]`);
    filters.push(`[narr_main][music_ducked]amix=inputs=2:duration=first:normalize=0[voice_music]`);
    voiceMusicLabel = 'voice_music';
  }

  let finalLabel = voiceMusicLabel;
  if(sfxStartIdx !== null && cutTimestamps && cutTimestamps.length){
    const sfxLabels = [];
    sfxPaths.forEach((_, i) => {
      const t = cutTimestamps[i % cutTimestamps.length];
      const ms = Math.max(0, Math.round(t * 1000));
      const label = `sfx${i}`;
      filters.push(`[${sfxStartIdx + i}:a]adelay=${ms}|${ms}:all=1[${label}]`);
      sfxLabels.push(`[${label}]`);
    });
    filters.push(`[${finalLabel}]${sfxLabels.join('')}amix=inputs=${sfxLabels.length + 1}:duration=first:normalize=0[mixed]`);
    finalLabel = 'mixed';
  }

  const filterScriptName = 'audio_filter.txt';
  fs.writeFileSync(path.join(jobDir, filterScriptName), filters.join(';\n'), 'utf8');

  const outName = 'mixed_audio.m4a';
  await runFFmpeg([
    ...inputs,
    '-filter_complex_script', filterScriptName,
    '-map', `[${finalLabel}]`,
    '-t', String(totalDurationSec),
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
    outName
  ], { cwd: jobDir, totalDurationSec });
  return outName;
}

/* ================= etapa 5: mux final ================= */
async function muxFinal(videoName, audioName, { jobDir, finalOutPath }){
  await runFFmpeg([
    '-i', videoName,
    '-i', audioName,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-movflags', '+faststart',
    '-shortest',
    finalOutPath
  ], { cwd: jobDir });
}

/* ================= orquestacion completa ================= */
/**
 * params: {
 *   turboscript: [{start,end,text}],
 *   scenes: [{index, mediaPath, mediaType}],   // solo las que tienen medio asignado
 *   totalDurationSec,
 *   aspectRatio: '9:16' | '16:9' | otro,
 *   subtitlesEnabled: bool,
 *   narrationPath, musicPath, sfxPaths: [path],
 *   narrationVol, musicVol,
 * }
 * job: objeto mutable compartido con el endpoint de status — se le va actualizando
 * .stage/.percent a medida que avanza, y .status/.url/.error al terminar.
 */
async function renderFullVideo(jobId, params, job){
  const jobDir = newJobDir(jobId);
  try{
    const isVertical = params.aspectRatio === '9:16';
    const W = isVertical ? 1080 : 1920;
    const H = isVertical ? 1920 : 1080;
    const fps = 30;

    job.stage = 'escenas';
    const sceneByIndex = new Map(params.scenes.map(s => [s.index, s]));
    const clipNames = [];
    for(let i = 0; i < params.turboscript.length; i++){
      const sc = params.turboscript[i];
      const media = sceneByIndex.get(i);
      const duration = Math.max(0.3, sc.end - sc.start);
      job.stage = `escena ${i + 1}/${params.turboscript.length}`;
      job.percent = i / params.turboscript.length * 0.5;
      if(media){
        const name = await renderSceneClip(
          { mediaPath: media.mediaPath, mediaType: media.mediaType, duration, index: i, offsetSeconds: media.offsetSeconds || 0 },
          { W, H, fps, jobDir }
        );
        clipNames.push(name);
      } else {
        // sin medio asignado: clip negro silencioso, mismo formato que el resto
        const outName = `clip_${String(i).padStart(3, '0')}.mp4`;
        await runFFmpeg([
          '-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${duration}`,
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an',
          outName
        ], { cwd: jobDir });
        clipNames.push(outName);
      }
    }

    job.stage = 'uniendo escenas';
    job.percent = 0.5;
    let videoName = await concatSceneClips(clipNames, { jobDir });

    if(params.subtitlesEnabled){
      job.stage = 'generando subtitulos';
      job.percent = 0.55;
      const assName = buildAssSubtitles(params.turboscript, { W, H, jobDir });
      job.stage = 'quemando subtitulos';
      videoName = await burnSubtitles(videoName, assName, {
        jobDir, totalDurationSec: params.totalDurationSec,
        onProgress: (p) => { job.percent = 0.55 + p * 0.25; }
      });
    }

    job.stage = 'mezclando audio';
    job.percent = 0.85;
    const cutTimestamps = params.turboscript.slice(1).map(s => s.start);
    const audioName = await buildAudioMix({
      narrationPath: params.narrationPath,
      musicPath: params.musicPath,
      sfxPaths: params.sfxPaths,
      cutTimestamps,
      narrationVol: params.narrationVol,
      musicVol: params.musicVol
    }, { jobDir, totalDurationSec: params.totalDurationSec });

    job.stage = 'combinando video final';
    job.percent = 0.95;
    const finalName = `render_${jobId}.mp4`;
    const finalOutPath = path.join(RENDERS_DIR, finalName);
    await muxFinal(videoName, audioName, { jobDir, finalOutPath });

    job.status = 'completed';
    job.percent = 1;
    job.url = `/public/assets/renders/${finalName}`;
  }catch(e){
    job.status = 'failed';
    job.error = e.message;
  }finally{
    cleanupJobDir(jobDir);
  }
}

module.exports = {
  renderFullVideo,
  buildAssSubtitles, // exportado tambien para tests aislados
  buildAudioMix, // reusado por remotionRender.js (etapa 4, sin duplicar la mezcla con ducking)
  muxFinal, // reusado por remotionRender.js (etapa 5)
  runFFmpeg,
  newJobDir,
  cleanupJobDir,
  TMP_ROOT,
  RENDERS_DIR,
};
