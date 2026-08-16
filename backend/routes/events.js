const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const sharp = require('sharp');
const Event = require('../models/Event');
const Camera = require('../models/Camera');
const { analyzeImage, analyzeEventMedia } = require('../services/analyzer');

const router = express.Router();

// User input goes straight into a RegExp, so metacharacters must be neutered —
// otherwise a plate like "51F-*" throws, and "(.*)+" is a ReDoS waiting to fire.
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const storage = multer.diskStorage({
  destination: path.join(__dirname, '..', 'uploads'),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${uuidv4()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) return cb(null, true);
    cb(new Error('Only image files are allowed'));
  },
});

async function createThumbnail(srcPath) {
  const ext = path.extname(srcPath);
  const thumbName = `thumb_${path.basename(srcPath, ext)}${ext}`;
  const thumbPath = path.join(path.dirname(srcPath), thumbName);
  await sharp(srcPath).resize(320, 240, { fit: 'inside' }).toFile(thumbPath);
  return thumbName;
}

router.post('/capture', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const thumbName = await createThumbnail(req.file.path);
    const result = await analyzeImage(req.file.path);

    const event = await Event.create({
      cameraId: req.body.cameraId,
      capturedAt: req.body.capturedAt || new Date(),
      imagePath: req.file.filename,
      thumbnailPath: thumbName,
      analysis: result.analysis,
      tags: result.tags,
    });

    res.status(201).json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/upload', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });

    const thumbName = await createThumbnail(req.file.path);
    const result = await analyzeImage(req.file.path);

    const event = await Event.create({
      cameraId: req.body.cameraId,
      capturedAt: req.body.capturedAt || new Date(),
      imagePath: req.file.filename,
      thumbnailPath: thumbName,
      analysis: result.analysis,
      tags: result.tags,
      notes: req.body.notes || '',
    });

    res.status(201).json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    // `sort=asc` exists so a caller can ask for the events immediately AFTER a
    // moment. With descending-only order, "the next event after T" would mean
    // fetching everything newer than T and taking the last row.
    const { cameraId, dateFrom, dateTo, tag, search, plate, minPersons, hasVehicle, type, sort, page = 1, limit = 20 } = req.query;
    const sortDir = sort === 'asc' ? 1 : -1;
    const filter = {};

    if (cameraId) filter.cameraId = cameraId;
    if (dateFrom || dateTo) {
      filter.capturedAt = {};
      if (dateFrom) filter.capturedAt.$gte = new Date(dateFrom);
      if (dateTo) filter.capturedAt.$lte = new Date(dateTo);
    }
    if (tag) filter.tags = tag;
    if (plate) {
      filter['analysis.licensePlates.plateNumber'] = { $regex: escapeRegex(plate), $options: 'i' };
    }

    // Each entry is an independent OR-group; they are ANDed together at the end.
    // Collecting them here instead of assigning filter.$or directly matters
    // because both `search` and `type=clip` need an $or and the second would
    // silently overwrite the first.
    const andGroups = [];

    // Free-text box. The old implementation used the {tags, notes} text index
    // AND-ed with a plate regex on the same string, so a row had to match both —
    // which essentially nothing ever did. Search now spans every field a user
    // would plausibly type: plate, recognised face name, tag, note, camera name.
    if (search && String(search).trim()) {
      const rx = new RegExp(escapeRegex(String(search).trim()), 'i');
      const or = [
        { 'analysis.licensePlates.plateNumber': rx },
        { 'analysis.faces.name': rx },
        { tags: rx },
        { notes: rx },
      ];
      const camIds = await Camera.distinct('_id', { name: rx });
      if (camIds.length) or.push({ cameraId: { $in: camIds } });
      andGroups.push({ $or: or });
    }
    if (minPersons) {
      filter[`analysis.persons.${parseInt(minPersons) - 1}`] = { $exists: true };
    }
    if (hasVehicle === 'true') {
      filter['analysis.vehicles.0'] = { $exists: true };
    }
    if (type === 'image') {
      filter.videoPath = { $exists: false };
      filter.type = { $ne: 'clip' };
    } else if (type === 'clip') {
      andGroups.push({
        $or: [
          { type: 'clip' },
          { videoPath: { $regex: /\.(mp4|gif|webm|avi|mov)$/i } },
        ],
      });
    }
    // type=all: lấy tất cả (image + video), không lọc theo type

    if (andGroups.length) filter.$and = andGroups;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [events, total] = await Promise.all([
      Event.find(filter)
        .populate('cameraId', 'name location')
        // _id breaks ties so the order is total: events sharing a second would
        // otherwise come back in an arbitrary order that differs between the
        // ascending and descending queries, and paging could repeat or skip rows.
        .sort({ capturedAt: sortDir, _id: sortDir })
        .skip(skip)
        .limit(parseInt(limit)),
      Event.countDocuments(filter),
    ]);

    res.json({
      events,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / parseInt(limit)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', async (req, res) => {
  try {
    const [totalEvents, todayEvents, personEvents, vehicleEvents] = await Promise.all([
      Event.countDocuments(),
      Event.countDocuments({
        capturedAt: { $gte: new Date(new Date().setHours(0, 0, 0, 0)) },
      }),
      Event.countDocuments({ tags: 'person' }),
      Event.countDocuments({ tags: 'vehicle' }),
    ]);
    res.json({ totalEvents, todayEvents, personEvents, vehicleEvents });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).populate('cameraId', 'name location');
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/:id/analyze', async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const result = await analyzeEventMedia(event);

    // Re-run identity too, using the same rules as the live watcher. Skipping it
    // left the event claiming "stranger" with no face to back the claim, because
    // the tag survived while the analysis under it was replaced.
    const { annotateAnalysis } = require('../services/faceMatch');
    const { hasStranger, knownNames } = await annotateAnalysis(result.analysis);

    event.analysis = result.analysis;
    // `stranger` and `known-person` are derived, so they are recomputed rather
    // than preserved — a stale one outlives the evidence that produced it.
    const tagKeys = ['person', 'vehicle', 'plate', 'stranger', 'known-person'];
    event.tags = [...new Set([
      ...event.tags.filter((t) => !tagKeys.includes(t)),
      ...result.tags,
      ...(hasStranger ? ['stranger'] : []),
      ...(knownNames.length > 0 ? ['known-person'] : []),
    ])];
    await event.save();
    await event.populate('cameraId', 'name location');

    res.json(event);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) return res.status(404).json({ error: 'Event not found' });
    res.json({ message: 'Event deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
