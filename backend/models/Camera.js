const mongoose = require('mongoose');

// Addresses and codes are compared and parsed verbatim (`rtspHost.split(':')`,
// the serial-vs-IP regexes), so a stray copy-paste space breaks matching in ways
// that are hard to spot in a form. Trim at the edge instead.
const cameraSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  location: { type: String, default: '', trim: true },
  type: { type: String, enum: ['ip', 'webhook', 'manual'], default: 'manual' },
  ipAddress: { type: String, default: '', trim: true },
  status: { type: String, enum: ['online', 'offline'], default: 'offline' },
  autoWatch: { type: Boolean, default: false },
  verifyCode: { type: String, default: '', trim: true },
  rtspHost: { type: String, default: '', trim: true },
  watchEventCount: { type: Number, default: 0 },
  watchLastEventAt: { type: Date, default: null },
  autoRecord: { type: Boolean, default: false },
  recordingBufferSeconds: { type: Number, default: 30 },
  recordingCooldown: { type: Number, default: 10 },
  recordingMaxDuration: { type: Number, default: 300 },
  watchMinConfidence: { type: Number, default: 0.4 },
  watchMinPersonSize: { type: Number, default: 0 },
  watchDetectTargets: {
    type: [String],
    default: ['person', 'vehicle'],
    // The watcher reads `camera.watchDetectTargets || DEFAULT`, and an empty
    // array is truthy in JS — so storing [] does not fall back to the default,
    // it silently disables detection entirely. Reject it at the door.
    validate: {
      validator: (v) => Array.isArray(v) && v.length > 0,
      message: 'watchDetectTargets phải có ít nhất một mục tiêu',
    },
  },
}, {
  timestamps: true,
});

module.exports = mongoose.model('Camera', cameraSchema);
