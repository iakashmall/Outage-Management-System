// src/lib/location.js
// Native location via expo-location. Used to tag status updates and
// photo uploads with GPS coordinates.
import * as Location from "expo-location";
import AsyncStorage from "@react-native-async-storage/async-storage";

const LAST_LOCATION_KEY = "oms-last-known-location";

// A fix the phone already has is used when it is this recent and this
// accurate. Background tracking (lib/backgroundLocation.js) gets a
// high-accuracy fix every 5 s, so there almost always is one, and the crew
// does not wait several seconds for a new satellite fix on every button.
const RECENT_FIX_MAX_AGE_MS = 10000;
const RECENT_FIX_ACCURACY_M = 50;
// Never wait longer than this for a new fix (indoors, no sky view).
const FRESH_FIX_TIMEOUT_MS = 20000;

async function permitted() {
  const current = await Location.getForegroundPermissionsAsync();
  if (current.status === "granted") return true;
  return (await Location.requestForegroundPermissionsAsync()).status === "granted";
}

async function recentFix() {
  try {
    return await Location.getLastKnownPositionAsync({
      maxAge: RECENT_FIX_MAX_AGE_MS,
      requiredAccuracy: RECENT_FIX_ACCURACY_M,
    });
  } catch {
    return null;
  }
}

function freshFix() {
  return Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("GPS fix timed out")), FRESH_FIX_TIMEOUT_MS)),
  ]);
}

// allowCached: on failure, fall back to the last position this app stored
// (any age). A recent (≤10 s, ≤50 m) fix from the OS is used either way,
// unless fresh: the site check for On Site / Work Started always takes a new
// fix, so a crew driving past cannot pass it with a position from 10 s ago.
export async function getLocation({ allowCached = true, fresh = false } = {}) {
  try {
    if (!(await permitted())) return {};
    const pos = (fresh ? null : await recentFix()) ?? (await freshFix());
    const location = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    AsyncStorage.setItem(LAST_LOCATION_KEY, JSON.stringify(location)).catch(() => {});
    return location;
  } catch {
    return allowCached ? getLastKnownLocation() : {};
  }
}

export async function getLastKnownLocation() {
  try {
    const stored = await AsyncStorage.getItem(LAST_LOCATION_KEY);
    const location = stored ? JSON.parse(stored) : null;
    return Number.isFinite(location?.lat) && Number.isFinite(location?.lon) ? location : {};
  } catch {
    return {};
  }
}
