/**
 * Motor de render alternativo via Remotion (proyecto hermano ./ultron) para el formato
 * 9:16 -- reemplaza SOLO las etapas 1-3 de render.js (clips Ken Burns por escena + concat +
 * subtitulos .ass quemados) por un unico render de React/Remotion con subtitulos animados
 * palabra por palabra (resaltado + "pop", ver ultron/src/components/Captions.tsx). Las
 * etapas 4-5 (mezcla de audio narracion+musica con ducking real + mux final) se REUSAN tal
 * cual de render.js -- ya estan probadas (7dB de atenuacion medida) y no dependen del motor
 * de video que las alimenta.
 *
 * La composicion de ultron (VerticalVideo) esta fijada a 1080x1920 @ 30fps (ver
 * ultron/src/constants.ts) -- por eso este motor solo se usa para aspectRatio 9:16;
 * server.js cae al pipeline FFmpeg puro (render.js) para el resto de los formatos.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  buildAudioMix, muxFinal, newJobDir, cleanupJobDir, RENDERS_DIR,
} = require('./render.js');
const { captionsFromSegmentWindows } = require('./ultron/scripts/lib/alignTimestamps.js');

const ULTRON_ROOT = path.join(__dirname, 'ultron');
const ULTRON_PUBLIC = path.join(ULTRON_ROOT, 'public');
const RENDER_ASSETS_SUBDIR = 'assets/render_jobs'; // relativo a ultron/public, siempre con "/"

function ultronAssetsDirFor(jobId){
  return path.join(ULTRON_PUBLIC, ...RENDER_ASSETS_SUBDIR.split('/'), jobId);
}

/* Corre "npx remotion render" capturando stdout/stderr -- a diferencia del wrapper propio de
   ultron (scripts/render.js), que usa stdio:'inherit' pensado para uso interactivo por
   consola, esto necesita los streams para parsear progreso y juntar el error real si falla.
   Progreso: best-effort, parseando el ultimo "NN%" que aparezca en la salida -- el CLI de
   Remotion no documenta un formato de progreso estable para consumo programatico. Si el
   patron no matchea en una version futura, el job simplemente no actualiza el %, pero sigue
   esperando el cierre del proceso sin romper. */
function runRemotionRender(guionPath, outPath, { onProgress } = {}){
  return new Promise((resolve, reject) => {
    const proc = spawn('npx', ['remotion', 'render', 'VerticalVideo', outPath, `--props=${guionPath}`], {
      cwd: ULTRON_ROOT,
      shell: process.platform === 'win32',
    });
    let tail = '';
    const onData = (chunk) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      if(onProgress){
        const matches = [...text.matchAll(/(\d{1,3})\s*%/g)];
        if(matches.length){
          const pct = parseInt(matches[matches.length - 1][1], 10);
          if(Number.isFinite(pct)) onProgress(Math.max(0, Math.min(1, pct / 100)));
        }
      }
    };
    if(proc.stdout) proc.stdout.on('data', onData);
    if(proc.stderr) proc.stderr.on('data', onData);
    proc.on('error', (err) => reject(new Error(`No se pudo ejecutar "npx remotion" (¿node_modules de ultron instalado? ¿npx en el PATH?): ${err.message}`)));
    proc.on('close', (code) => {
      if(code === 0) resolve();
      else reject(new Error(`El render de Remotion salio con codigo ${code}.\n${tail.split('\n').slice(-30).join('\n')}`));
    });
  });
}

function extOf(p){ return path.extname(p).toLowerCase(); }

/* Copia (no mueve) los assets de la narracion y las escenas a
   ultron/public/assets/render_jobs/<jobId>/ -- unico lugar desde donde Remotion puede
   servirlos (staticFile() los resuelve siempre relativos a ultron/public/, ver
   ultron/README.md). Devuelve las rutas relativas a public/ que van directo al guion.json. */
function stageAssets(jobId, { narrationPath, scenes }){
  const dir = ultronAssetsDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });

  const narrationExt = extOf(narrationPath) || '.mp3';
  fs.copyFileSync(narrationPath, path.join(dir, `narration${narrationExt}`));
  const audioRel = `${RENDER_ASSETS_SUBDIR}/${jobId}/narration${narrationExt}`;

  const sceneRelByIndex = new Map();
  for(const scene of scenes){
    const ext = extOf(scene.mediaPath) || (scene.mediaType === 'video' ? '.mp4' : '.jpg');
    const destName = `scene_${String(scene.index).padStart(3, '0')}${ext}`;
    fs.copyFileSync(scene.mediaPath, path.join(dir, destName));
    sceneRelByIndex.set(scene.index, `${RENDER_ASSETS_SUBDIR}/${jobId}/${destName}`);
  }

  return { audioRel, sceneRelByIndex };
}

/* Arma el guion.json que consume la composicion VerticalVideo de ultron. "background" se
   escribe SIEMPRE explicito (nunca se omite) -- gotcha real documentado en ultron/README.md:
   `remotion render --props=` mezcla por encima de los defaultProps de Root.tsx clave por
   clave, asi que omitir "background" hereda en silencio el video de demo de sampleProps en
   vez de negro solido. Las escenas sin medio asignado quedan afuera del array -- Background.tsx
   ya banca los huecos mostrando negro solido ahi, sin romper el render. */
