import type { Server as HttpServer } from 'node:http';
import { Server } from 'socket.io';
import { verifyToken } from './auth.ts';

let io: Server | null = null;

export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: true } });
  io.use((socket, next) => {
    try {
      socket.data.auth = verifyToken(String(socket.handshake.auth?.token || ''));
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });
  io.on('connection', (socket) => {
    const a = socket.data.auth;
    if (a.bid) socket.join(`business:${a.bid}`);
    const storeId = a.sid || socket.handshake.auth?.storeId;
    if (storeId) socket.join(`store:${storeId}`);
    // POS -> customer display relay, keyed by the POS device id
    if (a.kind === 'display') socket.join(`display:${a.did}`);
    // Only the paired POS terminal (its user/device token carries the same device id) may push to its display.
    socket.on('display:update', (payload: any) => {
      if (payload?.deviceId && a.kind !== 'display' && (a.did === payload.deviceId || a.kind === 'device')) io!.to(`display:${payload.deviceId}`).emit('display:update', payload);
    });
  });
  return io;
}

export function emit(room: string, event: string, data: any) {
  io?.to(room).emit(event, data);
}
