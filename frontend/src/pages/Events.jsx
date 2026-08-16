import { useEffect, useState, useCallback, useRef, memo } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, X, LayoutList, Table } from 'lucide-react';
import { format } from 'date-fns';
import { api, uploadsUrl } from '../api';

// This page is the merge of the old "Sự kiện" list and the old "Tra cứu" table:
// both queried GET /api/events with overlapping filters and kept two drifting
// copies of the same tag/description helpers. One page, two presentations.

const PAGE_SIZE = 20;
const EMPTY_DATA = { events: [], total: 0, page: 1, totalPages: 1 };
const DEBOUNCE_MS = 400;
const VIEW_KEY = 'events-view';

// ─── Helpers (stable references, không re-create mỗi render) ───────────────

const TAG_CONFIG = {
  stranger:        { cls: 'tag-alert',   label: 'Người lạ' },
  plate:           { cls: 'tag-plate',   label: 'Biển số' },
  'license-plate': { cls: 'tag-plate',   label: 'Biển số' },
  'known-person':  { cls: 'tag-face',    label: 'Người quen' },
  person:          { cls: 'tag-person',  label: 'Người' },
  vehicle:         { cls: 'tag-vehicle', label: 'Phương tiện' },
  'auto-watch':    { cls: 'tag-ok',      label: 'Auto-watch' },
};

// Explicit priority rather than "first tag that happens to be in the map": an
// event tagged ['auto-watch','stranger'] must read as a stranger alert.
const TAG_PRIORITY = [
  'stranger', 'plate', 'license-plate', 'known-person', 'person', 'vehicle', 'auto-watch',
];

function getTagInfo(tags) {
  if (!tags?.length) return { cls: 'tag-person', label: 'Sự kiện' };
  for (const t of TAG_PRIORITY) {
    if (tags.includes(t)) return TAG_CONFIG[t];
  }
  return { cls: 'tag-alert', label: tags[0] };
}

function getDescription(ev) {
  const { licensePlates, persons, vehicles, faces } = ev.analysis ?? {};
  if (licensePlates?.length) return licensePlates[0].plateNumber;
  // A recognised face is the most specific thing we can say, so it outranks the
  // generic "N người" line.
  const names = [...new Set((faces || []).map((f) => f.name).filter(Boolean))];
  if (names.length) return names.join(', ');
  const camName = ev.cameraId?.name ?? 'Camera';
  if (persons?.length)  return `${persons.length} người tại ${camName}`;
  if (vehicles?.length) return `${vehicles.length} phương tiện tại ${camName}`;
  return `Sự kiện tại ${camName}`;
}

function getThumbStyle(tags) {
  if (tags?.includes('plate') || tags?.includes('license-plate'))
    return { background: '#1a0d00', color: '#FAC775' };
  if (tags?.includes('person'))
    return { background: '#0a1a0a', color: '#5DCAA5' };
  return { background: '#0a0a1a', color: '#AFA9EC' };
}

function getBestConf(ev) {
  const groups = [ev.analysis?.persons, ev.analysis?.licensePlates, ev.analysis?.vehicles];
  for (const g of groups) {
    if (g?.length) {
      const best = Math.max(...g.map((x) => x.confidence ?? 0));
      if (best > 0) return `${(best * 100).toFixed(0)}%`;
    }
  }
  return null;
}

function isVideoEvent(ev) {
  return ev.type === 'clip' || Boolean(ev.videoPath);
}

/**
 * Turn a `<input type="date">` value into an ISO range covering that LOCAL day.
 * `new Date('2026-08-17')` parses as UTC midnight while `'2026-08-17T23:59:59'`
 * parses as local time — mixing the two shifted the window by the UTC offset and
 * dropped the first hours of the day at UTC+7.
 */
function localDayRange(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return [
    new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(),
    new Date(y, m - 1, d, 23, 59, 59, 999).toISOString(),
  ];
}

// ─── Row renderers ──────────────────────────────────────────────────────────

