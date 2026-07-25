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

Three terminals:

```bash
cd backend   && npm run dev                  # API        :5000
cd frontend  && npm run dev                  # UI         :5173
cd backend   && python scripts/analyze_server.py   # AI     :5100
```

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
| `WATCH_RECORD_ON_DETECTION` | `false` | Record a clip while a person is present |

## Notes

- Faces need roughly 60px to be identified — distant figures are reported as a
  plain person detection rather than guessed at. Measured on a 27-person test
  photo, the defaults re-identified 98% of known faces with no false matches.
- `backend/.env`, `backend/uploads/` (captured images and enrolled faces) and
  model weights are gitignored. Keep it that way.
- Face recognition on people who haven't consented may not be lawful where you
  are. Use it on your own property, and check local rules first.
