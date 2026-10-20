import { useApp } from './helpers.js';

const newRequest = { severity: 'green', ambulanceType: 'bls', symptoms: [], pickup: 'Yaba', destination: 'LUTH' };

describe('Admin', () => {
  const t = useApp();
  const admin = async () => t.as(await t.createUser({ name: 'Admin', email: 'a@lifeline.app', password: 'x', role: 'admin' }));

  it('lets a provider register and an admin review them', async () => {
    const adminApi = await admin();
    const user = await t.as(await t.createUser({ name: 'Ngozi', phone: '+2348030000003', role: 'provider' }));

    const created = await user.post('/provider', {
      type: 'supplier',
      businessName: 'HealthPlus Pharmacy',
      contactName: 'Ngozi Eze',
      city: 'Lagos',
      availability: 'scheduled',
      hours: { start: '08:00', end: '20:00' },
      details: { categories: ['Drugs', 'Consumables'] },
    });
    expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ verification: 'pending', phone: '+2348030000003', hours: { start: '08:00', end: '20:00' } });
    const id = created.body.data.id;

    // Can't sell before approval
    expect((await user.get('/provider/products')).status).toBe(403);

    expect((await adminApi.get('/admin/providers?verification=pending')).body.data[0].id).toBe(id);
    const rejected = await adminApi.post(`/admin/providers/${id}/reject`, { reason: 'Licence expired' });
    expect(rejected.body.data.rejectionReason).toBe('Licence expired');

    // Editing a rejected application resubmits it
    expect((await user.patch('/provider', { businessName: 'HealthPlus Ikeja' })).body.data.verification).toBe('pending');

    expect((await adminApi.post(`/admin/providers/${id}/approve`)).body.data.verification).toBe('approved');
    expect((await user.get('/provider/products')).status).toBe(200);

    const suspended = await adminApi.patch(`/admin/providers/${id}/status`, { status: 'suspended' });
    expect(suspended.body.data.accountStatus).toBe('suspended');
    // Suspension signs them out everywhere
    expect((await user.get('/provider')).status).toBe(401);
  });

  it('drives prices from the settings', async () => {
    const adminApi = await admin();
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));

    const settings = (await adminApi.get('/admin/settings')).body.data;
    settings.baseRates.bls = 3000;
    expect((await adminApi.put('/admin/settings', settings)).body.data.baseRates.bls).toBe(3000);

    expect((await patient.post('/emergency-requests', newRequest)).body.data.estimatedPrice).toBe(3000);
  });

  it('blocks new requests in maintenance mode', async () => {
    const adminApi = await admin();
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));

    const settings = (await adminApi.get('/admin/settings')).body.data;
    expect((await adminApi.put('/admin/settings', { ...settings, maintenanceMode: true })).status).toBe(200);

    const res = await patient.post('/emergency-requests', newRequest);
    expect(res.status).toBe(503);
    expect(res.body.message).toContain('112');
  });

  it('validates settings', async () => {
    const res = await (await admin()).put('/admin/settings', { commissionPercent: 150 });
    expect(res.status).toBe(422);
    expect(res.body.errors.commissionPercent).toBeDefined();
    expect(res.body.errors['baseRates']).toBeDefined();
  });

  it('serves provider documents only through signed links', async () => {
    const adminApi = await admin();
    const user = await t.createUser({ name: 'Ngozi', phone: '+2348030000003', role: 'provider' });
    const api = await t.as(user);
    await api.post('/provider', { type: 'supplier', businessName: 'HealthPlus', contactName: 'Ngozi' });

    const upload = await api.agent
      .post('/api/v1/provider/documents')
      .set('Authorization', `Bearer ${api.token}`)
      .field('name', 'PCN Licence')
      .field('kind', 'license')
      .attach('file', Buffer.from('%PDF-1.4\n%%EOF'), { filename: 'licence.pdf', contentType: 'application/pdf' });
    expect(upload.status).toBe(201);

    const provider = (await adminApi.get('/admin/providers')).body.data[0];
    const url = new URL(provider.documents[0].url);
    expect(url.searchParams.get('sig')).toBeTruthy();

    expect((await t.guest().agent.get(url.pathname + url.search)).status).toBe(200);
    expect((await t.guest().agent.get(url.pathname)).status).toBe(404);
    url.searchParams.set('sig', 'forged');
    expect((await t.guest().agent.get(url.pathname + url.search)).status).toBe(404);
  });
});
