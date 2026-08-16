import { useState } from 'react';
import { isIpWebcamAddress } from '../utils/cameraSource';

const EMPTY = {
  name: '',
  location: '',
  // 'ip' is the only type the rest of the app acts on — the address, RTSP and
  // watch settings below are all gated on it. Defaulting to 'manual' produced a
  // camera with no address, which every feature then rejects as "no IP".
  type: 'ip',
  ipAddress: '',
  status: 'offline',
  verifyCode: '',
  rtspHost: '',
  autoWatch: false,
  watchMinConfidence: 0.4,
  watchMinPersonSize: 0,
  watchDetectTargets: ['person', 'vehicle'],
};

/** What the backend will make of the address the user typed. */
function describeAddress(addr) {
  const s = String(addr || '').trim();
  if (!s) return null;
  if (isIpWebcamAddress(s)) return { kind: 'ip', text: 'Nhận diện: IP / URL — dùng luồng trực tiếp trong LAN.' };
  if (/^[A-Za-z0-9_-]+$/.test(s)) return { kind: 'ezviz', text: 'Nhận diện: EZVIZ serial — dùng cloud, nên khai báo thêm RTSP Host để xem trực tiếp.' };
  return { kind: 'bad', text: 'Không nhận diện được: serial chỉ gồm chữ, số, "-" và "_"; địa chỉ IP dạng 192.168.1.50 hoặc http://...' };
}

