import sys
import os
import torch
from PIL import Image, ImageOps, ImageFilter
from transformers import TrOCRProcessor, VisionEncoderDecoderModel

MODEL_NAME = os.getenv("TROCR_MODEL", "microsoft/trocr-base-handwritten")

print(f"Loading TrOCR model: {MODEL_NAME}", file=sys.stderr)
processor = TrOCRProcessor.from_pretrained(MODEL_NAME)
model = VisionEncoderDecoderModel.from_pretrained(
    MODEL_NAME,
    use_safetensors=True,
    low_cpu_mem_usage=True
)


device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
print(f"Using device: {device}", file=sys.stderr)
model.to(device)
model.eval()

def preprocess_image(image_path):
    image = Image.open(image_path).convert("L")
    image = ImageOps.autocontrast(image)
    image = image.filter(ImageFilter.SHARPEN)

    inv = ImageOps.invert(image)
    bbox = inv.getbbox()
    if bbox:
        image = image.crop(bbox)

    return image.convert("RGB")


def ocr_batch(image_paths, batch_size=10):
    try:
        if not image_paths:
            return []

        results = []
        for i in range(0, len(image_paths), batch_size):
            batch_paths = image_paths[i:i + batch_size]
            images = [preprocess_image(p) for p in batch_paths]
            if not images:
                continue

            pixel_values = processor(images=images, return_tensors="pt", padding=True).pixel_values
            pixel_values = pixel_values.to(device)

            with torch.no_grad():
                generated_ids = model.generate(
                    pixel_values,
                    max_length=256,
                    num_beams=1,
                    early_stopping=True,
                    length_penalty=1.0
                )

            batch_results = processor.batch_decode(generated_ids, skip_special_tokens=True)
            results.extend(batch_results)

        return results
    except Exception as e:
        print(f"ERROR: {str(e)}", file=sys.stderr)
        return [""] * len(image_paths)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python trocr_ocr.py <image_path1> [image_path2] ...")
        sys.exit(1)
    
    image_paths = sys.argv[1:]
    print(f"Processing {len(image_paths)} images...", file=sys.stderr)
    sys.stderr.flush()
    
    batch_size = int(os.getenv("TROCR_BATCH_SIZE", "10"))
    results = ocr_batch(image_paths, batch_size=batch_size)
    
    for text in results:
        print(text)
