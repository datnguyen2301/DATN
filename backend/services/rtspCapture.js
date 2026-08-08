const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ezviz = require('./ezviz');

const STREAMS_DIR = path.join(__dirname, '..', 'streams');

function getFfmpegPath() {
  return process.env.FFMPEG_PATH || 'ffmpeg';
}

/** Private ranges only — anything else cannot be a camera on this machine's LAN. */
function onLan(ip) {
  const s = String(ip || '');
  return s.startsWith('192.168.') || s.startsWith('10.') || s.startsWith('172.');
}

function rtspBase(localIp, port, camKey) {
  const p = port || '554';
  if (camKey) {
    const user = encodeURIComponent('admin');
    const pass = encodeURIComponent(String(camKey));
    return `rtsp://${user}:${pass}@${localIp}:${p}`;
  }
  return `rtsp://${localIp}:${p}`;
}

function buildFastCandidates({ localIp, rtspPort, camKey }) {
  // Prioritized shortlist: sub streams first (faster), known-good paths for this camera
  const port = rtspPort || '554';
  const key = String(camKey || '').trim();

  const candidates = [];

  // Known-working path first (H.264 main stream)
  candidates.push(
    { type: 'h264_main', url: `${rtspBase(localIp, port, key)}/h264/ch1/main/av_stream` },
    { type: 'h264_sub', url: `${rtspBase(localIp, port, key)}/h264/ch1/sub/av_stream` },
  );

  // EZVIZ-style — only if camKey looks like a channel index
  if (key && /^\d+$/.test(key)) {
    candidates.push(
      { type: 'ezviz_main', url: `${rtspBase(localIp, port, key)}/ch${key}/main/av_stream` },
      { type: 'ezviz_sub', url: `${rtspBase(localIp, port, key)}/ch${key}/sub/av_stream` },
    );
  }

  candidates.push(
    { type: 'h265_main', url: `${rtspBase(localIp, port, key)}/h265/ch1/main/av_stream` },
    { type: 'h265_sub', url: `${rtspBase(localIp, port, key)}/h265/ch1/sub/av_stream` },
    { type: 'chan101', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/101` },
    { type: 'chan102', url: `${rtspBase(localIp, port, key)}/Streaming/Channels/102` },
    { type: 'dahua_main', url: `${rtspBase(localIp, port, key)}/cam/realmonitor?channel=1&subtype=0` },
    { type: 'dahua_sub', url: `${rtspBase(localIp, port, key)}/cam/realmonitor?channel=1&subtype=1` },
    { type: 'live', url: `${rtspBase(localIp, port, key)}/live` },
    { type: 'generic_stream', url: `${rtspBase(localIp, port, key)}/stream` },
  );

  return candidates;
}

function tryFfmpegOneFrame(rtspUrl, destPath, timeoutMs, rtspTransport = 'tcp') {
  return new Promise((resolve) => {
    const ffmpegBin = getFfmpegPath();
    // Try H.264/AVC first, then H.265/HEVC. Some FFmpeg builds lack H.265 support on Windows.
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-rtsp_transport', rtspTransport,
      '-fflags', 'nobuffer',
      '-flags', 'low_delay',
      '-max_delay', '5000000',
      '-i', rtspUrl,
      '-frames:v', '1',
      '-q:v', '3',
      '-y',
      destPath,
    ];
    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: 'timeout' });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        resolve({ ok: false, stderr });
        return;
      }
      try {
        const st = fs.statSync(destPath);
        if (st.size > 0) {
          resolve({ ok: true, stderr: '' });
        } else {
          try { fs.unlinkSync(destPath); } catch (_) {}
          resolve({ ok: false, stderr: 'empty_output' });
        }
      } catch (_) {
        resolve({ ok: false, stderr });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: err.message });
    });
  });
}

// Note: there is deliberately no "H.265 fallback" here. A previous one passed
// `-c:v libx265` alongside a .jpg output, which sets the OUTPUT encoder rather
// than the input decoder — JPEG cannot be encoded with libx265, so that path
// failed every single time it ran. FFmpeg picks the decoder from the stream on
// its own, so H.265 cameras already work through tryFfmpegOneFrame.

async function captureRtspJpegToFile(camera, destPath, opts = {}) {
  const {
    timeoutPerUrlMs = 8000,
    onAttempt,
    parallel = false,
    parallelFallbackLimit = 3,
    fallbackTimeoutMs = 2500,
    totalBudgetMs = 12000,
  } = opts;

  const serial = String(camera.ipAddress || '').trim();

  const hasLocalRtsp = Boolean(String(camera.rtspHost || '').trim());
  const hasVerify = Boolean(String(camera.verifyCode || '').trim());

  let streamInfo;
  if (hasLocalRtsp && hasVerify) {
    const raw = String(camera.rtspHost).trim();
    const [host, portPart] = raw.includes(':') ? raw.split(':') : [raw, '554'];
    streamInfo = {
      localIp: host.trim(),
      rtspPort: (portPart || '554').trim(),
      camKey: String(camera.verifyCode).trim(),
    };
    console.log(`[rtspCapture] Using DB rtspHost: ${streamInfo.localIp}:${streamInfo.rtspPort}`);
  } else {
    try {
      streamInfo = await ezviz.getRtspInfo(serial, { timeout: 12_000 });
      if (camera.verifyCode) streamInfo.camKey = String(camera.verifyCode).trim();
    } catch (err) {
      console.warn(`[rtspCapture] getRtspInfo(${serial}): ${err.message}`);
      return false;
    }
  }

  if (!streamInfo.camKey) {
    console.warn('[rtspCapture] No Verify Code — RTSP auth will fail for EZVIZ');
  }

  const candidates = buildFastCandidates(streamInfo);
  console.log(`[rtspCapture] Probing ${candidates.length} URLs → ${streamInfo.localIp}:${streamInfo.rtspPort || 554} (TCP+UDP each, sub-first)`);

  if (parallel) {
    const fastCandidates = candidates.slice(0, Math.min(candidates.length, 1 + parallelFallbackLimit));
    const runOne = async (c, idx) => {
      const timeout = idx === 0 ? timeoutPerUrlMs : fallbackTimeoutMs;
      const tmpDest = path.join(
        os.tmpdir(),
        `vg_rtsp_par_${process.pid}_${idx}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.jpg`
      );
      try {
        const r = await Promise.race([
          tryFfmpegOneFrame(c.url, tmpDest, timeout, 'tcp').then((res) => ({ ...res, type: c.type, tmpDest })),
          new Promise((resolve) =>
            setTimeout(() => resolve({ ok: false, stderr: 'timeout', type: c.type, tmpDest }), timeout)
          ),
        ]);
        return { ...r, tmpDest };
      } catch (e) {
        return { ok: false, stderr: String(e.message), type: c.type, tmpDest };
      }
    };

    const results = await Promise.all(fastCandidates.map((c, idx) => runOne(c, idx)));
    const winner = results.find((r) => r && r.ok && r.tmpDest);

    if (winner && winner.tmpDest) {
      try {
        fs.copyFileSync(winner.tmpDest, destPath);
      } catch (e) {
        console.warn(`[rtspCapture] parallel copy: ${e.message}`);
      }
    }

    for (const r of results) {
      if (!r.tmpDest) continue;
      try {
        if (fs.existsSync(r.tmpDest)) fs.unlinkSync(r.tmpDest);
      } catch (_) {}
    }

    if (winner && fs.existsSync(destPath) && fs.statSync(destPath).size > 0) {
      const size = fs.statSync(destPath).size;
      console.log(`[rtspCapture] Parallel OK via ${winner.type}, size=${size}`);
      return true;
    }

    console.warn(`[rtspCapture] All parallel candidates failed for "${serial}"${onLan(streamInfo.localIp) ? ''
      : ` — IP "${streamInfo.localIp}" is not on this machine's LAN`}`);
    return false;
  }

  // Full mode: try all candidates with TCP + UDP, long timeout
  const budgetStart = totalBudgetMs > 0 ? Date.now() : 0;
  for (const c of candidates) {
    if (totalBudgetMs > 0 && Date.now() - budgetStart >= totalBudgetMs) {
      console.log(`[rtspCapture] Total budget (${totalBudgetMs}ms) exceeded — giving up`);
      break;
    }
    if (onAttempt) onAttempt(c);
    const { ok: okTcp, stderr: errTcp } = await tryFfmpegOneFrame(c.url, destPath, timeoutPerUrlMs, 'tcp');
    if (okTcp) {
      const size = fs.statSync(destPath).size;
      console.log(`[rtspCapture] OK via ${c.type} (TCP), size=${size}`);
      return true;
    }
    if (errTcp === 'timeout') {
      console.log(`[rtspCapture] ${c.type} (TCP): timeout after ${timeoutPerUrlMs}ms`);
    } else if (errTcp) {
      console.warn(`[rtspCapture] ${c.type} (TCP): ${String(errTcp).slice(0, 200)}`);
    }

    if (totalBudgetMs > 0 && Date.now() - budgetStart >= totalBudgetMs) {
      console.log(`[rtspCapture] Budget exhausted after TCP for ${c.type}`);
      break;
    }
    const { ok: okUdp, stderr: errUdp } = await tryFfmpegOneFrame(c.url, destPath, timeoutPerUrlMs, 'udp');
    if (okUdp) {
      const size = fs.statSync(destPath).size;
      console.log(`[rtspCapture] OK via ${c.type} (UDP), size=${size}`);
      return true;
    }
    if (errUdp === 'timeout') {
      console.log(`[rtspCapture] ${c.type} (UDP): timeout after ${timeoutPerUrlMs}ms`);
    } else if (errUdp) {
      console.warn(`[rtspCapture] ${c.type} (UDP): ${String(errUdp).slice(0, 200)}`);
    }
  }

  console.warn(`[rtspCapture] All ${candidates.length} candidates failed for "${serial}" (IP=${streamInfo.localIp}).`);
  if (onLan(streamInfo.localIp)) {
    console.warn(`[rtspCapture] Suggestions: 1) Verify camera RTSP is enabled in its web UI. 2) Check firewall allows port ${streamInfo.rtspPort || 554}. 3) Confirm verifyCode is correct. 4) Try opening rtsp://${streamInfo.localIp}:${streamInfo.rtspPort || 554} in VLC to validate.`);
  } else {
    console.warn(`[rtspCapture] "${streamInfo.localIp}" is not a private address reachable from here — the camera is probably on another network. Clear the camera's rtspHost and let it stream over the EZVIZ cloud.`);
  }
  return false;
}