const EventItem = memo(({ ev }) => {
  const { cls, label } = getTagInfo(ev.tags);
  const conf = getBestConf(ev);
  const video = isVideoEvent(ev);

  return (
    <Link to={`/events/${ev._id}`} className="event-item">
      <div
        className="event-thumb"
        style={video ? { background: '#0a0a2a', color: '#a78bfa' } : getThumbStyle(ev.tags)}
      >
        {ev.thumbnailPath
          ? <img src={uploadsUrl(ev.thumbnailPath)} alt="" />
          : <span>{video ? '▶' : '■'}</span>
        }
        {video && ev.videoPath && <span className="video-icon-overlay">▶</span>}
      </div>

      <div className="event-info">
        <div className="event-title">
          <span className={`tag ${cls}`}>{label}</span>
          {getDescription(ev)}
        </div>
        <div className="event-meta">
          {ev.cameraId?.name ?? 'Camera'}
          {' · '}
          {format(new Date(ev.capturedAt), 'HH:mm:ss dd/MM/yyyy')}
          {conf && ` · ${conf}`}
          {video && ev.clipDuration && ` · ${ev.clipDuration}s`}
        </div>
      </div>
    </Link>
  );
});

const EventRow = memo(({ ev }) => {
  const { cls, label } = getTagInfo(ev.tags);
  return (
    <tr>
      <td className="td-time">{format(new Date(ev.capturedAt), 'HH:mm:ss dd/MM/yyyy')}</td>
      <td>{ev.cameraId?.name || '-'}</td>
      <td><span className={`tag ${cls}`}>{label}</span></td>
      <td>{getDescription(ev)}</td>
      <td>
        <div style={{ ...getThumbStyle(ev.tags), width: 40, height: 28, borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 9, overflow: 'hidden' }}>
          {ev.thumbnailPath
            ? <img src={uploadsUrl(ev.thumbnailPath)} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            : 'IMG'}
        </div>
      </td>
      <td>{getBestConf(ev) ?? '-'}</td>
      <td><Link to={`/events/${ev._id}`} className="btn btn-sm">Xem</Link></td>
    </tr>
  );
});

// ─── Main component ─────────────────────────────────────────────────────────

