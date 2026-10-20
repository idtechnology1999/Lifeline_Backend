import { useApp } from './helpers.js';

const newRequest = { severity: 'green', ambulanceType: 'bls', symptoms: [], pickup: 'Yaba', destination: 'LUTH' };

describe('Emergency requests', () => {
  const t = useApp();

  it('runs a full ambulance request with negotiation, payment and payout', async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const driver = await t.as((await t.createProvider('ambulance', '+2348030000002', { businessName: 'RapidCare' })).user);

    const created = await patient.post('/emergency-requests', {
      severity: 'red',
      ambulanceType: 'als',
      symptoms: ['Cardiac Arrest'],
      pickup: '36 Adesakin Avenue, Gbagada',
      destination: 'Reddington Hospital',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('searching');
    expect(created.body.data.estimatedPrice).toBe(4200);
    const id = created.body.data.id;

    // Driver sees it and offers a price
    expect((await driver.get('/provider/emergency-requests')).body.data[0].id).toBe(id);
    const offer = await driver.post(`/provider/emergency-requests/${id}/offer`, { amount: 6000, etaMinutes: 8 });
    expect(offer.status).toBe(200);
    expect(offer.body.data.status).toBe('negotiating');

    // Patient counters, driver accepts the counter
    const shown = await patient.get(`/emergency-requests/${id}`);
    expect(shown.body.data.offers[0].amount).toBe(6000);
    const offerId = shown.body.data.offers[0].id;

    const counter = await patient.post(`/emergency-requests/${id}/offers/${offerId}/counter`, { amount: 5000 });
    expect(counter.body.data.offers[0].lastBy).toBe('requester');

    // The patient can't accept their own counter
    expect((await patient.post(`/emergency-requests/${id}/offers/${offerId}/accept`)).status).toBe(409);

    const agreed = await driver.post(`/provider/emergency-requests/${id}/accept-counter`);
    expect(agreed.body.data).toMatchObject({ status: 'en_route', agreedPrice: 5000, providerName: 'RapidCare' });

    expect((await patient.post(`/emergency-requests/${id}/pay`, { method: 'card' })).body.data.paid).toBe(true);

    expect((await driver.post(`/provider/emergency-requests/${id}/complete`)).status).toBe(409);
    expect((await driver.post(`/provider/emergency-requests/${id}/start-trip`)).body.data.status).toBe('on_trip');
    expect((await driver.post(`/provider/emergency-requests/${id}/complete`)).body.data.status).toBe('completed');

    // 10% default commission: 5000 -> 4500 for the driver
    const earnings = await driver.get('/provider/earnings');
    expect(earnings.body.data).toMatchObject({ totalEarnings: 4500, completedJobs: 1 });

    const tx = await t.prisma.transaction.findFirstOrThrow({ where: { kind: 'ambulance' } });
    expect([Number(tx.amount), Number(tx.commission), tx.status]).toEqual([5000, 500, 'successful']);
  });

  it('hides requests from unapproved ambulances', async () => {
    const { user } = await t.createProvider('ambulance', '+2348030000002', { verification: 'pending' });
    expect((await (await t.as(user)).get('/provider/emergency-requests')).status).toBe(403);
  });

  it("does not show a patient someone else's request", async () => {
    const owner = await t.as(await t.createUser({ name: 'A', phone: '+2348030000001' }));
    const other = await t.as(await t.createUser({ name: 'B', phone: '+2348030000009' }));
    const id = (await owner.post('/emergency-requests', newRequest)).body.data.id;
    expect((await other.get(`/emergency-requests/${id}`)).status).toBe(404);
  });

  it('lists open requests nearest first (PostGIS)', async () => {
    const patient = await t.as(await t.createUser({ name: 'A', phone: '+2348030000001' }));
    const other = await t.as(await t.createUser({ name: 'B', phone: '+2348030000009' }));
    const driver = await t.as((await t.createProvider('ambulance', '+2348030000002', { latitude: 6.59, longitude: 3.35 })).user);

    const far = (await patient.post('/emergency-requests', { ...newRequest, pickupLat: 9.07, pickupLng: 7.4 })).body.data.id; // Abuja
    const near = (await other.post('/emergency-requests', { ...newRequest, pickupLat: 6.6, pickupLng: 3.36 })).body.data.id; // Ikeja

    const list = (await driver.get('/provider/emergency-requests')).body.data;
    expect(list.map((r: { id: string }) => r.id)).toEqual([near, far]);
    expect(list[0].distanceKm).toBeLessThan(5);
    expect(list[1].distanceKm).toBeGreaterThan(400);
  });
});
