// src/lib/__tests__/offlineQueue.test.mjs — npm run test:app
// Pending sync (lib/offlineQueue.js) with AsyncStorage, the photo files and
// the API faked in memory.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  queuePhoto, queueUpdate, flushQueue, getQueueItems, pendingPhotoRoom,
  MAX_PENDING_PHOTOS, MAX_PENDING_PHOTO_BYTES, PHOTO_FILE_MISSING, PHOTO_QUEUE_FULL,
} from "../offlineQueue.js";

const storage = (globalThis.__asyncStorage ??= new Map());
const files = (globalThis.__files ??= new Map());
const apiCalls = () => globalThis.__apiCalls;

const PHOTO = "data:image/jpeg;base64,AAAA";

beforeEach(() => {
  storage.clear();
  files.clear();
  globalThis.__apiCalls = [];
});

// n photos already waiting, each file `size` bytes.
function seedPhotos(n, size = 1000) {
  const items = Array.from({ length: n }, (_, i) => {
    const uri = `file:///doc/pending-photos/seed-${i}.txt`;
    files.set(uri, { text: PHOTO, size });
    return { type: "photo", id: "JOB-1", file: uri, location: {}, note: null, extra: {}, queuedAt: 1000 + i };
  });
  storage.set("oms-status-queue", JSON.stringify(items));
}

test("a queued photo whose file is gone is reported in `dropped`, not as sent", async () => {
  await queuePhoto("JOB-1", PHOTO, { lat: 1, lon: 2 }, null, {});
  await queueUpdate({ id: "JOB-1", status: "On Site", location: {}, crewId: "C001" });
  const [photo] = await getQueueItems();
  files.delete(photo.file); // e.g. app data cleared

  const result = await flushQueue();

  assert.equal(result.dropped.length, 1);
  assert.equal(result.dropped[0].type, "photo");
  assert.equal(result.dropped[0].code, PHOTO_FILE_MISSING);
  assert.match(result.dropped[0].message, /no longer on the phone/);
  assert.equal(result.flushed, 1, "the status change behind it is still sent");
  assert.equal(result.remaining, 0);
  assert.deepEqual(apiCalls().map((c) => c.kind), ["status"], "no photo upload attempted");
});

test("a photo whose file is there is uploaded and its file removed", async () => {
  await queuePhoto("JOB-1", PHOTO, {}, null, {});
  const [photo] = await getQueueItems();

  const result = await flushQueue();

  assert.equal(result.flushed, 1);
  assert.equal(result.dropped.length, 0);
  assert.equal(apiCalls()[0].kind, "photo");
  assert.equal(files.has(photo.file), false);
});

test("photo cap: warns from 80%, takes the last one, refuses the next before writing it", async () => {
  seedPhotos(MAX_PENDING_PHOTOS * 0.8 - 1);
  let room = await pendingPhotoRoom();
  assert.equal(room.nearlyFull, false);

  seedPhotos(MAX_PENDING_PHOTOS * 0.8);
  room = await pendingPhotoRoom();
  assert.equal(room.nearlyFull, true);
  assert.equal(room.full, false);

  seedPhotos(MAX_PENDING_PHOTOS - 1);
  await queuePhoto("JOB-2", PHOTO, {}, null, {}); // the 150th still fits
  room = await pendingPhotoRoom();
  assert.equal(room.count, MAX_PENDING_PHOTOS);
  assert.equal(room.full, true);

  const filesBefore = files.size;
  await assert.rejects(queuePhoto("JOB-2", PHOTO, {}, null, {}), (err) => {
    assert.equal(err.code, PHOTO_QUEUE_FULL);
    assert.match(err.message, /full/);
    return true;
  });
  assert.equal(files.size, filesBefore, "no file written");
  assert.equal((await getQueueItems()).length, MAX_PENDING_PHOTOS);
});

test("photo cap by size: large waiting photos block a new one before the count limit", async () => {
  seedPhotos(2, MAX_PENDING_PHOTO_BYTES / 2 - 10); // ~100 MB in two photos
  const room = await pendingPhotoRoom();
  assert.equal(room.count, 2);
  assert.equal(room.nearlyFull, true);
  assert.equal(room.full, false);

  await assert.rejects(queuePhoto("JOB-1", "x".repeat(100), {}, null, {}), { code: PHOTO_QUEUE_FULL });
});
