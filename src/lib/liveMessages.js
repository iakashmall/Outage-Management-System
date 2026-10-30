// src/lib/liveMessages.js
// Real-time "a message was posted" signal from the OMS backend. The backend
// bridges every domain event to socket.io (backend/src/index.js), and the
// dashboard already listens on the same topic. The event is only a nudge:
// the app re-reads its messages through the signed-in REST API, so what the
// crew sees is still exactly what GET /mobile/crews/:id/messages allows.
// The poll in NativeApp stays as the fallback: every 15 s while the socket
// is down, once a minute while it is up.
import { Platform } from "react-native";
import { io } from "socket.io-client";
import { apiBase } from "./server";

const MESSAGE_TOPIC = "oms.message.posted";

// Calls onChange() when any message is posted, and when the socket
// (re)connects, since messages may have arrived while it was down.
// onConnection(true | false) follows the socket going up and down.
// Returns a function that closes the socket.
export function watchMessages(onChange, onConnection = () => {}) {
  // On web the page is served by Vite, which only proxies /api.
  if (Platform.OS === "web") return () => {};
  const socket = io(apiBase().replace(/\/api$/, ""), { transports: ["websocket"], reconnectionDelayMax: 10000 });
  socket.on(MESSAGE_TOPIC, () => onChange());
  socket.on("connect", () => {
    onConnection(true);
    onChange();
  });
  socket.on("disconnect", () => onConnection(false));
  return () => socket.disconnect();
}
