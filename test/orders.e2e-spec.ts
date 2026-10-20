import { useApp } from './helpers.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

describe('Supply orders', () => {
  const t = useApp();

  const setup = async () => {
    const patient = await t.as(await t.createUser({ name: 'Sarah', phone: '+2348030000001' }));
    const pharmacy = await t.createProvider('supplier', '+2348030000003', { businessName: 'HealthPlus' });
    const rider = await t.createProvider('dispatcher', '+2348030000004', { businessName: 'Rider' });
    return { patient, pharmacy, rider, pharmacyApi: await t.as(pharmacy.user), riderApi: await t.as(rider.user) };
  };

  it('takes an order from the pharmacy to the doorstep and pays everyone', async () => {
    const { patient, pharmacy, rider, pharmacyApi, riderApi } = await setup();

    const product = await pharmacyApi.post('/provider/products', { name: 'Paracetamol 500mg', category: 'Drugs', price: 1500, stock: 10 });
    expect(product.status).toBe(201);
    const productId = Number(product.body.data.id);

    expect((await patient.get('/products')).body.data[0].name).toBe('Paracetamol 500mg');

    const tooMany = await patient.post('/orders', { items: [{ productId, qty: 11 }], deliveryAddress: '36 Yaba Onike Street' });
    expect(tooMany.status).toBe(422);
    expect(tooMany.body.errors['items.0.qty']).toBeDefined();

    const order = await patient.post('/orders', { items: [{ productId, qty: 2 }], deliveryAddress: '36 Yaba Onike Street' });
    expect(order.status).toBe(201);
    expect(order.body.data).toMatchObject({ subtotal: 3000, deliveryFee: 1500, total: 4500 });
    const id = order.body.data.id;

    expect((await patient.post(`/orders/${id}/pay`, { method: 'transfer' })).body.data.paid).toBe(true);

    // Not offered to riders until the pharmacy accepts
    expect((await riderApi.get('/provider/deliveries/available')).body.data).toHaveLength(0);

    expect((await pharmacyApi.post(`/provider/orders/${id}/accept`)).body.data.status).toBe('accepted');
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: productId } })).stock).toBe(8);

    expect((await riderApi.get('/provider/deliveries/available')).body.data).toHaveLength(1);
    expect((await riderApi.post(`/provider/deliveries/${id}/accept`)).body.data.dispatcherName).toBe('Rider');
    expect((await riderApi.post(`/provider/deliveries/${id}/deliver`)).status).toBe(409);
    expect((await riderApi.post(`/provider/deliveries/${id}/pickup`)).body.data.status).toBe('picked_up');
    expect((await riderApi.post(`/provider/deliveries/${id}/deliver`)).body.data.status).toBe('delivered');

    // Pharmacy gets goods minus 10% commission, rider gets the full delivery fee
    const earnings = async (pid: number) => Number((await t.prisma.provider.findUniqueOrThrow({ where: { id: pid } })).earnings);
    expect(await earnings(pharmacy.provider.id)).toBe(2700);
    expect(await earnings(rider.provider.id)).toBe(1500);
  });

  it('restores stock when an accepted order is cancelled', async () => {
    const { patient, pharmacy, pharmacyApi } = await setup();
    const product = await t.prisma.product.create({ data: { supplierId: pharmacy.provider.id, name: 'Masks', category: 'Consumables', price: 1000, stock: 5 } });

    const id = (await patient.post('/orders', { items: [{ productId: product.id, qty: 3 }], deliveryAddress: 'Ikeja' })).body.data.id;
    await pharmacyApi.post(`/provider/orders/${id}/accept`);
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(2);

    expect((await patient.post(`/orders/${id}/cancel`)).body.data.status).toBe('cancelled');
    expect((await t.prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stock).toBe(5);
  });

  it('stores product photos privately on disk and serves them through the API', async () => {
    const { pharmacy, pharmacyApi } = await setup();
    const product = await t.prisma.product.create({ data: { supplierId: pharmacy.provider.id, name: 'Masks', category: 'Consumables', price: 1000, stock: 5 } });

    const upload = await pharmacyApi.agent
      .post(`/api/v1/provider/products/${product.id}/images`)
      .set('Authorization', `Bearer ${pharmacyApi.token}`)
      .attach('image', PNG, { filename: 'mask.png', contentType: 'image/png' });
    expect(upload.status).toBe(200);
    const url: string = upload.body.data.imageUris[0];
    expect(url).toMatch(/\/api\/v1\/files\/[0-9a-f-]{36}$/);

    const file = await t.prisma.storedFile.findFirstOrThrow();
    expect(file).toMatchObject({ purpose: 'product_image', mimeType: 'image/png', ownerId: pharmacy.user.id });

    // Patients see the photo in the public catalog, and can load it
    expect((await t.guest().get('/products')).body.data[0].imageUris[0]).toBe(url);
    const image = await t.guest().agent.get(new URL(url).pathname);
    expect(image.status).toBe(200);
    expect(image.headers['content-type']).toBe('image/png');

    // Non-images are refused
    const pdf = await pharmacyApi.agent
      .post(`/api/v1/provider/products/${product.id}/images`)
      .set('Authorization', `Bearer ${pharmacyApi.token}`)
      .set('Accept', 'application/json')
      .attach('image', Buffer.from('%PDF-1.4'), { filename: 'x.pdf', contentType: 'application/pdf' });
    expect(pdf.status).toBe(422);
    expect(pdf.body.errors.image).toBeDefined();
  });

  it('never lets a withdrawal exceed the balance', async () => {
    const { rider, riderApi } = await setup();
    await t.prisma.provider.update({ where: { id: rider.provider.id }, data: { earnings: 5000 } });
    const payload = { bank: 'GTBank', accountName: 'Rider', accountNumber: '0123456789' };

    expect((await riderApi.post('/provider/withdrawals', { ...payload, amount: 4000 })).status).toBe(201);
    expect((await riderApi.post('/provider/withdrawals', { ...payload, amount: 2000 })).status).toBe(422);
  });
});
