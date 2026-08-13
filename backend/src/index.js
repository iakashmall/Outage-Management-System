import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import { migrate } from './infra/db.js';
import { seed } from './infra/seed.js';
import { api } from './routes/api.js';
import { bus } from './domain/bus.js';
import { startSimulator } from './realtime/simulator.js';

const PORT = process.env.PORT || 4000;

migrate();
seed(); // idempotent — only seeds an empty DB

const app = express();
app.use(cors());
app.use(express.json());
app.get('/api/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
app.use('/api', api);

const http = createServer(app);
const io = new Server(http, { cors: { origin: '*' } });

// Bridge every domain event straight to WebSocket subscribers.
// The frontend and mobile app both listen on these topic names.
bus.onAny(({ topic, payload }) => io.emit(topic, payload));

io.on('connection', (socket) => {
  socket.emit('server.hello', { ts: new Date().toISOString() });
});

http.listen(PORT, () => {
  console.log(`\n  OMS backend running`);
  console.log(`  REST   → http://localhost:${PORT}/api`);
  console.log(`  WS     → ws://localhost:${PORT}`);
  console.log(`  Health → http://localhost:${PORT}/api/health\n`);
  startSimulator();
});
