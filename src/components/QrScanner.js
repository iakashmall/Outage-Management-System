// src/components/QrScanner.js
// expo-camera has a built-in barcode/QR scanner — no extra library needed.
import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { View, Text, Pressable, TextInput, StyleSheet } from "react-native";

export default function QrScanner({ onScan, onClose }) {
  const [perm, requestPerm] = useCameraPermissions();
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [manualValue, setManualValue] = useState("");
  const [detectedValue, setDetectedValue] = useState("");

  if (!perm) return <Text>Loading camera…</Text>;
  if (!perm.granted) {
    return (
      <View style={s.center}>
        <Text style={s.msg}>Camera access is needed to scan asset tags.</Text>
        <Pressable style={s.btn} onPress={requestPerm}>
          <Text style={s.btnText}>Allow camera</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={s.wrap}>
      <CameraView
        style={s.camera}
        facing="back"
        active={!done}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onMountError={(mountError) => setError(mountError?.message || "Could not open the camera")}
        onCameraReady={() => setError("")}
        onBarcodeScanned={
          done
            ? undefined
            : ({ data }) => {
                setDetectedValue(data);
                setDone(true);
                onScan(data);
              }
        }
      />
      {detectedValue ? <Text style={s.detected}>QR detected: {detectedValue}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}
      <View style={s.manual}>
        <Text style={s.manualLabel}>Camera not scanning?</Text>
        <TextInput
          value={manualValue}
          onChangeText={setManualValue}
          placeholder="Enter the QR value manually"
          placeholderTextColor="#8b9aad"
          style={s.input}
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Pressable
          style={[s.btn, !manualValue.trim() && s.btnOff]}
          disabled={!manualValue.trim()}
          onPress={() => {
            setDone(true);
            onScan(manualValue.trim());
          }}
        >
          <Text style={s.btnText}>Use QR value</Text>
        </Pressable>
        <Pressable
          style={s.testBtn}
          onPress={() => {
            const testValue = JSON.stringify({
              assetId: "TEST-TRANSFORMER-001",
              serialNumber: "DEMO-QR-001",
              feeder: "FDR-17",
              assetType: "Transformer",
            });
            setDetectedValue(testValue);
            setDone(true);
            onScan(testValue);
          }}
        >
          <Text style={s.testBtnText}>Use test asset QR</Text>
        </Pressable>
      </View>
      {onClose && (
        <Pressable style={s.closeBtn} onPress={onClose}>
          <Text style={s.closeText}>Cancel</Text>
        </Pressable>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { minHeight: 460, borderRadius: 12, overflow: "hidden", backgroundColor: "#0f1b2d" },
  camera: { height: 320, width: "100%" },
  center: { padding: 24, alignItems: "center", gap: 12 },
  msg: { textAlign: "center", color: "#33465f" },
  btn: { backgroundColor: "#1F3864", paddingVertical: 10, paddingHorizontal: 18, borderRadius: 8 },
  btnText: { color: "#fff", fontWeight: "700" },
  btnOff: { opacity: 0.45 },
  error: { color: "#ffb5a8", padding: 10, fontSize: 12 },
  detected: { color: "#b9fff3", paddingHorizontal: 10, paddingTop: 8, fontSize: 11 },
  manual: { padding: 10, gap: 8 },
  manualLabel: { color: "#d8e7e2", fontSize: 12, fontWeight: "700" },
  input: { backgroundColor: "#fff", borderRadius: 8, paddingHorizontal: 10, paddingVertical: 9, color: "#1c2e43" },
  testBtn: { alignItems: "center", paddingVertical: 9 },
  testBtnText: { color: "#b9fff3", fontSize: 12, fontWeight: "700", textDecorationLine: "underline" },
  closeBtn: {
    position: "absolute",
    top: 12,
    right: 12,
    backgroundColor: "rgba(0,0,0,.55)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 8,
  },
  closeText: { color: "#fff", fontWeight: "700" },
});
