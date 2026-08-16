import { useEffect, useRef, useState, useCallback } from 'react';
import { Volume2, VolumeX, Maximize, Radio, ScanEye } from 'lucide-react';
import PersonDetectionOverlay from './PersonDetectionOverlay';

export default function HlsPlayer({
  src,
  autoPlay = true,
  muted = true,
  className,
  style,
  poster,
  onError,
  detectOverlay = false,
  detectDefault = true,
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const stageRef = useRef(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isMuted, setIsMuted] = useState(muted);
  const retryTimerRef = useRef(null);

  // ── Real-time person-detection overlay ──
  // `detectOverlay` enables the feature (shows the AI toggle); `detectDefault`
  // controls whether it starts on. Grid tiles pass detectDefault={false} so four
  // players don't all spin up tfjs at once.
  const [detectOn, setDetectOn] = useState(detectOverlay && detectDefault);
  const [personCount, setPersonCount] = useState(0);
  const onPersonCount = useCallback((n) => setPersonCount(n), []);

  const clearRetry = () => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  };

  const scheduleRetry = (hls) => {
    clearRetry();
    retryTimerRef.current = setTimeout(() => {
      if (!src || !hlsRef.current) return;
      try {
        hls.stopLoad();
        hls.startLoad();
      } catch (_) {}
    }, 3000);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return undefined;

    clearRetry();
    setError(null);
    setLoading(true);

    const nativeMpegUrl = video.canPlayType('application/vnd.apple.mpegurl');
    const manifestUrl = src.startsWith('http')
      ? src
      : new URL(src, window.location.origin).href;

    // Named handlers so they can be detached on cleanup. Previously these were
    // anonymous and never removed, so every src change stacked another set of
    // listeners on the same <video>.
    const onPlaying = () => { setError(null); setLoading(false); };
    const onWaiting = () => setLoading(true);
    const onCanPlay = () => setLoading(false);

    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('canplay', onCanPlay);

    const detachVideoEvents = () => {
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('canplay', onCanPlay);
    };

    if (nativeMpegUrl === 'probably') {
      video.src = manifestUrl;
      video.load();
      if (autoPlay) video.play().catch(() => {});
      return detachVideoEvents;
    }

    // hls.js is by far the heaviest dependency in the app and is only needed on
    // browsers without native HLS, and only once a stream is actually shown.
    // Loading it on demand keeps it out of the initial bundle.
    let cancelled = false;
    let hls = null;

    import('hls.js')
      .then(({ default: Hls }) => {
        if (cancelled) return;

        if (!Hls.isSupported()) {
          setError('HLS not supported in this browser');
          setLoading(false);
          return;
        }

        hls = new Hls({
          enableWorker: true,
          lowLatencyMode: true,
          liveSyncDurationCount: 2,
          liveMaxLatencyDurationCount: 5,
          maxBufferLength: 8,
          maxMaxBufferLength: 15,
          backBufferLength: 5,
          liveDurationInfinity: true,
          manifestLoadingMaxRetry: 6,
          manifestLoadingRetryDelay: 500,
          levelLoadingMaxRetry: 6,
          levelLoadingRetryDelay: 500,
          fragLoadingMaxRetry: 10,
          fragLoadingRetryDelay: 500,
          startLevel: -1,
          nudgeMaxRetry: 5,
          nudgeOffset: 0.2,
        });

        hlsRef.current = hls;
        hls.loadSource(manifestUrl);
        hls.attachMedia(video);

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (autoPlay) video.play().catch(() => {});
        });

        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;

          const msg = `HLS error: ${data.type} / ${data.details}`;
          console.warn(`[HlsPlayer] ${msg}`);

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              setError('Lỗi mạng — đang thử lại...');
              scheduleRetry(hls);
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              setError('Lỗi media — đang khôi phục...');
              hls.recoverMediaError();
              retryTimerRef.current = setTimeout(() => {
                if (hlsRef.current) setError(null);
              }, 5000);
              break;
            case Hls.ErrorTypes.KEY_SYSTEM_ERROR:
            case Hls.ErrorTypes.M3U8_ERROR:
            case Hls.ErrorTypes.OTHER_ERROR:
            default:
              setError(msg);
              if (onError) onError(msg);
              hls.destroy();
              hlsRef.current = null;
              break;
          }
        });
      })
      .catch(() => {
        if (cancelled) return;
        setError('Không tải được trình phát HLS');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      clearRetry();
      detachVideoEvents();
      if (hls) hls.destroy();
      hlsRef.current = null;
    };
  }, [src, autoPlay, onError]);

  // Jump back to the live edge — the low-latency config keeps a short buffer,
  // but a stalled tab can still drift behind. One button to resync.
  const goLive = useCallback(() => {
    const v = videoRef.current;
    const hls = hlsRef.current;
    if (!v) return;
    try {
      if (hls && hls.liveSyncPosition != null) {
        v.currentTime = hls.liveSyncPosition;
      } else if (v.seekable && v.seekable.length) {
        v.currentTime = v.seekable.end(v.seekable.length - 1);
      }
      v.play().catch(() => {});
    } catch (_) {}
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setIsMuted(v.muted);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      el.requestFullscreen?.();
    }
  }, []);

  return (
    <div
      ref={stageRef}
      className={`hls-player-root${className ? ` ${className}` : ''}`}
      style={{ position: 'relative', background: '#000', ...style }}
    >
      <video
        ref={videoRef}
        muted={isMuted}
        playsInline
        poster={poster}
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain' }}
      />

      {/* Real-time person detection boxes drawn over the video */}
      {detectOverlay && (
        <PersonDetectionOverlay videoRef={videoRef} active={detectOn} onCount={onPersonCount} />
      )}

      {/* Person-count badge while detection is on */}
      {detectOverlay && detectOn && personCount > 0 && (
        <div className="hls-detect-badge">
          <ScanEye size={13} /> {personCount} người
        </div>
      )}

      {/* Playback controls */}
      {!error && (
        <div className="hls-controls">
          <button className="hls-ctrl" onClick={goLive} title="Về thời gian thực" aria-label="Về thời gian thực">
            <Radio size={14} /> LIVE
          </button>
          <button className="hls-ctrl" onClick={toggleMute} title={isMuted ? 'Bật tiếng' : 'Tắt tiếng'} aria-label="Bật/tắt tiếng">
            {isMuted ? <VolumeX size={14} /> : <Volume2 size={14} />}
          </button>
          <button className="hls-ctrl" onClick={toggleFullscreen} title="Toàn màn hình" aria-label="Toàn màn hình">
            <Maximize size={14} />
          </button>
          {detectOverlay && (
            <button
              className={`hls-ctrl${detectOn ? ' active' : ''}`}
              onClick={() => setDetectOn((v) => !v)}
              title={detectOn ? 'Tắt nhận diện người' : 'Bật nhận diện người'}
              aria-label="Bật/tắt nhận diện người"
            >
              <ScanEye size={14} /> AI
            </button>
          )}
        </div>
      )}

      {loading && !error && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.6)', color: '#fff', fontSize: 13, gap: 8,
        }}>
          <div className="spinner" style={{
            width: 28, height: 28, border: '3px solid rgba(255,255,255,0.2)',
            borderTop: '3px solid #10b981', borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }} />
          <span>Đang tải stream...</span>
        </div>
      )}
      {error && (
        <div style={{
          position: 'absolute', inset: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.7)', color: '#f97316', fontSize: 13, padding: 16, textAlign: 'center',
        }}>
          {error}
        </div>
      )}
    </div>
  );
}
