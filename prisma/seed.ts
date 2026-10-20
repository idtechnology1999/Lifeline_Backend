/**
 * Seeds platform settings and the first admin. Outside production it also
 * adds demo accounts and sample activity so the apps have something to show.
 *
 *   npx prisma db seed
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import { PLATFORM_DEFAULTS } from '../src/settings/settings.service.js';
import { reference, round2 } from '../src/common/money.js';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
const storageRoot = resolve(process.env.STORAGE_DIR ?? './storage');
const settings = PLATFORM_DEFAULTS;
const commissionOn = (amount: number) => round2((amount * settings.commissionPercent) / 100);
const afterCommission = (amount: number) => round2(amount - commissionOn(amount));

async function main() {
  await prisma.setting.upsert({
    where: { key: 'platform' },
    create: { key: 'platform', value: settings as object },
    update: {},
  });

  // Change this password after the first login
  const email = process.env.ADMIN_EMAIL ?? 'admin@lifeline.app';
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('Set ADMIN_PASSWORD in .env before seeding.');
  await prisma.user.upsert({
    where: { email },
    create: { email, name: 'Lifeline Admin', passwordHash: await bcrypt.hash(password, 12), role: 'admin', adminRole: 'super_admin' },
    update: {},
  });
  console.log(`Admin: ${email}`);

  if (process.env.NODE_ENV === 'production') return;

  await demoAccounts();
  if (!(await prisma.user.findUnique({ where: { phone: '+2348030000100' } }))) await demoActivity();
  console.log('Demo data ready. Log in with +2348030000001 (patient), …02 ambulance, …03 pharmacy, …04 rider.');
}

// ---------- Demo accounts (DatabaseSeeder) ----------

async function demoAccounts() {
  const sarah = await prisma.user.upsert({
    where: { phone: '+2348030000001' },
    create: { phone: '+2348030000001', name: 'Sarah Johnson', email: 'sarah@example.com', city: 'Lagos', role: 'requester', phoneVerifiedAt: new Date() },
    update: {},
  });
  if (!(await prisma.emergencyContact.count({ where: { userId: sarah.id } }))) {
    await prisma.emergencyContact.createMany({
      data: [
        { userId: sarah.id, name: 'David Johnson', relation: 'Brother', phone: '+2348145450485' },
        { userId: sarah.id, name: 'Grace Johnson', relation: 'Mother', phone: '+2348022223333' },
      ],
    });
    await prisma.savedAddress.createMany({
      data: [
        { userId: sarah.id, label: 'Home', address: '36 Adesakin Avenue, Gbagada, Lagos' },
        { userId: sarah.id, label: 'Work', address: '12 Allen Avenue, Ikeja, Lagos' },
      ],
    });
  }
  if (Number(sarah.walletBalance) === 0) {
    await prisma.user.update({ where: { id: sarah.id }, data: { walletBalance: 20000 } });
    await prisma.walletEntry.create({
      data: { userId: sarah.id, type: 'fund', amount: 20000, balanceAfter: 20000, description: 'Wallet funded', method: 'card', reference: reference('LLW') },
    });
  }

  // Last known positions around Ikeja / Gbagada, Lagos
  const providers: [string, string, string, string, { kind: string; plate: string } | null, [number, number]][] = [
    ['+2348030000002', 'ambulance', 'RapidCare Ambulance', 'Tunde Bakare', { kind: 'ALS', plate: 'LAG-482KT' }, [6.596, 3.351]],
    ['+2348030000003', 'supplier', 'HealthPlus Pharmacy', 'Ngozi Eze', null, [6.6018, 3.3515]],
    ['+2348030000004', 'dispatcher', 'Musa Danjuma', 'Musa Danjuma', { kind: 'bike', plate: 'KJA-219XB' }, [6.556, 3.389]],
  ];
  for (const [phone, type, businessName, contactName, vehicle, [lat, lng]] of providers) {
    const user = await prisma.user.upsert({
      where: { phone },
      create: { phone, name: contactName, city: 'Lagos', role: 'provider', phoneVerifiedAt: new Date() },
      update: {},
    });
    await prisma.provider.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        type,
        businessName,
        contactName,
        phone,
        city: 'Lagos',
        address: '12 Allen Avenue, Ikeja',
        verification: 'approved',
        vehicleKind: vehicle?.kind ?? null,
        vehiclePlate: vehicle?.plate ?? null,
        latitude: lat,
        longitude: lng,
        locationUpdatedAt: new Date(),
        submittedAt: new Date(),
      },
      update: {},
    });
  }

  const pharmacy = await prisma.provider.findFirstOrThrow({ where: { type: 'supplier' }, orderBy: { id: 'asc' } });
  const products: [string, string, number, number, boolean, string][] = [
    ['Blood Pressure Monitor', 'Medical Equipment', 12500, 15, false, '🩺'],
    ['Paracetamol 500mg', 'Drugs', 1500, 80, false, '💊'],
    ['Lisinopril', 'Drugs', 12500, 20, true, '💊'],
    ['First Aid Kit', 'Consumables', 12500, 25, false, '🧰'],
    ['Thermometer Digital', 'Medical Equipment', 3500, 42, false, '🌡️'],
    ['Surgical Masks (Box of 50)', 'Consumables', 1000, 60, false, '😷'],
  ];
  for (const [name, category, price, stock, requiresPrescription, emoji] of products) {
    const existing = await prisma.product.findFirst({ where: { supplierId: pharmacy.id, name } });
    if (!existing) await prisma.product.create({ data: { supplierId: pharmacy.id, name, category, price, stock, requiresPrescription, emoji } });
  }
}

// ---------- Sample activity (DemoSeeder) ----------

const FIRST = ['Michael', 'Chinedu', 'Aisha', 'Tunde', 'Ngozi', 'Emeka', 'Funke', 'Ibrahim', 'Kemi', 'Segun', 'Amaka', 'Yusuf', 'Bola', 'Chioma', 'David', 'Halima', 'Ifeoma', 'Grace', 'Tobi', 'Zainab'];
const LAST = ['Adeyemi', 'Okafor', 'Aliyu', 'Bello', 'Nwosu', 'Ogunleye', 'Abubakar', 'Adebayo', 'Okonkwo', 'Lawal', 'Afolabi', 'Obi', 'Salami', 'Ibekwe'];
const AREAS: [string, string][] = [
  ['Ikeja', 'Lagos'], ['Lekki Phase 1', 'Lagos'], ['Yaba', 'Lagos'], ['Surulere', 'Lagos'],
  ['Victoria Island', 'Lagos'], ['Gbagada', 'Lagos'], ['Wuse II', 'Abuja'], ['Garki', 'Abuja'],
];
const STREETS = ['Allen Avenue', 'Admiralty Way', 'Herbert Macaulay Way', 'Adeniran Ogunsanya St', 'Ozumba Mbadiwe Ave', 'Awolowo Road', 'Bode Thomas St'];
const HOSPITALS = ['Lagos University Teaching Hospital', 'Reddington Hospital', 'St. Nicholas Hospital', 'Evercare Hospital Lekki', 'Lagoon Hospital', 'National Hospital Abuja'];
const SYMPTOMS: Record<string, string[]> = {
  red: ['Severe Breathing Difficulty', 'Cardiac Arrest', 'Stroke', 'Unconscious / Unresponsive', 'Obstetric Emergency (Labor)'],
  yellow: ['Accident Victim', 'Snake Bite', 'Prolonged Seizures', 'Internal Bleeding'],
  green: ['Minor Fracture', 'High Fever', 'Dehydration'],
};

// Small deterministic PRNG so every fresh seed looks the same
let state = 20261019;
const rand = (min: number, max: number) => {
  state = (state * 1103515245 + 12345) % 2147483648;
  return min + (state % (max - min + 1));
};
const pick = <T>(items: T[]): T => items[rand(0, items.length - 1)];
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const addMinutes = (d: Date, m: number) => new Date(d.getTime() + m * 60_000);
let phoneSeq = 100;
const nextPhone = () => `+234803${String(phoneSeq++).padStart(7, '0')}`;
const plate = () => `${pick(['LAG', 'ABJ', 'KJA', 'EPE'])}-${rand(100, 999)}${String.fromCharCode(rand(65, 90))}${String.fromCharCode(rand(65, 90))}`;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

type ProviderRow = Prisma.ProviderGetPayload<object>;

async function demoActivity() {
  const requesters = [];
  for (let i = 0; i < 14; i++) {
    const name = `${pick(FIRST)} ${pick(LAST)}`;
    const [, city] = pick(AREAS);
    requesters.push(
      await prisma.user.create({
        data: {
          name,
          phone: nextPhone(),
          email: `${name.toLowerCase().replace(' ', '.')}${rand(1, 99)}.${phoneSeq}@gmail.com`,
          city,
          plan: pick(['none', 'none', 'none', 'basic', 'family', 'annual']),
          accountStatus: rand(1, 14) === 1 ? 'suspended' : 'active',
          phoneVerifiedAt: new Date(),
          createdAt: ago(60 * 24 * rand(3, 200)),
        },
      }),
    );
  }

  const ambulances: ProviderRow[] = [await prisma.provider.findFirstOrThrow({ where: { type: 'ambulance', verification: 'approved' }, orderBy: { id: 'asc' } })];
  for (const [business, verification, kind] of [
    ['LifeSaver EMS', 'approved', 'BLS'], ['Swift Response Medics', 'approved', 'ERV'],
    ['Guardian Ambulance Services', 'approved', 'ALS'], ['MedEvac Nigeria', 'pending', 'ALS'], ['Pulse Emergency', 'rejected', 'BLS'],
  ]) {
    ambulances.push(await provider('ambulance', business, verification, { kind, plate: plate() }));
  }
  const pharmacy = await prisma.provider.findFirstOrThrow({ where: { type: 'supplier' }, orderBy: { id: 'asc' } });
  await provider('supplier', 'MedPlus Pharmacy', 'approved');
  await provider('supplier', 'Alpha Pharmacy', 'pending');
  const rider = await prisma.provider.findFirstOrThrow({ where: { type: 'dispatcher' }, orderBy: { id: 'asc' } });
  await provider('dispatcher', null, 'approved', { kind: 'car', plate: plate() });
  await provider('dispatcher', null, 'pending', { kind: 'bicycle', plate: plate() });

  const approved = ambulances.filter((a) => a.verification === 'approved');
  await emergencies(requesters, approved);
  await orders(requesters, pharmacy, rider);

  for (const user of requesters.filter((u) => u.plan !== 'none')) {
    const price = settings.plans[user.plan as keyof typeof settings.plans];
    await transaction('subscription', user.id, null, null, price, price, ago(60 * 24 * rand(1, 28)));
  }

  for (const [i, p] of [...approved, pharmacy, rider].entries()) {
    const fresh = await prisma.provider.findUniqueOrThrow({ where: { id: p.id } });
    const withdrawn = await prisma.withdrawal.aggregate({ where: { providerId: p.id, status: { in: ['pending', 'paid'] } }, _sum: { amount: true } });
    const balance = Number(fresh.earnings) - Number(withdrawn._sum.amount ?? 0);
    if (balance < 2000) continue;
    await prisma.withdrawal.create({
      data: {
        providerId: p.id,
        amount: Math.floor((balance * 0.6) / 100) * 100,
        bank: pick(['GTBank', 'Access Bank', 'Zenith Bank', 'Opay', 'Moniepoint', 'Kuda']),
        accountName: fresh.contactName,
        accountNumber: String(rand(1000000000, 1999999999)),
        status: i % 3 === 0 ? 'paid' : 'pending',
        createdAt: ago(rand(60, 60 * 24 * 3)),
      },
    });
  }
}

async function provider(type: string, business: string | null, verification: string, vehicle?: { kind: string; plate: string }) {
  const contactName = `${pick(FIRST)} ${pick(LAST)}`;
  const [area, city] = pick(AREAS);
  const phone = nextPhone();
  const user = await prisma.user.create({ data: { name: contactName, phone, role: 'provider', city, phoneVerifiedAt: new Date() } });
  const p = await prisma.provider.create({
    data: {
      userId: user.id,
      type,
      businessName: business ?? contactName,
      contactName,
      phone,
      email: `${contactName.toLowerCase().replace(' ', '.')}@outlook.com`,
      city,
      address: `${rand(1, 120)} ${pick(STREETS)}, ${area}`,
      verification,
      rejectionReason: verification === 'rejected' ? 'Licence document is expired' : null,
      rating: verification === 'approved' ? rand(40, 50) / 10 : 0,
      online: verification === 'approved' && rand(0, 1) === 1,
      vehicleKind: vehicle?.kind ?? null,
      vehiclePlate: vehicle?.plate ?? null,
      submittedAt: ago(verification === 'approved' ? 60 * 24 * rand(10, 120) : rand(30, 60 * 48)),
    },
  });

  const documents: Record<string, [string, string][]> = {
    ambulance: [['CAC Certificate', 'registration'], ['Ambulance Operating Licence', 'license'], ['Vehicle Insurance', 'insurance']],
    supplier: [['CAC Certificate', 'registration'], ['PCN Pharmacy Licence', 'license']],
    dispatcher: [['Valid ID', 'id'], ["Driver's License", 'license']],
  };
  for (const [name, kind] of documents[type]) {
    const id = randomUUID();
    const path = join('document', String(user.id), `${id}.pdf`);
    const pdf = samplePdf(name, p.businessName);
    await mkdir(dirname(join(storageRoot, path)), { recursive: true });
    await writeFile(join(storageRoot, path), pdf);
    await prisma.storedFile.create({
      data: { id, ownerId: user.id, purpose: 'document', originalName: `${slug(name)}.pdf`, mimeType: 'application/pdf', size: pdf.length, path },
    });
    await prisma.providerDocument.create({ data: { providerId: p.id, fileId: id, name, kind } });
  }
  return p;
}

async function emergencies(requesters: { id: number }[], ambulances: ProviderRow[]) {
  const rates = settings.baseRates;
  const statuses = ['searching', 'negotiating', 'en_route', 'on_trip', 'cancelled', ...Array(11).fill('completed')];
  for (const [i, status] of statuses.entries()) {
    const severity = pick(['red', 'red', 'yellow', 'yellow', 'green']);
    const type = pick(['bls', 'als', 'erv'] as const);
    const [area] = pick(AREAS);
    const created = status === 'completed' || status === 'cancelled' ? ago(rand(90, 60 * 24 * 20)) : ago(rand(2, 40));
    const assigned = ['en_route', 'on_trip', 'completed'].includes(status);
    const provider = assigned ? ambulances[i % ambulances.length] : null;
    const agreed = assigned ? rates[type] + rand(4, 30) * 100 : null;

    const request = await prisma.emergencyRequest.create({
      data: {
        requesterId: requesters[i % requesters.length].id,
        providerId: provider?.id ?? null,
        severity,
        ambulanceType: type,
        symptoms: [pick(SYMPTOMS[severity])],
        pickup: `${rand(1, 120)} ${pick(STREETS)}, ${area}`,
        destination: pick(HOSPITALS),
        status,
        estimatedPrice: rates[type],
        agreedPrice: agreed,
        etaMinutes: ['en_route', 'on_trip'].includes(status) ? rand(4, 15) : null,
        paidAt: assigned ? created : null,
        completedAt: status === 'completed' ? addMinutes(created, rand(25, 70)) : null,
        createdAt: created,
        updatedAt: created,
      },
    });
    if (status === 'negotiating') {
      await prisma.emergencyRequestOffer.create({ data: { emergencyRequestId: request.id, providerId: ambulances[0].id, amount: rates[type] + 800, etaMinutes: 7 } });
    }
    if (provider && agreed) {
      await transaction('ambulance', request.requesterId, provider, { type: 'emergency_request', id: request.id }, agreed, commissionOn(agreed), created);
      if (status === 'completed') await credit(provider.id, afterCommission(agreed));
    }
  }
}

async function orders(requesters: { id: number }[], pharmacy: ProviderRow, rider: ProviderRow) {
  const products = await prisma.product.findMany({ where: { supplierId: pharmacy.id } });
  const fee = settings.deliveryBaseFee;
  const statuses = ['pending', 'pending', 'accepted', 'picked_up', 'cancelled', ...Array(9).fill('delivered')];
  for (const [i, status] of statuses.entries()) {
    const created = ['delivered', 'cancelled'].includes(status) ? ago(rand(120, 60 * 24 * 15)) : ago(rand(3, 50));
    const shuffled = [...products].sort(() => rand(0, 1) - 0.5);
    const lines = shuffled.slice(0, rand(1, 3)).map((product) => ({ product, qty: rand(1, 3) }));
    const subtotal = lines.reduce((s, l) => s + Number(l.product.price) * l.qty, 0);
    const [area] = pick(AREAS);
    const hasRider = ['picked_up', 'delivered'].includes(status);
    const paidAt = status === 'pending' && i === 0 ? null : created;

    const order = await prisma.supplyOrder.create({
      data: {
        requesterId: requesters[(i + 3) % requesters.length].id,
        supplierId: pharmacy.id,
        dispatcherId: hasRider ? rider.id : null,
        deliveryAddress: `${rand(1, 120)} ${pick(STREETS)}, ${area}`,
        subtotal,
        deliveryFee: fee,
        total: subtotal + fee,
        urgent: rand(1, 4) === 1,
        status,
        paidAt,
        deliveredAt: status === 'delivered' ? addMinutes(created, rand(30, 90)) : null,
        createdAt: created,
        updatedAt: created,
        items: {
          create: lines.map((l) => ({
            productId: l.product.id,
            name: l.product.name,
            qty: l.qty,
            price: l.product.price,
            requiresPrescription: l.product.requiresPrescription,
          })),
        },
      },
    });
    if (paidAt) {
      const tx = await transaction('supplies', order.requesterId, pharmacy, { type: 'supply_order', id: order.id }, subtotal + fee, commissionOn(subtotal), created);
      if (status === 'cancelled') await prisma.transaction.update({ where: { id: tx.id }, data: { status: 'refunded' } });
    }
    if (status === 'delivered') {
      await credit(pharmacy.id, afterCommission(subtotal));
      await credit(rider.id, fee);
    }
  }
}

function credit(providerId: number, amount: number) {
  return prisma.provider.update({ where: { id: providerId }, data: { earnings: { increment: amount }, completedJobs: { increment: 1 } } });
}

function transaction(kind: string, payerId: number, payee: ProviderRow | null, payable: { type: string; id: number } | null, amount: number, commission: number, at: Date) {
  return prisma.transaction.create({
    data: {
      reference: reference(),
      kind,
      payerId,
      payeeProviderId: payee?.id ?? null,
      payableType: payable?.type ?? null,
      payableId: payable?.id ?? null,
      amount,
      commission,
      method: pick(['card', 'card', 'transfer', 'wallet']),
      status: 'successful',
      createdAt: at,
      updatedAt: at,
    },
  });
}

/** A one-page PDF placeholder, so the admin console can preview "documents". */
function samplePdf(title: string, owner: string): Buffer {
  const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`).replace(/[^\x20-\x7e]/g, '');
  const content = [
    '0.04 0.48 1 rg 40 700 532 72 re f',
    `BT /F1 24 Tf 1 1 1 rg 60 728 Td (${esc(title)}) Tj ET`,
    `BT /F1 16 Tf 0.06 0.09 0.16 rg 60 640 Td (Issued to: ${esc(owner)}) Tj ET`,
    'BT /F1 12 Tf 0.4 0.45 0.55 rg 60 610 Td (Sample document generated for local testing) Tj ET',
    'BT /F1 28 Tf 0.04 0.48 1 rg 420 300 Td (SAMPLE) Tj ET',
  ].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
