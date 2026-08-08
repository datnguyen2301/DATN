const COLORS = {
  person: '#22c55e',
  vehicle: '#3b82f6',
  plate: '#f59e0b',
  knownFace: '#16a34a',
  stranger: '#dc2626',
};

export default function AnalysisOverlay({ analysis, imgWidth, imgHeight, naturalWidth, naturalHeight }) {
  if (!analysis || !naturalWidth) return null;

  const scaleX = imgWidth / naturalWidth;
  const scaleY = imgHeight / naturalHeight;

  const boxes = [];

  // An unrecognised person is boxed in red even when no face was detected — the
  // back-turned case is exactly the one worth flagging.
  (analysis.persons || []).forEach((p, i) => {
    boxes.push({
      ...p.bbox,
      label: p.isStranger ? `NGƯỜI LẠ ${(p.confidence * 100).toFixed(0)}%` : `Person ${(p.confidence * 100).toFixed(0)}%`,
      color: p.isStranger ? COLORS.stranger : COLORS.person,
      strokeWidth: p.isStranger ? 3 : 2,
      key: `p${i}`,
    });
  });
  (analysis.vehicles || []).forEach((v, i) => {
    boxes.push({ ...v.bbox, label: `${v.type} ${(v.confidence * 100).toFixed(0)}%`, color: COLORS.vehicle, key: `v${i}` });
  });
  (analysis.licensePlates || []).forEach((lp, i) => {
    boxes.push({ ...lp.bbox, label: lp.plateNumber, color: COLORS.plate, key: `lp${i}` });
  });
  // Faces are drawn last so they sit on top of the person box that contains them.
  // A stranger gets a thicker, dashed red box so it reads as an alert at a glance,
  // while a recognised face is a calm solid green box carrying the person's name.
  (analysis.faces || []).forEach((f, i) => {
    if (!f.bbox) return;
    boxes.push({
      ...f.bbox,
      label: f.isStranger ? 'NGƯỜI LẠ' : (f.name || 'Khuôn mặt'),
      color: f.isStranger ? COLORS.stranger : COLORS.knownFace,
      strokeWidth: f.isStranger ? 4 : 2,
      dashed: f.isStranger,
      key: `f${i}`,
    });
  });

  return (
    <svg
      className="analysis-overlay"
      width={imgWidth}
      height={imgHeight}
      style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
    >
      {boxes.map((b) => (
        <g key={b.key}>
          <rect
            x={b.x * scaleX}
            y={b.y * scaleY}
            width={b.width * scaleX}
            height={b.height * scaleY}
            fill="none"
            stroke={b.color}
            strokeWidth={b.strokeWidth || 2}
            strokeDasharray={b.dashed ? '7 4' : undefined}
          />
          <rect
            x={b.x * scaleX}
            y={b.y * scaleY - 20}
            width={b.label.length * 8 + 8}
            height={20}
            fill={b.color}
            rx={3}
          />
          <text
            x={b.x * scaleX + 4}
            y={b.y * scaleY - 5}
            fill="#fff"
            fontSize={12}
            fontWeight="bold"
          >
            {b.label}
          </text>
        </g>
      ))}
    </svg>
  );
}
