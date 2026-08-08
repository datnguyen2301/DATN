const jwt = require('jsonwebtoken');

function auth(req, res, next) {
  if (req.method === 'GET' && req.path === '/events') {
    return next();
  }
  const pathOnly = (req.originalUrl || req.url || '').split('?')[0];
  // Image and stream endpoints that are consumed by <img>/<video> tags, which
  // cannot attach an Authorization header. Without this exemption those tags get
  // a 401 and the tile renders its error state forever — which is exactly what
  // EzvizLiveFrame did on the Dashboard and Cameras pages.
  if (
    req.method === 'GET' &&
    (/^\/api\/ipcam\/(stream|snapshot)\//.test(pathOnly) || /^\/api\/ezviz\/frame\//.test(pathOnly))
  ) {
    return next();
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'visionguard-secret-key');
    req.user = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = auth;
