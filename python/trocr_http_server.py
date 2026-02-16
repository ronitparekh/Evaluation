import base64
import json
import os
import sys
import threading
from io import BytesIO
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import List

import torch
from PIL import Image, ImageOps, ImageFilter
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

MODEL_NAME = os.getenv("TROCR_MODEL", "microsoft/trocr-large-handwritten")
BATCH_SIZE = int(os.getenv("TROCR_BATCH_SIZE", "16"))
HOST = os.getenv("TROCR_HOST", "127.0.0.1")
PORT = int(os.getenv("TROCR_PORT", "8008"))

print(f"[SERVER] Loading TrOCR model: {MODEL_NAME}", file=sys.stderr)
processor = TrOCRProcessor.from_pretrained(MODEL_NAME)
model = VisionEncoderDecoderModel.from_pretrained(
    MODEL_NAME,
    use_safetensors=True,
    low_cpu_mem_usage=True
)

device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"[SERVER] Using device: {device}", file=sys.stderr)
model.to(device)
model.eval()

try:
    dummy_image = Image.new("RGB", (384, 384), color="white")
    _ = processor(images=[dummy_image], return_tensors="pt").pixel_values
    print("[SERVER] Model loaded and warmed up. Ready for requests.", file=sys.stderr)
except Exception as exc:
    print(f"[SERVER] Warmup failed: {exc}", file=sys.stderr)

sys.stderr.flush()


def preprocess_pil(image: Image.Image) -> Image.Image:
    image = image.convert("L")
    image = ImageOps.autocontrast(image)
    image = image.filter(ImageFilter.SHARPEN)

    inv = ImageOps.invert(image)
    bbox = inv.getbbox()
    if bbox:
        image = image.crop(bbox)

    return image.convert("RGB")


def preprocess_image(image_path: str) -> Image.Image:
    image = Image.open(image_path)
    return preprocess_pil(image)


def preprocess_b64_image(b64_data: str) -> Image.Image:
    raw = base64.b64decode(b64_data)
    image = Image.open(BytesIO(raw))
    return preprocess_pil(image)


def process_batch(image_paths: List[str]) -> List[str]:
    if not image_paths:
        return []

    results: List[str] = []
    for i in range(0, len(image_paths), BATCH_SIZE):
        batch_paths = image_paths[i : i + BATCH_SIZE]
        images = [preprocess_image(p) for p in batch_paths]

        if not images:
            continue

        pixel_values = processor(
            images=images,
            return_tensors="pt",
            padding=True
        ).pixel_values
        pixel_values = pixel_values.to(device)

        with torch.no_grad():
            generated_ids = model.generate(
                pixel_values,
                max_length=256,
                num_beams=1,
                early_stopping=True,
                length_penalty=1.0
            )

        batch_results = processor.batch_decode(
            generated_ids,
            skip_special_tokens=True
        )
        results.extend(batch_results)

    return results


def process_b64_batch(images_b64: List[str]) -> List[str]:
    if not images_b64:
        return []

    results: List[str] = []
    for i in range(0, len(images_b64), BATCH_SIZE):
        batch_data = images_b64[i : i + BATCH_SIZE]
        images = [preprocess_b64_image(b64) for b64 in batch_data]

        if not images:
            continue

        pixel_values = processor(
            images=images,
            return_tensors="pt",
            padding=True
        ).pixel_values
        pixel_values = pixel_values.to(device)

        with torch.no_grad():
            generated_ids = model.generate(
                pixel_values,
                max_length=256,
                num_beams=1,
                early_stopping=True,
                length_penalty=1.0
            )

        batch_results = processor.batch_decode(
            generated_ids,
            skip_special_tokens=True
        )
        results.extend(batch_results)

    return results


class TrOcrHandler(BaseHTTPRequestHandler):
    server_version = "TrOCRHTTP/1.0"

    def _send_json(self, status_code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        if self.path == "/health":
            self._send_json(200, {"status": "ok"})
        else:
            self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:
        if self.path != "/ocr":
            self._send_json(404, {"error": "Not found"})
            return

        try:
            content_length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(content_length)
            data = json.loads(raw.decode("utf-8")) if raw else {}
            image_paths = data.get("paths", [])
            images_b64 = data.get("images", [])

            if image_paths and not isinstance(image_paths, list):
                self._send_json(400, {"error": "'paths' must be a list"})
                return
            if images_b64 and not isinstance(images_b64, list):
                self._send_json(400, {"error": "'images' must be a list"})
                return

            if images_b64:
                results = process_b64_batch(images_b64)
            else:
                results = process_batch(image_paths)
            self._send_json(200, {"results": results})
        except json.JSONDecodeError as exc:
            self._send_json(400, {"error": f"Invalid JSON: {exc}"})
        except Exception as exc:
            self._send_json(500, {"error": str(exc)})

    def log_message(self, format: str, *args) -> None:
        # Reduce noise in stdout; keep errors only.
        return


def main() -> None:
    server = ThreadingHTTPServer((HOST, PORT), TrOcrHandler)
    print(f"[SERVER] Listening on http://{HOST}:{PORT}", file=sys.stderr)
    sys.stderr.flush()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
