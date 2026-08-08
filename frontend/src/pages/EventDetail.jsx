import { useEffect, useState, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { Trash2, RefreshCw, ArrowLeft, User, Car, CreditCard, Eye, EyeOff, ChevronLeft, ChevronRight, Video } from 'lucide-react';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';
import AnalysisOverlay from '../components/AnalysisOverlay';
import ClipPlayer from '../components/ClipPlayer';

export default function EventDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const imgRef = useRef(null);
  const [event, setEvent] = useState(null);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0, nw: 0, nh: 0 });
  const [loading, setLoading] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [timeline, setTimeline] = useState([]);

  // Neighbours are fetched RELATIVE to this event's timestamp, not by locating it
  // inside a fixed page of the newest events. The old approach broke as soon as
  // the event was older than that page: findIndex returned -1, and `-1 + 1` made
  // the "next" button jump to the newest event of the camera instead of the
  // adjacent one. Anchoring on capturedAt also lets you walk the whole history
  // rather than stopping at the tenth event.
  const [older, setOlder] = useState(null);   // earlier in time
  const [newer, setNewer] = useState(null);   // later in time

  useEffect(() => {
    let cancelled = false;
    api.getEvent(id).then(async (ev) => {
      if (cancelled) return;
      setEvent(ev);
      const camId = ev.cameraId?._id;
      if (!camId) { setTimeline([]); setOlder(null); setNewer(null); return; }
      try {
        const [olderRes, newerRes] = await Promise.all([
          api.getEvents({ cameraId: camId, dateTo: ev.capturedAt, limit: 6 }),
          api.getEvents({ cameraId: camId, dateFrom: ev.capturedAt, limit: 6, sort: 'asc' }),
        ]);
        if (cancelled) return;
        const olderList = (olderRes.events || []).filter((e) => e._id !== ev._id);
        const newerList = (newerRes.events || []).filter((e) => e._id !== ev._id);
        setOlder(olderList[0] || null);
        setNewer(newerList[0] || null);
        // Newest first, with the current event always present and in the middle.
        setTimeline([...newerList.slice(0, 5).reverse(), ev, ...olderList.slice(0, 5)]);
      } catch { /* navigation still works without the side list */ }
    }).catch(() => navigate('/events'));
    return () => { cancelled = true; };
  }, [id, navigate]);

  const handleImgLoad = () => {
    const img = imgRef.current;
    if (!img) return;
    setImgSize({ w: img.width, h: img.height, nw: img.naturalWidth, nh: img.naturalHeight });
  };

  const handleDelete = async () => {
    if (!confirm('Xóa sự kiện này?')) return;
    await api.deleteEvent(id);
    navigate('/events');
  };

  const handleReanalyze = async () => {
    setLoading(true);
    try {
      const updated = await api.reanalyze(id);
      setEvent(updated);
    } finally {
      setLoading(false);
    }
  };

  // Return to the page the user actually came from (Biển số xe, Tra cứu,
  // Dashboard…), not a hardcoded /events. React Router keeps a history index in
  // history.state.idx; idx > 0 means there is a previous in-app entry to pop.
  const goBack = () => {
    if (window.history.state?.idx > 0) navigate(-1);
    else navigate('/events');
  };

  // Left goes back in time, right goes forward — matching the "trước/sau" labels.
  // Previously left moved up a newest-first list, i.e. towards NEWER events.
  useEffect(() => {
    const handler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'ArrowLeft' && older) navigate(`/events/${older._id}`);
      else if (e.key === 'ArrowRight' && newer) navigate(`/events/${newer._id}`);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [older, newer, navigate]);

  if (!event) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <div className="skeleton" style={{ width: 200, height: 20, margin: '0 auto 12px' }} />
        <div className="skeleton" style={{ width: '100%', height: 300, borderRadius: 8 }} />
      </div>
    );
  }

  const { analysis } = event;
  const tagLabel = (t) => {
    const map = {
      'auto-watch': 'Auto-watch',
      person: 'Người',
      vehicle: 'Xe',
      plate: 'Biển số',
      stranger: 'NGƯỜI LẠ',
      'known-person': 'Người quen',
    };
    return map[t] || t;
  };
  return (
    <>
      <div className="detail-header">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={goBack} aria-label="Quay lại">
            <ArrowLeft size={14} /> Quay lại
          </button>
          {older && (
            <Link
              to={`/events/${older._id}`}
              className="btn btn-sm"
              aria-label="Sự kiện trước đó"
              title={`Trước đó — ${format(new Date(older.capturedAt), 'HH:mm:ss')}`}
            >
              <ChevronLeft size={14} />
            </Link>
          )}
          {newer && (
            <Link
              to={`/events/${newer._id}`}
              className="btn btn-sm"
              aria-label="Sự kiện sau đó"
              title={`Sau đó — ${format(new Date(newer.capturedAt), 'HH:mm:ss')}`}
            >
              <ChevronRight size={14} />
            </Link>
          )}
        </div>
        <div className="detail-actions">
          <button
            className="btn btn-sm"
            onClick={() => setShowOverlay((s) => !s)}
            aria-label={showOverlay ? 'Ẩn bounding box' : 'Hiện bounding box'}
          >
            {showOverlay ? <EyeOff size={14} /> : <Eye size={14} />}
            {showOverlay ? ' Ẩn overlay' : ' Hiện overlay'}
          </button>
          <button className="btn" onClick={handleReanalyze} disabled={loading} aria-label="Phân tích lại">
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> Phân tích lại
          </button>
          <button className="btn btn-danger" onClick={handleDelete} aria-label="Xóa sự kiện">
            <Trash2 size={14} /> Xóa
          </button>
        </div>
      </div>

      <div className="detail-body">
        <div className="detail-image-wrap">
          {event.type === 'clip' ? (
            <ClipPlayer
              videoPath={event.videoPath}
              gifPath={event.gifPath}
              thumbnailPath={event.thumbnailPath}
              alt="Clip"
            />
          ) : (
            <img
              ref={imgRef}
              src={uploadsUrl(event.imagePath)}
              alt="capture"
              className="detail-image"
              onLoad={handleImgLoad}
            />
          )}
          {event.type !== 'clip' && showOverlay && (
            <AnalysisOverlay
              analysis={analysis}
              imgWidth={imgSize.w}
              imgHeight={imgSize.h}
              naturalWidth={imgSize.nw}
              naturalHeight={imgSize.nh}
            />
          )}
        </div>

        <div className="detail-info">
          <h2>Thông tin sự kiện</h2>
          <div className="info-row"><strong>Camera:</strong> {event.cameraId?.name || 'Không rõ'}</div>
          <div className="info-row"><strong>Vị trí:</strong> {event.cameraId?.location || '-'}</div>
          <div className="info-row"><strong>Thời gian:</strong> {format(new Date(event.capturedAt), 'dd/MM/yyyy HH:mm:ss')}</div>
          {event.type === 'clip' && event.clipDuration && (
            <div className="info-row">
              <strong>Thời lượng clip:</strong> {event.clipDuration}s
            </div>
          )}
          {event.type === 'clip' && event.recordingStart && (
            <div className="info-row">
              <strong>Recording:</strong> {format(new Date(event.recordingStart), 'HH:mm:ss')} — {format(new Date(event.recordingEnd || event.recordingStart), 'HH:mm:ss')}
            </div>
          )}
          {event.notes && <div className="info-row"><strong>Ghi chú:</strong> {event.notes}</div>}

          <h3>Kết quả phân tích</h3>

          {Array.isArray(event.tags) && event.tags.length > 0 && (
            <div className="event-card-tags" style={{ marginBottom: 10 }}>
              {event.tags.map((t) => (
                <span key={t} className="tag tag-warn">{tagLabel(t)}</span>
              ))}
            </div>
          )}

          {analysis?.persons?.length > 0 && (
            <div className="analysis-section">
              <h4><User size={14} /> Người ({analysis.persons.length})</h4>
              {analysis.persons.map((p, i) => (
                <div key={i} className="analysis-item">Người #{i + 1} — Tin cậy: {(p.confidence * 100).toFixed(0)}%</div>
              ))}
            </div>
          )}

          {analysis?.vehicles?.length > 0 && (
            <div className="analysis-section">
              <h4><Car size={14} /> Phương tiện ({analysis.vehicles.length})</h4>
              {analysis.vehicles.map((v, i) => (
                <div key={i} className="analysis-item">{v.type} — Tin cậy: {(v.confidence * 100).toFixed(0)}%</div>
              ))}
            </div>
          )}

          {analysis?.licensePlates?.length > 0 && (
            <div className="analysis-section">
              <h4><CreditCard size={14} /> Biển số ({analysis.licensePlates.length})</h4>
              {analysis.licensePlates.map((lp, i) => (
                <div key={i} className="analysis-item plate-number">{lp.plateNumber} — {(lp.confidence * 100).toFixed(0)}%</div>
              ))}
            </div>
          )}

          {timeline.length > 1 && (
            <div className="timeline-section">
              <h4>Sự kiện cùng camera</h4>
              <div className="timeline-list">
                {timeline.map((ev) => (
                  <Link
                    key={ev._id}
                    to={`/events/${ev._id}`}
                    className={`timeline-item${ev._id === id ? ' current' : ''}`}
                  >
                    <span className="timeline-time">{format(new Date(ev.capturedAt), 'HH:mm:ss')}</span>
                    <span className="timeline-desc">
                      {ev.tags?.includes('person') ? 'Người' : ev.tags?.includes('vehicle') ? 'Phương tiện' : 'Sự kiện'}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
