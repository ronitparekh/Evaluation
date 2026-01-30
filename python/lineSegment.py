import cv2
import sys
import os

image_path = sys.argv[1]
output_dir = sys.argv[2]

os.makedirs(output_dir, exist_ok=True)

img = cv2.imread(image_path)
if img is None:
    sys.exit(0)

gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

gray = cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)
img = cv2.resize(img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

gray = cv2.fastNlMeansDenoising(gray, h=15)


thresh = cv2.adaptiveThreshold(
    gray, 255,
    cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
    cv2.THRESH_BINARY_INV,
    31, 9
)

proj = cv2.reduce(thresh, 1, cv2.REDUCE_SUM, dtype=cv2.CV_32S).flatten()

proj = cv2.blur(proj.reshape(-1, 1), (1, 25)).flatten()

line_bounds = []
in_line = False
start = 0
threshold = max(proj) * 0.1

for i, val in enumerate(proj):
    if val > threshold and not in_line:
        in_line = True
        start = i
    elif val <= threshold and in_line:
        end = i
        if end - start > 12:
            line_bounds.append((start, end))
        in_line = False

if in_line:
    end = len(proj) - 1
    if end - start > 12:
        line_bounds.append((start, end))

count = 0
pad = 20

for (y1, y2) in line_bounds:
    y1 = max(0, y1 - pad)
    y2 = min(img.shape[0], y2 + pad)

    
    line_thresh = thresh[y1:y2, :]
    cols = cv2.reduce(line_thresh, 0, cv2.REDUCE_SUM, dtype=cv2.CV_32S).flatten()
    xs = [i for i, v in enumerate(cols) if v > 0]
    if not xs:
        continue
    x1 = max(0, min(xs) - pad)
    x2 = min(img.shape[1], max(xs) + pad)

    line_img = img[y1:y2, x1:x2]


    line_img = cv2.resize(line_img, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

    out_path = os.path.join(output_dir, f"line_{count}.png")
    cv2.imwrite(out_path, line_img)
    print(out_path)
    count += 1
