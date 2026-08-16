const KnownPerson = require('../models/KnownPerson');

// Cosine similarity above which two faces are considered the same person.
//
// OpenCV documents 0.363 for SFace, but that is a general verification threshold
// and proved far too permissive for stranger alerting. Measured on a 27-person
// group photo, counting pairs of DIFFERENT people scored as the same person:
//
//   threshold   false matches (all faces)   with FACE_MIN_PX=60
//   0.363       53/351  (15.1%)             1/36
//   0.450       12/351  ( 3.4%)             0/36
//
// Paired with FACE_MIN_PX=60 (worst impostor pair: 0.368), 0.45 gives zero false
// accepts while still recognising 98% of known faces across brightness shifts,
// 7° rotation, 30% downscale, heavy JPEG and blur. Residual error is biased the
// safe way — a known person is occasionally flagged as a stranger (noisy but
// harmless) rather than a stranger passing silently as known.
//
// Raise it if strangers slip through; lower it if known people keep triggering
// alerts. Enrolling several photos per person is the better fix for the latter,
// since matching takes the best score across all of a person's photos.
const MATCH_THRESHOLD = parseFloat(process.env.FACE_MATCH_THRESHOLD || '0.45');

// Known-face embeddings are cached so a watch cycle every 1.5-3s doesn't hit
// MongoDB each time. Enrollment routes call invalidateCache() on any change.
let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 60_000;

async function getKnownFaces() {
  const now = Date.now();
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache;
  const people = await KnownPerson.find().select('name embeddings').lean();
  _cache = people.map((p) => ({
    id: String(p._id),
    name: p.name,
    embeddings: (p.embeddings || []).filter((e) => Array.isArray(e) && e.length > 0),
  }));
  _cacheAt = now;
  return _cache;
}

function invalidateCache() {
  _cache = null;
  _cacheAt = 0;
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Best match for one embedding, or null when below threshold. */
function matchEmbedding(embedding, known) {
  let best = null;
  for (const person of known) {
    for (const ref of person.embeddings) {
      const sim = cosine(embedding, ref);
      if (!best || sim > best.similarity) {
        best = { personId: person.id, name: person.name, similarity: sim };
      }
    }
  }
  if (best && best.similarity >= MATCH_THRESHOLD) return best;
  return null;
}

/**
 * Annotate analyzer faces ({bbox, score, embedding}) with identity.
 * Returns faces WITHOUT embeddings (they are large and don't belong in events):
 * [{bbox, score, name, similarity, isStranger}], plus summary flags.
 * When no one is enrolled yet, faces are left unlabeled (isStranger=false) —
 * alerting on "stranger" before any enrollment would flag literally everyone.
 */
async function annotateFaces(faces) {
  const known = await getKnownFaces();
  const enrolled = known.some((p) => p.embeddings.length > 0);
  const out = [];
  let hasStranger = false;
  const knownNames = new Set();

  for (const f of faces || []) {
    const base = { bbox: f.bbox, score: f.score, name: '', similarity: 0, isStranger: false };
    if (enrolled && Array.isArray(f.embedding) && f.embedding.length > 0) {
      const m = matchEmbedding(f.embedding, known);
      if (m) {
        base.name = m.name;
        base.similarity = Math.round(m.similarity * 1000) / 1000;
        knownNames.add(m.name);
      } else {
        base.isStranger = true;
        hasStranger = true;
      }
    }
    out.push(base);
  }

  return { faces: out, hasStranger, knownNames: [...knownNames], enrolled };
}

/** True when a face box sits inside a person box (compared on face centre). */
function faceInsidePerson(faceBox, personBox) {
  if (!faceBox || !personBox) return false;
  const cx = faceBox.x + faceBox.width / 2;
  const cy = faceBox.y + faceBox.height / 2;
  return (
    cx >= personBox.x &&
    cx <= personBox.x + personBox.width &&
    cy >= personBox.y &&
    cy <= personBox.y + personBox.height
  );
}

/**
 * Annotate a whole analyzer result in place: identity on the faces, and the
 * per-person stranger verdict derived from them.
 *
 * A person is flagged only when an UNRECOGNISED face was actually found inside
 * their box. Someone facing away has no face to judge, so they stay an ordinary
 * person detection rather than being called a stranger on no evidence. A
 * recognised face wins over an unrecognised one in the same box: with two faces
 * overlapping, the confident match is the better answer.
 *
 * Shared by the watcher's live path and the "re-analyze" route so the two can
 * never disagree about who counts as a stranger.
 */
async function annotateAnalysis(analysis) {
  const rawFaces = analysis?.faces || [];
  const persons = analysis?.persons || [];
  const { faces, knownNames, enrolled } = await annotateFaces(rawFaces);
  // Write the annotated faces back, or the caller keeps the RAW ones: they still
  // carry embeddings and none of the identity fields, so persisting them yields
  // faces with no name and isStranger=false — drawn as calm green "Khuôn mặt"
  // boxes even inside a person the same pass had just flagged as a stranger.
  if (analysis) analysis.faces = faces;

  if (!enrolled) {
    // Nobody enrolled yet — everyone would be a "stranger", so judge no one.
    for (const p of persons) p.isStranger = false;
    return { faces, persons, knownNames, enrolled, hasStranger: false, strangerPersons: 0 };
  }

  const knownFaces = faces.filter((f) => !f.isStranger && f.name);
  const unknownFaces = faces.filter((f) => f.isStranger);
  for (const p of persons) {
    const hasKnown = knownFaces.some((f) => faceInsidePerson(f.bbox, p.bbox));
    const hasUnknown = unknownFaces.some((f) => faceInsidePerson(f.bbox, p.bbox));
    p.isStranger = hasUnknown && !hasKnown;
  }

  return {
    faces,
    persons,
    knownNames,
    enrolled,
    hasStranger: faces.some((f) => f.isStranger),
    strangerPersons: persons.filter((p) => p.isStranger).length,
  };
}

module.exports = {
  annotateFaces,
  annotateAnalysis,
  faceInsidePerson,
  matchEmbedding,
  getKnownFaces,
  invalidateCache,
  cosine,
  MATCH_THRESHOLD,
};
