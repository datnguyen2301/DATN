# VisionGuard

AI-powered camera surveillance system. Watches your cameras, recognises people
and vehicles, reads Vietnamese licence plates, and alerts you when someone it
doesn't recognise shows up.

## Features

- **Live view** — HLS streaming from RTSP, EZVIZ (LAN or cloud) and Android IP Webcam
- **Auto-watch** — background AI detection of people and vehicles, saved as events
- **Face recognition** — enroll known people; unknown faces raise a stranger alert
- **Licence plates** — Vietnamese plate reading, 1-row and 2-row, with a blacklist
- **24/7 recording** — continuous capture with a seekable playback timeline
- **Live overlay** — real-time person boxes drawn in the browser (no server cost)

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19, Vite, React Router, TensorFlow.js |
| Backend | Node.js, Express 5, MongoDB (Mongoose), JWT |
| AI | YOLOv8 (people/vehicles), YOLOv5 (plates), YuNet + SFace (faces) |
| Video | FFmpeg (RTSP → HLS), pyezviz |

## Requirements

- Node.js ≥ 18, Python ≥ 3.9, MongoDB, FFmpeg in `PATH`

## Setup

```bash
git clone https://github.com/datnguyen2301/DATN.git && cd DATN

# Dependencies
cd backend  && npm install
cd ../frontend && npm install
cd ../backend && pip install ultralytics pillow requests pyezviz pandas tqdm seaborn psutil gitpython
```

### Models

Weights are not in git (large, and licences vary). Download into `backend/models/`:

```bash
# People / vehicles — auto-downloads on first run, or pre-fetch:
python -c "from ultralytics import YOLO; YOLO('yolov8s.pt')"

# Faces (Apache-2.0, OpenCV Zoo)
curl -L -o models/face_detection_yunet_2023mar.onnx \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
curl -L -o models/face_recognition_sface_2021dec.onnx \
  https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx
```

