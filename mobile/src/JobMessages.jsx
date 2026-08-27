import { useEffect, useState } from "react";
import { getMessages, postMessage } from "./lib/api.js";

export default function JobMessages({ incidentId }) {
  const [msgs, setMsgs] = useState([]);
  const [text, setText] = useState("");

  const load = () => getMessages(incidentId).then(setMsgs).catch(() => {});
  useEffect(() => { if (incidentId) load(); }, [incidentId]);

  const send = async () => {
    if (!text.trim()) return;
    await postMessage(incidentId, text.trim());
    setText("");
    load();
  };

  return (
    <div className="job-messages" style={{ marginTop: 12 }}>
      <div className="job-status-row"><span>Messages</span></div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, margin: "8px 0" }}>
        {msgs.length === 0 && <span style={{ opacity: 0.6, fontSize: 13 }}>No messages yet.</span>}
        {msgs.map((m) => (
          <div key={m.id} style={{ background: "#eef2f7", borderRadius: 8, padding: "6px 9px" }}>
            <div style={{ fontSize: 11, opacity: 0.7 }}>
              {m.sender} · {new Date(m.ts).toLocaleTimeString()}
            </div>
            <div style={{ fontSize: 14 }}>{m.body}</div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="Message dispatcher…"
          style={{ flex: 1, padding: "8px 10px", borderRadius: 8, border: "1px solid #ccc" }}
        />
        <button onClick={send} style={{ padding: "8px 14px", borderRadius: 8, border: 0, background: "#173355", color: "#fff" }}>Send</button>
      </div>
    </div>
  );
}