export default function CameraForm({ initial, onSubmit, onCancel }) {
  const isEdit = Boolean(initial);
  const [form, setForm] = useState(() => {
    if (!initial) return { ...EMPTY };
    return {
      ...EMPTY,
      ...initial,
      watchDetectTargets: initial.watchDetectTargets?.length
        ? initial.watchDetectTargets
        : ['person', 'vehicle'],
    };
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const handleChange = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const handleTargetToggle = (target) => {
    setForm((prev) => {
      const current = prev.watchDetectTargets || [];
      const next = current.includes(target)
        ? current.filter((t) => t !== target)
        : [...current, target];
      // Never allow an empty list: the watcher reads `targets || default` and an
      // empty array is truthy, so it would silently detect nothing at all.
      return { ...prev, watchDetectTargets: next.length > 0 ? next : current };
    });
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (saving) return; // a second click must not create a second camera
    setSaving(true);
    setError(null);
    try {
      await onSubmit({
        ...form,
        name: form.name.trim(),
        location: (form.location || '').trim(),
        ipAddress: (form.ipAddress || '').trim(),
        rtspHost: (form.rtspHost || '').trim(),
        verifyCode: (form.verifyCode || '').trim(),
      });
      // On success the parent unmounts this form, so `saving` is left as-is.
    } catch (err) {
      setError(err?.message || 'Lưu thất bại — vui lòng thử lại.');
      setSaving(false);
    }
  };

  const addressInfo = form.type === 'ip' ? describeAddress(form.ipAddress) : null;

  const hintStyle = { fontSize: 11, marginTop: 2, display: 'block' };
  const subLabelStyle = { fontSize: 12, fontWeight: 600, marginBottom: 4 };
  const rangeCapStyle = {
    display: 'flex', justifyContent: 'space-between',
    fontSize: 10, color: 'var(--color-text-secondary)',
  };

  return (
    <form className="camera-form" onSubmit={handleSubmit}>
      <div className="form-group">
        <label>Tên camera *</label>
        <input
          required
          value={form.name}
          onChange={(e) => handleChange('name', e.target.value)}
          placeholder="Cổng trước"
        />
      </div>
      <div className="form-group">
        <label>Vị trí</label>
        <input
          value={form.location}
          onChange={(e) => handleChange('location', e.target.value)}
          placeholder="Sân trước"
        />
      </div>
      <div className="form-group">
        <label>Loại</label>
        <select value={form.type} onChange={(e) => handleChange('type', e.target.value)}>
          <option value="ip">IP Camera</option>
          <option value="webhook">Webhook</option>
          <option value="manual">Manual</option>
        </select>
      </div>
      {form.type === 'ip' && (
        <>
          <div className="form-group">
            <label>Địa chỉ IP / Serial *</label>
            <input
              required
              value={form.ipAddress}
              onChange={(e) => handleChange('ipAddress', e.target.value)}
              placeholder="192.168.1.100 hoặc EZVIZ serial"
            />
            {addressInfo && (
              <span
                className={addressInfo.kind === 'bad' ? undefined : 'text-muted'}
                style={{ ...hintStyle, color: addressInfo.kind === 'bad' ? 'var(--red)' : undefined }}
              >
                {addressInfo.text}
              </span>
            )}
          </div>
          <div className="form-group">
            <label>RTSP Host (IP trong LAN)</label>
            <input
              value={form.rtspHost || ''}
              onChange={(e) => handleChange('rtspHost', e.target.value)}
              placeholder="192.168.0.100:554"
            />
            <span className="text-muted" style={{ fontSize: 12 }}>
              IP:port trong LAN (vd 192.168.1.50:554). Bắt buộc nếu cloud trả sai IP hoặc Auto Watch/xem trực tiếp lỗi — máy chạy backend phải ping được IP này.
            </span>
          </div>
          <div className="form-group">
            <label>Mã xác thực RTSP (Verify Code)</label>
            <input
              value={form.verifyCode || ''}
              onChange={(e) => handleChange('verifyCode', e.target.value)}
              placeholder="Mã xác thực camera (mặt sau camera)"
            />
            <span className="text-muted" style={{ fontSize: 12 }}>
              Xem mặt sau camera hoặc EZVIZ App → Cài đặt. Thiếu mã này thì chụp khung hình qua RTSP sẽ bị bỏ qua.
            </span>
          </div>
          <div className="form-group">
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={Boolean(form.autoWatch)}
                onChange={(e) => handleChange('autoWatch', e.target.checked)}
              />
              <span>Lưu auto-watch — tự chạy lại sau khi restart backend (cần RESTORE_AUTOWATCH_ON_START=true trong .env)</span>
            </label>
          </div>

          {/* Watch Settings */}
          <div style={{
            marginTop: 8,
            border: '1px solid var(--color-border-secondary)',
            borderRadius: 8,
            overflow: 'hidden',
          }}>
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              style={{
                width: '100%',
                padding: '8px 12px',
                background: 'var(--color-background-secondary)',
                border: 'none',
                cursor: 'pointer',
                textAlign: 'left',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--color-text-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <span>⚙️ Cài đặt Watch nâng cao</span>
              <span style={{ fontSize: 11, color: 'var(--color-text-secondary)' }}>{showAdvanced ? '▲' : '▼'}</span>
            </button>

            {showAdvanced && (
              <div style={{ padding: 12, background: 'var(--color-background-secondary)' }}>
                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label style={subLabelStyle}>Mục tiêu phát hiện</label>
                  <div style={{ display: 'flex', gap: 12, marginTop: 4 }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={(form.watchDetectTargets || []).includes('person')}
                        onChange={() => handleTargetToggle('person')}
                      />
                      <span>🧑 Người</span>
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                      <input
                        type="checkbox"
                        checked={(form.watchDetectTargets || []).includes('vehicle')}
                        onChange={() => handleTargetToggle('vehicle')}
                      />
                      <span>🚗 Xe</span>
                    </label>
                  </div>
                  <span className="text-muted" style={hintStyle}>
                    Chọn loại đối tượng sẽ kích hoạt tự động chụp ảnh. Phải chọn ít nhất một.
                  </span>
                </div>

                <div className="form-group" style={{ marginBottom: 12 }}>
                  <label style={subLabelStyle}>
                    Độ tin cậy tối thiểu:{' '}
                    <span style={{ color: 'var(--green)', fontWeight: 700 }}>
                      {(form.watchMinConfidence ?? 0.4).toFixed(2)}
                    </span>
                  </label>
                  <input
                    type="range"
                    min="0.2"
                    max="0.9"
                    step="0.05"
                    value={form.watchMinConfidence ?? 0.4}
                    onChange={(e) => handleChange('watchMinConfidence', parseFloat(e.target.value))}
                    style={{ width: '100%', accentColor: 'var(--green)' }}
                  />
                  <div style={rangeCapStyle}>
                    <span>0.2 (nhạy)</span>
                    <span>0.9 (chính xác)</span>
                  </div>
                  <span className="text-muted" style={hintStyle}>
                    Giá trị thấp = phát hiện nhiều hơn (có thể nhiễu). Giá trị cao = ít hơn nhưng chính xác hơn.
                  </span>
                </div>

                <div className="form-group" style={{ marginBottom: 0 }}>
                  <label style={subLabelStyle}>
                    Kích thước bbox tối thiểu (px²):{' '}
                    <span style={{ color: 'var(--green)', fontWeight: 700 }}>
                      {form.watchMinPersonSize || 0}
                    </span>
                  </label>
                  <input
                    type="range"
                    min="0"
                    max="50000"
                    step="1000"
                    value={form.watchMinPersonSize || 0}
                    onChange={(e) => handleChange('watchMinPersonSize', parseInt(e.target.value, 10))}
                    style={{ width: '100%', accentColor: 'var(--green)' }}
                  />
                  <div style={rangeCapStyle}>
                    <span>0 (tất cả)</span>
                    <span>50000 (chỉ gần)</span>
                  </div>
                  <span className="text-muted" style={hintStyle}>
                    Chỉ phát hiện người có kích thước đủ lớn (gần camera). 0 = tất cả kích thước.
                  </span>
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Status is set by the backend on the first successful connection, so it
          is only worth showing as a manual correction on an existing camera. */}
      {isEdit && (
        <div className="form-group">
          <label>Trạng thái</label>
          <select value={form.status} onChange={(e) => handleChange('status', e.target.value)}>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
          </select>
          <span className="text-muted" style={{ fontSize: 12 }}>
            Tự chuyển sang Online khi kết nối được camera.
          </span>
        </div>
      )}

      {error && (
        <div style={{
          padding: '8px 12px',
          borderRadius: 6,
          fontSize: 13,
          color: 'var(--red)',
          background: 'var(--red-light)',
        }}>
          {error}
        </div>
      )}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? 'Đang lưu...' : isEdit ? 'Lưu thay đổi' : 'Thêm camera'}
        </button>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel} disabled={saving}>
            Hủy
          </button>
        )}
      </div>
    </form>
  );
}