export default function Events() {
  const [cameras, setCameras] = useState([]);
  const [data, setData] = useState(EMPTY_DATA);

  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [cameraFilter, setCameraFilter] = useState('');
  const [dateFilter, setDateFilter] = useState('');
  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [view, setView] = useState(() => {
    try { return localStorage.getItem(VIEW_KEY) === 'table' ? 'table' : 'list'; }
    catch { return 'list'; }
  });

  // Monotonic request id: a slow response from an earlier keystroke must not
  // overwrite the results of a newer one.
  const reqIdRef = useRef(0);

  useEffect(() => { api.getCameras().then(setCameras).catch(() => {}); }, []);

  const switchView = useCallback((v) => {
    setView(v);
    try { localStorage.setItem(VIEW_KEY, v); } catch { /* private mode */ }
  }, []);

  const load = useCallback(async () => {
    const id = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = { page, limit: PAGE_SIZE };
      const q = search.trim();
      if (q) params.search = q;
      if (tagFilter) params.tag = tagFilter;
      if (cameraFilter) params.cameraId = cameraFilter;
      if (dateFilter) {
        const [from, to] = localDayRange(dateFilter);
        params.dateFrom = from;
        params.dateTo = to;
      }
      const d = await api.getEvents(params);
      if (id !== reqIdRef.current) return;
      setData({
        events: d.events || [],
        total: d.total || 0,
        page: d.page || 1,
        totalPages: d.totalPages || 1,
      });
    } catch (err) {
      if (id !== reqIdRef.current) return;
      setError(err.message || 'Không tải được danh sách sự kiện');
      setData(EMPTY_DATA);
    } finally {
      if (id === reqIdRef.current) setLoading(false);
    }
  }, [search, tagFilter, cameraFilter, dateFilter, page]);

  // Debounced auto-search: typing or changing any filter re-queries on its own,
  // so the button is a convenience rather than the only way to get results.
  useEffect(() => {
    const t = setTimeout(load, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [load]);

  // Any filter change invalidates the current page number — staying on page 5 of
  // a result set that no longer exists shows an empty table.
  const onFilterChange = (setter) => (value) => { setter(value); setPage(1); };

  const hasFilters = Boolean(search || tagFilter || cameraFilter || dateFilter);
  const clearFilters = () => {
    setSearch(''); setTagFilter(''); setCameraFilter(''); setDateFilter(''); setPage(1);
  };

  const isEmpty = data.events.length === 0;

  return (
    <div className="card">
      <div className="card-header">
        <span className="card-title">Sự kiện</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span className="text-muted">
            {loading ? 'Đang tải...' : data.total > 0 ? `${data.total} kết quả` : ''}
          </span>
          <div style={{ display: 'flex', gap: 4 }}>
            <button
              className={`btn btn-sm${view === 'list' ? ' btn-primary' : ''}`}
              onClick={() => switchView('list')}
              title="Xem dạng danh sách"
              aria-label="Xem dạng danh sách"
            >
              <LayoutList size={14} />
            </button>
            <button
              className={`btn btn-sm${view === 'table' ? ' btn-primary' : ''}`}
              onClick={() => switchView('table')}
              title="Xem dạng bảng"
              aria-label="Xem dạng bảng"
            >
              <Table size={14} />
            </button>
          </div>
        </div>
      </div>

      <div className="card-body">
        <div className="search-row">
          <input
            className="search-input"
            type="text"
            placeholder="Tìm biển số, tên người, tên camera, ghi chú..."
            value={search}
            onChange={(e) => onFilterChange(setSearch)(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') load(); }}
            style={{ flex: 2 }}
          />
          <select
            className="filter-select"
            value={tagFilter}
            onChange={(e) => onFilterChange(setTagFilter)(e.target.value)}
          >
            <option value="">Tất cả loại</option>
            <option value="person">Người</option>
            <option value="vehicle">Phương tiện</option>
            <option value="plate">Biển số</option>
            <option value="stranger">Người lạ</option>
            <option value="known-person">Người quen</option>
            <option value="auto-watch">Auto-watch</option>
          </select>
          <select
            className="filter-select"
            value={cameraFilter}
            onChange={(e) => onFilterChange(setCameraFilter)(e.target.value)}
          >
            <option value="">Tất cả camera</option>
            {cameras.map((c) => (
              <option key={c._id} value={c._id}>{c.name}</option>
            ))}
          </select>
          <input
            className="search-input"
            type="date"
            style={{ maxWidth: 140 }}
            value={dateFilter}
            onChange={(e) => onFilterChange(setDateFilter)(e.target.value)}
          />
          <button className="btn btn-primary" onClick={load}>Tìm kiếm</button>
          {hasFilters && (
            <button className="btn btn-sm" onClick={clearFilters} title="Xóa bộ lọc">
              <X size={14} /> Xóa lọc
            </button>
          )}
        </div>

        {error ? (
          <div className="empty-text" style={{ color: 'var(--red)' }}>
            {error}
            <div style={{ marginTop: 10 }}>
              <button className="btn btn-sm" onClick={load}>Thử lại</button>
            </div>
          </div>
        ) : isEmpty ? (
          <div className="empty-text">
            {loading
              ? 'Đang tải...'
              : hasFilters
                ? 'Không tìm thấy kết quả phù hợp.'
                : 'Chưa có sự kiện nào.'}
          </div>
        ) : (
          <div style={loading ? { opacity: 0.5, transition: 'opacity .15s ease' } : undefined}>
            {view === 'list' ? (
              <div className="event-list">
                {data.events.map((ev) => <EventItem key={ev._id} ev={ev} />)}
              </div>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Thời gian</th>
                      <th>Camera</th>
                      <th>Loại</th>
                      <th>Chi tiết</th>
                      <th>Hình ảnh</th>
                      <th>Độ tin cậy</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.events.map((ev) => <EventRow key={ev._id} ev={ev} />)}
                  </tbody>
                </table>
              </div>
            )}

            {data.totalPages > 1 && (
              <div className="pagination">
                <button className="btn btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  <ChevronLeft size={14} />
                </button>
                <span>Trang: {data.page} / {data.totalPages}</span>
                <button className="btn btn-sm" disabled={page >= data.totalPages} onClick={() => setPage((p) => p + 1)}>
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
