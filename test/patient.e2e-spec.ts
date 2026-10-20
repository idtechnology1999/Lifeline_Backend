import { useApp } from './helpers.js';

describe('Patient data, wallet and notifications', () => {
  const t = useApp();

  it('funds the wallet, pays from it and gets refunded to it', async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const { provider } = await t.createProvider('supplier', '+2348030000003', { businessName: 'HealthPlus' });
    const product = await t.prisma.product.create({ data: { supplierId: provider.id, name: 'Masks', category: 'Consumables', price: 1000, stock: 10 } });

    const tooSmall = await patient.post('/wallet/fund', { amount: 50, method: 'card' });
    expect(tooSmall.status).toBe(422);
    expect(tooSmall.body.errors.amount).toBeDefined();

    const funded = await patient.post('/wallet/fund', { amount: 3000, method: 'card' });
    expect(funded.body.data.balance).toBe(3000);
    expect(funded.body.data.entries[0].type).toBe('fund');

    // Order costs 2000 + 1500 delivery = 3500: more than the wallet holds
    const id = (await patient.post('/orders', { items: [{ productId: product.id, qty: 2 }], deliveryAddress: 'Yaba' })).body.data.id;
    expect((await patient.post(`/orders/${id}/pay`, { method: 'wallet' })).status).toBe(422);
    expect((await patient.get('/wallet')).body.data.balance).toBe(3000);

    await patient.post('/wallet/fund', { amount: 1000, method: 'transfer' });
    expect((await patient.post(`/orders/${id}/pay`, { method: 'wallet' })).body.data.paid).toBe(true);
    const paid = (await patient.get('/wallet')).body.data;
    expect(paid.balance).toBe(500);
    expect(paid.entries[0]).toMatchObject({ type: 'payment', amount: -3500 });

    // Cancelling puts the money back in the wallet
    expect((await patient.post(`/orders/${id}/cancel`)).body.data.status).toBe('cancelled');
    const refunded = (await patient.get('/wallet')).body.data;
    expect(refunded.balance).toBe(4000);
    expect(refunded.entries[0].type).toBe('refund');
    expect(await t.prisma.transaction.count({ where: { method: 'wallet', status: 'refunded' } })).toBe(1);
  });

  it('notifies the patient and the driver through a trip', async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const driver = await t.as((await t.createProvider('ambulance', '+2348030000002', { businessName: 'RapidCare', online: true })).user);

    const id = (await patient.post('/emergency-requests', { severity: 'red', ambulanceType: 'bls', symptoms: ['Stroke'], pickup: 'Yaba', destination: 'LUTH' })).body.data.id;

    // Online ambulances hear about new emergencies
    const driverInbox = (await driver.get('/notifications')).body;
    expect(driverInbox.unreadCount).toBe(1);
    expect(driverInbox.data[0]).toMatchObject({ type: 'new_emergency', data: { requestId: id } });

    await driver.post(`/provider/emergency-requests/${id}/offer`, { amount: 4000 });
    expect((await patient.get('/notifications')).body.data[0]).toMatchObject({ type: 'offer_received', title: 'RapidCare can help' });

    const offerId = (await patient.get(`/emergency-requests/${id}`)).body.data.offers[0].id;
    await patient.post(`/emergency-requests/${id}/offers/${offerId}/accept`);

    expect((await patient.get('/notifications')).body.data[0].type).toBe('ambulance_assigned');
    expect((await driver.get('/notifications')).body.data[0].type).toBe('trip_assigned');

    expect((await driver.post('/notifications/read-all')).body.unreadCount).toBe(0);
    expect((await driver.get('/notifications/unread-count')).body.unreadCount).toBe(0);
    // Patient's inbox is untouched by the driver's read-all
    expect((await patient.get('/notifications/unread-count')).body.unreadCount).toBe(2);
  });

  it('shows the ambulance location only during the trip', async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const { provider, user } = await t.createProvider('ambulance', '+2348030000002', { businessName: 'RapidCare', online: true });
    const driver = await t.as(user);

    const invalid = await driver.post('/provider/location', { lat: 200, lng: 3 });
    expect(invalid.status).toBe(422);
    expect(invalid.body.errors.lat).toBeDefined();
    const moved = await driver.post('/provider/location', { lat: 6.59, lng: 3.35 });
    expect(moved.status).toBe(200);
    expect(moved.body.data.lat).toBe(6.59);

    // The database trigger keeps the PostGIS point in step
    const [point] = await t.prisma.$queryRaw<{ lat: number; lng: number }[]>`
      SELECT ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM providers WHERE id = ${provider.id}`;
    expect(point).toEqual({ lat: 6.59, lng: 3.35 });

    const created = await patient.post('/emergency-requests', {
      severity: 'red', ambulanceType: 'bls', symptoms: [],
      pickup: 'Gbagada', pickupLat: 6.55, pickupLng: 3.39,
      destination: 'LUTH', destinationLat: 6.517, destinationLng: 3.355,
    });
    expect(created.body.data.destinationCoords.lat).toBe(6.517);
    expect(created.body.data.providerLocation).toBeNull();
    const id = created.body.data.id;

    await driver.post(`/provider/emergency-requests/${id}/offer`, { amount: 3000 });

    // Offers show where each ambulance is
    const shown = (await patient.get(`/emergency-requests/${id}`)).body.data;
    expect(shown.offers[0].providerLocation.lat).toBe(6.59);
    await patient.post(`/emergency-requests/${id}/offers/${shown.offers[0].id}/accept`);

    // The driver moves; the patient sees it
    await driver.post('/provider/location', { lat: 6.57, lng: 3.37 });
    expect((await patient.get(`/emergency-requests/${id}`)).body.data.providerLocation.lat).toBe(6.57);

    await driver.post(`/provider/emergency-requests/${id}/start-trip`);
    await driver.post(`/provider/emergency-requests/${id}/complete`);

    // After the trip, the location is no longer shared
    expect((await patient.get(`/emergency-requests/${id}`)).body.data.providerLocation).toBeNull();
  });

  it('manages emergency contacts and saved addresses', async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const other = await t.as(await t.createUser({ name: 'Other', phone: '+2348030000009' }));

    const contact = await patient.post('/me/contacts', { name: 'David', relation: 'Brother', phone: '08145450485' });
    expect(contact.status).toBe(201);
    expect((await patient.post('/me/addresses', { label: 'Home', address: '36 Adesakin Avenue' })).status).toBe(201);

    const contacts = (await patient.get('/me/contacts')).body.data;
    expect(contacts).toHaveLength(1);
    expect(contacts[0].relation).toBe('Brother');
    expect((await patient.get('/me/addresses')).body.data[0].label).toBe('Home');

    // Can't touch someone else's contact
    expect((await other.delete(`/me/contacts/${contact.body.data.id}`)).status).toBe(404);
    expect((await patient.delete(`/me/contacts/${contact.body.data.id}`)).status).toBe(200);
    expect((await patient.get('/me/contacts')).body.data).toHaveLength(0);
  });

  it('subscribes to a plan', async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const res = await patient.post('/subscription', { plan: 'basic', method: 'card' });
    expect(res.status).toBe(200);
    expect(res.body.data.plan).toBe('basic');
    expect((await patient.post('/subscription', { plan: 'basic', method: 'card' })).status).toBe(409);
    const tx = await t.prisma.transaction.findFirstOrThrow({ where: { kind: 'subscription' } });
    expect([Number(tx.amount), Number(tx.commission)]).toEqual([25000, 25000]);
  });

  it('keeps the catalog public', async () => {
    expect((await t.guest().get('/products')).status).toBe(200);
    const pricing = await t.guest().get('/pricing');
    expect(pricing.status).toBe(200);
    expect(pricing.body.baseRates.bls).toBe(2500);
  });
});