function buildGuionJson({ turboscript, sceneRelByIndex, scenes, audioRel, totalDurationSec, subtitlesEnabled }){
  const mediaTypeByIndex = new Map(scenes.map(s => [s.index, s.mediaType]));
  // offsetSeconds: solo tiene sentido para video -- un mismo clip subido a mano puede cubrir
  // varias escenas seguidas (ver paso 8 de la app, agrupación manual), cada una con su propio
  // punto de arranque dentro del archivo. Ver sceneMediaSchema en ultron/src/schema.ts.
  const mediaOffsetByIndex = new Map(scenes.map(s => [s.index, s.offsetSeconds || 0]));
  const sceneEntries = [];
  for(let i = 0; i < turboscript.length; i++){
    const rel = sceneRelByIndex.get(i);
    if(!rel) continue;
    const sc = turboscript[i];
    const entry = { start: sc.start, end: sc.end };
    if(mediaTypeByIndex.get(i) === 'video'){
      entry.video = rel;
      const offset = mediaOffsetByIndex.get(i);
      if(offset) entry.startFromSeconds = offset;
    } else {
      entry.image = rel;
    }
    sceneEntries.push(entry);
  }

  // Mismo split proporcional por palabra que ya usa buildAssSubtitles() (render.js) cuando
  // no hay alineacion forzada real -- ver alignTimestamps.js (ultron) -- pero agrupado en
  // lineas cortas con timing por palabra, que es lo que habilita el resaltado con "pop" de
  // Captions.tsx en vez del subtitulo estatico de siempre.
  const captions = subtitlesEnabled === false ? [] : captionsFromSegmentWindows(
    turboscript.map(sc => ({ text: sc.text, start: sc.start, end: sc.end }))
  );

  return {
    title: 'Ultrom',
    audio: audioRel,
    durationInSeconds: totalDurationSec,
    background: sceneEntries.length ? { type: 'scenes', scenes: sceneEntries } : { type: 'color', value: '#000000' },
    captions,
  };
}

/**
 * Mismo contrato que render.renderFullVideo(jobId, params, job) -- server.js elige entre
 * los dos motores segun aspectRatio, ambos actualizan el mismo objeto "job" (status/stage/
 * percent/error/url) y escriben el resultado final bajo RENDERS_DIR con la misma convencion
 * de nombre (render_<jobId>.mp4), asi que el resto de la app (polling, preview, descarga) no
 * necesita saber cual de los dos corrio.
 */
async function renderFullVideoRemotion(jobId, params, job){
  if(params.aspectRatio !== '9:16'){
    throw new Error('El motor Remotion solo soporta 9:16 por ahora (composicion fija 1080x1920 — ver ultron/src/constants.ts).');
  }

  const jobDir = newJobDir(jobId);
  const assetsDir = ultronAssetsDirFor(jobId);
  try{
    job.stage = 'preparando assets para Remotion';
    job.percent = 0.02;
    const { audioRel, sceneRelByIndex } = stageAssets(jobId, {
      narrationPath: params.narrationPath,
      scenes: params.scenes,
    });

    const guion = buildGuionJson({
      turboscript: params.turboscript,
      sceneRelByIndex,
      scenes: params.scenes,
      audioRel,
      totalDurationSec: params.totalDurationSec,
      subtitlesEnabled: params.subtitlesEnabled,
    });
    const guionPath = path.join(jobDir, 'guion.json');
    fs.writeFileSync(guionPath, JSON.stringify(guion, null, 2), 'utf8');

    job.stage = 'renderizando con Remotion (video + subtitulos animados)';
    job.percent = 0.1;
    const remotionOutName = 'remotion_video.mp4';
    await runRemotionRender(guionPath, path.join(jobDir, remotionOutName), {
      onProgress: (p) => { job.percent = 0.1 + p * 0.6; },
    });

    job.stage = 'mezclando audio';
    job.percent = 0.75;
    const cutTimestamps = params.turboscript.slice(1).map(s => s.start);
    const audioName = await buildAudioMix({
      narrationPath: params.narrationPath,
      musicPath: params.musicPath,
      sfxPaths: params.sfxPaths,
      cutTimestamps,
      narrationVol: params.narrationVol,
      musicVol: params.musicVol,
    }, { jobDir, totalDurationSec: params.totalDurationSec });

    job.stage = 'combinando video final';
    job.percent = 0.95;
    const finalName = `render_${jobId}.mp4`;
    const finalOutPath = path.join(RENDERS_DIR, finalName);
    await muxFinal(remotionOutName, audioName, { jobDir, finalOutPath });

    job.status = 'completed';
    job.percent = 1;
    job.url = `/public/assets/renders/${finalName}`;
  }catch(e){
    job.status = 'failed';
    job.error = e.message;
  }finally{
    cleanupJobDir(jobDir);
    fs.rm(assetsDir, { recursive: true, force: true }, () => {});
  }
}

module.exports = { renderFullVideoRemotion, ULTRON_ROOT };