For licence plates, download `LP_detector_nano_61.pt` and `LP_ocr_nano_62.pt` from
[trungdinh22/License-Plate-Recognition](https://github.com/trungdinh22/License-Plate-Recognition)
into `backend/models/`. That project publishes no licence, so its weights are not
redistributed here — review its terms before use.

### Camera setup — turn OFF video encryption

**EZVIZ cameras ship with Image Encryption enabled, and VisionGuard cannot read
an encrypted stream. Turn it off before adding the camera.**

> EZVIZ app → your camera → **Settings** → **Image Encryption** → off
> (you will be asked for the device verify code, printed on the camera's label)

Leave it on and you get a camera that looks online everywhere — the cloud reports
it, the app shows it — while VisionGuard shows a black player, auto-watch captures
no frames, and nothing is ever recorded. There is no error message that points at
encryption, so this is worth checking first whenever a camera "connects but shows
nothing".

Verify from the command line — `encrypted` must be `false`:

```bash
cd backend
python scripts/ezviz_bridge.py rtsp_info '{"serial":"YOUR_SERIAL"}'
# {"ok": true, "data": {"serial": "...", "localIp": "192.168.1.50",
#                       "rtspPort": "554", "encrypted": false, ...}}
```

Reboot the camera after changing the setting — some firmware only applies it at
boot.

**If port 554 is still refused with encryption off**, that model simply does not
serve RTSP; EZVIZ removed it from several newer consumer cameras (CS-H1c among
them). Nothing is broken — leave `rtspHost` empty on that camera and VisionGuard
streams it over the EZVIZ cloud instead. Local RTSP is only a lower-latency
shortcut, never a requirement.

### Configuration

Create `backend/.env` (never commit it):

```env
PORT=5000
MONGO_URI=mongodb://localhost:27017/camera_surveillance
ANALYZER_PORT=5100
JWT_SECRET=change-me

# EZVIZ cameras (optional)
EZVIZ_EMAIL=your@email.com
EZVIZ_PASSWORD=yourpassword
EZVIZ_REGION=apiisgp
```

## Running

Four terminals, all started from the directory shown:

```bash
cd backend   && npm run dev                       # API        :5000
cd frontend  && npm run dev                       # UI         :5173
cd backend   && python scripts/analyze_server.py  # detection  :5100
cd backend   && python scripts/ezviz_server.py    # EZVIZ      :5101
```

`ezviz_server.py` is optional but keeps one logged-in EZVIZ session alive. Without
it every cloud call spawns `ezviz_bridge.py` from scratch, which takes 15–30s and
routinely exceeds the 12s timeout in `services/ezviz.js`.

> **`analyze_server.py` does not read `.env`.** Unlike `ezviz_server.py` it has no
> `load_dotenv` call, so face tuning variables are ignored when you launch it from
> a plain shell and silently fall back to defaults — which can switch stranger
> alerting off without any error. Export them first, or start it through a wrapper
> that loads the file:
>
> ```powershell
> cd backend
> $env:FACE_MIN_PX=45; $env:FACE_SCORE_THRESHOLD=0.70
> python scripts/analyze_server.py
> ```

Open http://localhost:5173 and register an account.

## Usage

**Add a camera** — *Cameras* → *Add camera*. Enter an IP Webcam address
(`192.168.1.x:8080`), an EZVIZ serial, or an RTSP host. EZVIZ cameras also need
their verify code for LAN streaming.

**Watch live** — press *Live Stream* on a camera. Toggle the **AI** button to draw
person boxes in real time.

**Enable auto-watch** — press *Watch*. The system analyses a frame every few
seconds and saves an event whenever it sees a person or vehicle.

**Enroll known people** — *Khuôn mặt* → enter a name and either upload a photo or
pick an existing camera image. Use a clear, front-facing photo of one person; add
2–3 photos per person for better accuracy. Until someone is enrolled, no stranger
alerts fire (everyone would be "unknown").

**Get alerts** — a recognised face shows a quiet green notice; an unrecognised one
raises a red warning and tags the event `stranger`.

**Review** — *Sự kiện* lists detections with bounding boxes, *Biển số xe* shows
plate reads and the blacklist, *Xem lại* scrubs through 24/7 recordings.

## Tuning

All optional, set in `backend/.env`:

| Variable | Default | Effect |
|---|---|---|
| `YOLO_MODEL` | `yolov8s.pt` | `yolov8n.pt` uses less CPU, detects less |
| `YOLO_IMGSZ` | `640` | Lower (512) = less CPU, weaker recall |
| `ANALYZER_WORKERS` | `2` | Parallel detection processes |
| `FACE_MATCH_THRESHOLD` | `0.45` | Higher = fewer strangers slip through |
| `FACE_MIN_PX` | `60` | Faces smaller than this aren't identified |
| `FACE_SCORE_THRESHOLD` | `0.8` | YuNet confidence needed to accept a face |
| `STRANGER_ALERT_COOLDOWN_MS` | `60000` | Minimum gap between stranger warnings |
| `WATCH_RECORD_ON_DETECTION` | `false` | Record a clip while a person is present |

The two face gates are worth tuning together against your own camera distance. At
1280×720 with people 3–4m away, faces measure roughly 45–60px wide and score
0.79–0.86 — just under both defaults, so every face is discarded and no stranger
alert ever fires. Lowering them admits those faces, but small crops make weak
embeddings, so raise `FACE_MATCH_THRESHOLD` alongside or strangers start matching
enrolled people:

```env
FACE_MIN_PX=45
FACE_SCORE_THRESHOLD=0.70
FACE_MATCH_THRESHOLD=0.60
```

## Notes

- Identity is decided per person, not per face. Someone is "known" only when a
  recognised face sits inside their detection box, so a person facing away counts
  as a stranger rather than being skipped — the back-turned case is exactly the
  one worth flagging. The cost is that a known person who turns around is briefly
  flagged too, which `STRANGER_ALERT_COOLDOWN_MS` keeps tolerable.
- Faces need roughly 60px to be identified — distant figures are reported as a
  plain person detection rather than guessed at. Measured on a 27-person test
  photo, the defaults re-identified 98% of known faces with no false matches.
- `backend/.env`, `backend/uploads/` (captured images and enrolled faces) and
  model weights are gitignored. Keep it that way.
- Face recognition on people who haven't consented may not be lawful where you
  are. Use it on your own property, and check local rules first.
