import type { AddressInfo } from 'node:net';
import { io, type Socket } from 'socket.io-client';
import { useApp } from './helpers.js';

describe('Realtime (Socket.IO)', () => {
  const t = useApp();
  const sockets: Socket[] = [];
  let url: string;

  beforeAll(async () => {
    await t.app.listen(0, '127.0.0.1');
    url = `http://127.0.0.1:${(t.app.getHttpServer().address() as AddressInfo).port}`;
  });

  afterEach(() => sockets.splice(0).forEach((s) => s.disconnect()));

  const connect = (token?: string) =>
    new Promise<Socket>((resolve, reject) => {
      const socket = io(url, { auth: { token }, transports: ['websocket'], reconnection: false });
      sockets.push(socket);
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
    });

  /** The next `event` whose payload passes `match` (earlier broadcasts may still be in flight). */
  const next = <T>(socket: Socket, event: string, match: (payload: T) => boolean = () => true) =>
    new Promise<T>((resolve) => {
      const handler = (payload: T) => {
        if (!match(payload)) return;
        socket.off(event, handler);
        resolve(payload);
      };
      socket.on(event, handler);
    });

  it('refuses connections without a valid token', async () => {
    await expect(connect()).rejects.toThrow('Unauthenticated.');
    await expect(connect('1|nope')).rejects.toThrow('Unauthenticated.');
  });

  it('pushes notifications, trip updates and the ambulance position live', async () => {
    const patientUser = await t.createUser({ name: 'Sarah', phone: '+2348030000001' });
    const outsiderUser = await t.createUser({ name: 'Other', phone: '+2348030000009' });
    const patient = await t.as(patientUser);
    const driver = await t.as((await t.createProvider('ambulance', '+2348030000002', { businessName: 'RapidCare', online: true })).user);

    const patientSocket = await connect(patient.token);
    const driverSocket = await connect(driver.token);
    const outsiderSocket = await connect((await t.as(outsiderUser)).token);

    // Ambulances hear about new emergencies the moment they're created
    const newJob = next<{ type: string }>(driverSocket, 'notification', (n) => n.type === 'new_emergency');
    const id = (await patient.post('/emergency-requests', { severity: 'red', ambulanceType: 'bls', symptoms: [], pickup: 'Yaba', destination: 'LUTH' })).body.data.id;
    expect((await newJob).type).toBe('new_emergency');

    // Only people involved can follow a trip
    expect(await patientSocket.emitWithAck('subscribe', { type: 'request', id })).toEqual({ ok: true });
    expect(await outsiderSocket.emitWithAck('subscribe', { type: 'request', id })).toEqual({ ok: false });

    const updated = next<{ status: string; offers: { amount: number }[] }>(patientSocket, 'request.updated', (r) => r.status === 'negotiating');
    await driver.post(`/provider/emergency-requests/${id}/offer`, { amount: 4000 });
    const state = await updated;
    expect(state.offers[0].amount).toBe(4000);

    const offerId = (await patient.get(`/emergency-requests/${id}`)).body.data.offers[0].id;
    await patient.post(`/emergency-requests/${id}/offers/${offerId}/accept`);

    const moved = next<{ lat: number; lng: number }>(patientSocket, 'location', (p) => p.lat === 6.57);
    await driver.post('/provider/location', { lat: 6.57, lng: 3.37 });
    expect(await moved).toMatchObject({ lat: 6.57, lng: 3.37 });
  });
});
