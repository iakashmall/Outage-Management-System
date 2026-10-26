// src/lib/photos.js
// A photo from the in-app camera (expo-camera CameraView, base64) goes to the
// upload endpoint with its GPS position, or into Pending Sync without signal.
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

// stage: "work_started" | "work_finished": the server stamps it on the photo
// (with the GPS position and time) as a light watermark. The answer carries
// `location`, so the app can show where the photo was taken.
async function uploadCapturedPhoto(jobId, photo, note, technician = {}, stage = null) {
  const loc = await getLocation({ allowCached: false });
  if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lon)) {
    throw new Error("Location not available. Photo was not uploaded. Enable GPS and try again.");
  }
  const dataUrl = photo?.base64
    ? "data:image/jpeg;base64," + photo.base64
    : photo?.uri
      ? await uriToDataUrl(photo.uri)
      : null;
  if (!dataUrl) throw new Error("Camera did not return image data");
  const extra = {
    technicianId: technician.id ?? null,
    metadata: {
      technicianName: technician.name ?? null,
      cameraMode: "CameraView",
      stage,
      width: photo.width ?? null,
      height: photo.height ?? null,
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
