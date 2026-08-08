const express = require('express');
const Camera = require('../models/Camera');
const watcher = require('../services/watcher');
const recorder = require('../services/continuousRecorder');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const cameras = await Camera.find().sort({ createdAt: -1 });
    res.json(cameras);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  try {
    const camera = await Camera.create(req.body);
    res.status(201).json(camera);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Whitelisted so a client echoing back a whole camera object cannot flip fields
// it never meant to touch. Saving an edit form with a stale `autoWatch: false`
// used to stop a running watcher as a side effect, with nothing in the request
// suggesting that was intended.
const UPDATABLE_FIELDS = [
  'name', 'location', 'type', 'ipAddress', 'status', 'verifyCode', 'rtspHost',
  'autoWatch', 'autoRecord', 'recordingBufferSeconds', 'recordingCooldown',
  'recordingMaxDuration', 'watchMinConfidence', 'watchMinPersonSize',
  'watchDetectTargets',
];

router.put('/:id', async (req, res) => {
  try {
    const update = {};
    for (const key of UPDATABLE_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(req.body, key)) update[key] = req.body[key];
    }

    const camera = await Camera.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    });
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    // Only react when the request actually carried the flag. Acting on the
    // stored value would let an unrelated edit stop a running watcher.
    if (Object.prototype.hasOwnProperty.call(update, 'autoWatch') && camera.autoWatch === false) {
      await watcher.stopWatch(req.params.id);
    }
    // Keep the persisted autoRecord flag and the running recorder in step, the
    // same way autoWatch drives the watcher above.
    if (camera.autoRecord && !recorder.isRecording(req.params.id)) {
      recorder.start(req.params.id).catch((e) =>
        console.warn(`[recorder] start on update failed: ${e.message}`));
    } else if (!camera.autoRecord && recorder.isRecording(req.params.id)) {
      recorder.stop(req.params.id);
    }
    res.json(camera);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await watcher.stopWatch(req.params.id);
    recorder.stop(req.params.id);
    const camera = await Camera.findByIdAndDelete(req.params.id);
    if (!camera) return res.status(404).json({ error: 'Camera not found' });
    res.json({ message: 'Camera deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
