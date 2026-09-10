import { ext } from "../shared/browser";
import type { CaptureViewport, ElementAnchor, FreehandAnchor, ScreenshotRef } from "../shared/model";
import { deleteScreenshotBlob, getScreenshotBlob, putScreenshotBlob } from "../shared/media-store";

const MAX_EDGE = 1_200;
function cropRect(anchor: ElementAnchor | FreehandAnchor, viewport: CaptureViewport): { x: number; y: number; width: number; height: number } | null {
  const source = anchor.kind === "element" ? anchor.rect : anchor.bounds;
  const padding = 16;
  const x = Math.max(0, source.x - viewport.scrollX - padding); const y = Math.max(0, source.y - viewport.scrollY - padding);
  const right = Math.min(viewport.width, source.x - viewport.scrollX + source.width + padding);
  const bottom = Math.min(viewport.height, source.y - viewport.scrollY + source.height + padding);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
}

export async function captureScreenshot(windowId: number, anchor: ElementAnchor | FreehandAnchor, viewport: CaptureViewport, id: string): Promise<ScreenshotRef | undefined> {
  if (![viewport.scrollX, viewport.scrollY, viewport.width, viewport.height].every(Number.isFinite) || viewport.width < 1 || viewport.height < 1) return undefined;
  const crop = cropRect(anchor, viewport); if (!crop) return undefined;
  const dataUrl = await ext.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 78 });
  const sourceBlob = await (await fetch(dataUrl)).blob(); const bitmap = await createImageBitmap(sourceBlob);
  try {
    const scaleX = bitmap.width / viewport.width; const scaleY = bitmap.height / viewport.height;
    const sx = Math.max(0, Math.round(crop.x * scaleX)); const sy = Math.max(0, Math.round(crop.y * scaleY));
    const sw = Math.min(bitmap.width - sx, Math.max(1, Math.round(crop.width * scaleX))); const sh = Math.min(bitmap.height - sy, Math.max(1, Math.round(crop.height * scaleY)));
    const outputScale = Math.min(1, MAX_EDGE / Math.max(sw, sh)); const width = Math.max(1, Math.round(sw * outputScale)); const height = Math.max(1, Math.round(sh * outputScale));
    const canvas = new OffscreenCanvas(width, height); const context = canvas.getContext("2d"); if (!context) return undefined;
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, width, height);
    const toCanvas = (x: number, y: number) => ({ x: (x - viewport.scrollX - crop.x) * scaleX * outputScale, y: (y - viewport.scrollY - crop.y) * scaleY * outputScale });
    context.strokeStyle = anchor.kind === "freehand" ? "#f97316" : "#7c3aed"; context.lineWidth = 3; context.lineJoin = "round";
    if (anchor.kind === "element") {
      const start = toCanvas(anchor.rect.x, anchor.rect.y);
      context.strokeRect(start.x, start.y, anchor.rect.width * scaleX * outputScale, anchor.rect.height * scaleY * outputScale);
    } else {
      context.beginPath();
      anchor.points.forEach((point, index) => { const current = toCanvas(point.x, point.y); if (index) context.lineTo(current.x, current.y); else context.moveTo(current.x, current.y); });
      context.closePath(); context.stroke();
    }
    const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.78 });
    await putScreenshotBlob(id, blob);
    return { id, mimeType: "image/jpeg", width, height, createdAt: Date.now() };
  } finally { bitmap.close(); }
}

export async function deleteScreenshot(id: string): Promise<void> { await deleteScreenshotBlob(id); }
export async function screenshotBlob(id: string): Promise<Blob | null> { return (await getScreenshotBlob(id)) ?? null; }