const HLS_MAX_SEGMENT_AGE_MS = parseInt(process.env.WATCH_HLS_MAX_AGE_MS || '20000', 10);

async function captureFromHlsSegment(cameraId, destPath, timeoutMs = 8000, maxAgeMs = HLS_MAX_SEGMENT_AGE_MS) {
  const { spawn } = require('child_process');
  const ffmpegBin = getFfmpegPath();
  const outDir = path.join(STREAMS_DIR, cameraId);
  const hlsM3u8 = path.join(outDir, 'stream.m3u8');

  return new Promise((resolve) => {
    // Check HLS manifest exists and has .ts files
    if (!fs.existsSync(hlsM3u8)) {
      resolve({ ok: false, stderr: 'no_hls_manifest' });
      return;
    }

    const tsFiles = fs.readdirSync(outDir).filter((f) => f.endsWith('.ts'));
    if (tsFiles.length === 0) {
      resolve({ ok: false, stderr: 'no_ts_segments' });
      return;
    }

    // Pick the most recent .ts segment (sorted by name, which is seg_XXX.ts with increasing numbers)
    const latestTs = tsFiles.sort().at(-1);
    const tsPath = path.join(outDir, latestTs);

    // Freshness guard: a leftover segment from a previous session/day would make
    // the watcher "detect" whoever was in frame back then. Refuse anything older
    // than maxAgeMs so analysis only ever runs on a live segment.
    try {
      const ageMs = Date.now() - fs.statSync(tsPath).mtimeMs;
      if (ageMs > maxAgeMs) {
        resolve({ ok: false, stderr: `stale_segment_${Math.round(ageMs / 1000)}s` });
        return;
      }
    } catch (_) {
      resolve({ ok: false, stderr: 'segment_stat_failed' });
      return;
    }

    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-i', tsPath,
      '-frames:v', '1',
      '-q:v', '3',
      '-y',
      destPath,
    ];

    const proc = spawn(ffmpegBin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: 'hls_timeout' });
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        try { fs.unlinkSync(destPath); } catch (_) {}
        resolve({ ok: false, stderr });
        return;
      }
      try {
        const st = fs.statSync(destPath);
        if (st.size > 0) {
          resolve({ ok: true, stderr: '' });
        } else {
          try { fs.unlinkSync(destPath); } catch (_) {}
          resolve({ ok: false, stderr: 'hls_empty_output' });
        }
      } catch (_) {
        resolve({ ok: false, stderr });
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      try { fs.unlinkSync(destPath); } catch (_) {}
      resolve({ ok: false, stderr: err.message });
    });
  });
}

async function probeRtspSnapshot(camera, timeoutPerUrlMs = 16000) {
  const tmp = path.join(os.tmpdir(), `vg_rtsp_probe_${process.pid}_${Date.now()}.jpg`);
  try {
    return await captureRtspJpegToFile(camera, tmp, { timeoutPerUrlMs, parallel: true });
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
}

module.exports = { captureRtspJpegToFile, probeRtspSnapshot, captureFromHlsSegment };
