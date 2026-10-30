// src/lib/photos.js
// A photo from the in-app camera (expo-camera CameraView) goes to the
// upload endpoint with its GPS position, or into Pending Sync without signal.
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { uploadJobPhoto } from "./api";
import { getLocation } from "./location";
import { isRetryable, queuePhoto } from "./offlineQueue";

async function uriToDataUrl(uri) {
  const response = await fetch(uri);
  if (!response.ok) throw new Error("Could not read the captured photo");
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Could not convert the captured photo"));
    };
    reader.onerror = () => reject(new Error("Could not convert the captured photo"));
    reader.readAsDataURL(blob);
  });
}

// The server keeps photos at most 1600 px on the long edge
// (backend/src/domain/photos.js PHOTO_MAX_EDGE), so the phone sends no more
// than that: about 300 KB instead of 2-4 MB of base64 over mobile data.
const UPLOAD_MAX_EDGE = 1600;
const UPLOAD_JPEG_QUALITY = 0.7;

// { dataUrl, width, height } of the photo shrunk for upload, or null if it
// could not be resized (the caller then sends the original).
async function shrinkPhoto(photo) {
  if (!photo?.uri) return null;
  try {
    const { width, height } = photo;
    const context = ImageManipulator.manipulate(photo.uri);
    if (width > UPLOAD_MAX_EDGE || height > UPLOAD_MAX_EDGE) {
      context.resize(width >= height ? { width: UPLOAD_MAX_EDGE } : { height: UPLOAD_MAX_EDGE });
    }
    const image = await context.renderAsync();
    const saved = await image.saveAsync({ base64: true, compress: UPLOAD_JPEG_QUALITY, format: SaveFormat.JPEG });
    if (!saved.base64) return null;
    return { dataUrl: "data:image/jpeg;base64," + saved.base64, width: saved.width, height: saved.height };
  } catch {
    return null;
  }
}

// stage: "work_started" | "work_finished": the server stamps it on the photo
// (with the GPS position and time) as a light watermark. The answer carries
// `location`, so the app can show where the photo was taken.
async function uploadCapturedPhoto(jobId, photo, note, technician = {}, stage = null) {
  // GPS and the resize run together.
  const [loc, small] = await Promise.all([getLocation({ allowCached: false }), shrinkPhoto(photo)]);
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
    throw new Error("Location not available. Photo was not uploaded. Enable GPS and try again.");
  }
  const dataUrl = small?.dataUrl
    ?? (photo?.base64
      ? "data:image/jpeg;base64," + photo.base64
      : photo?.uri
        ? await uriToDataUrl(photo.uri)
        : null);
  if (!dataUrl) throw new Error("Camera did not return image data");
  const extra = {
    technicianId: technician.id ?? null,
    metadata: {
      technicianName: technician.name ?? null,
      cameraMode: "CameraView",
      stage,
      width: small?.width ?? photo.width ?? null,
      height: small?.height ?? photo.height ?? null,
    },
  };
  try {
    return { ...(await uploadJobPhoto(jobId, dataUrl, loc, note, { ...extra, capturedAt: new Date().toISOString() })), location: loc };
  } catch (err) {
    // No signal at the site: keep the photo for pending sync instead of
    // losing it. A photo the server refused is a real error.
    if (!isRetryable(err)) throw err;
    await queuePhoto(jobId, dataUrl, loc, note, extra);
    return { queued: true, location: loc };
  }
}

export { uploadCapturedPhoto };
