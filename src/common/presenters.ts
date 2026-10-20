// JSON shapes sent to the apps. These match the old Laravel API Resources
// field-for-field (camelCase, string ids, numbers for money) so the admin
// console and mobile app work unchanged.
import type { Prisma } from '../generated/prisma/client.js';
import { fileUrl } from '../files/files.service.js';
import { iso, num, numOrNull } from './money.js';

type ProviderRow = Prisma.ProviderGetPayload<object>;
type UserRow = Prisma.UserGetPayload<object>;

export function location(p: Pick<ProviderRow, 'latitude' | 'longitude' | 'locationUpdatedAt'> | null | undefined) {
  if (!p || p.latitude === null || p.longitude === null) return null;
  return { lat: p.latitude, lng: p.longitude, updatedAt: iso(p.locationUpdatedAt) };
}

export const providerInclude = {
  user: true,
  documents: { include: { file: true }, orderBy: { id: 'asc' } },
} as const satisfies Prisma.ProviderInclude;

type FullProvider = Prisma.ProviderGetPayload<{ include: typeof providerInclude }>;

export function presentProvider(p: ProviderRow & Partial<Pick<FullProvider, 'user' | 'documents'>>) {
  return {
    id: String(p.id),
    userId: String(p.userId),
    type: p.type,
    businessName: p.businessName,
    contactName: p.contactName,
    phone: p.phone,
    email: p.email,
    city: p.city,
    address: p.address,
    submittedAt: iso(p.submittedAt),
    verification: p.verification,
    rejectionReason: p.rejectionReason,
    accountStatus: p.user?.accountStatus ?? 'active',
    rating: num(p.rating),
    completedJobs: p.completedJobs,
    earnings: num(p.earnings),
    online: p.online,
    location: location(p),
    vehicle: p.vehiclePlate || p.vehicleKind ? { kind: p.vehicleKind, plate: p.vehiclePlate } : null,
    availability: p.availability,
    hours: p.availability === 'scheduled' ? { start: p.hoursStart, end: p.hoursEnd } : null,
    details: p.details ?? {},
    ...(p.documents && {
      documents: p.documents.map((d) => ({ id: String(d.id), name: d.name, kind: d.kind, url: fileUrl(d.file) })),
    }),
  };
}

export function presentUser(u: UserRow & { provider?: ProviderRow | null }) {
  return {
    id: String(u.id),
    name: u.name,
    phone: u.phone,
    email: u.email,
    role: u.role,
    ...(u.role === 'admin' && { adminRole: u.adminRole }),
    city: u.city,
    plan: u.plan,
    ...(u.role === 'requester' && { walletBalance: num(u.walletBalance) }),
    accountStatus: u.accountStatus,
    joinedAt: iso(u.createdAt),
    ...(u.role === 'provider' && { provider: u.provider ? presentProvider({ ...u.provider, user: u }) : null }),
  };
}

export function presentRequester(u: UserRow & { _count?: { emergencyRequests: number; supplyOrders: number } }) {
  return {
    id: String(u.id),
    name: u.name,
    phone: u.phone,
    email: u.email,
    city: u.city,
    joinedAt: iso(u.createdAt),
    plan: u.plan,
    totalRequests: u._count?.emergencyRequests ?? 0,
    totalOrders: u._count?.supplyOrders ?? 0,
    accountStatus: u.accountStatus,
  };
}

// ---------- Emergencies ----------

export const requestInclude = { requester: true, provider: true } as const satisfies Prisma.EmergencyRequestInclude;
type RequestRow = Prisma.EmergencyRequestGetPayload<{ include: typeof requestInclude }>;
type OfferRow = Prisma.EmergencyRequestOfferGetPayload<{ include: { provider: true } }>;

export function presentOffer(o: OfferRow) {
  return {
    id: String(o.id),
    requestId: String(o.emergencyRequestId),
    providerId: String(o.providerId),
    providerName: o.provider?.businessName ?? null,
    providerPhone: o.provider?.phone ?? null,
    providerRating: num(o.provider?.rating ?? 0),
    vehicle: o.provider ? { kind: o.provider.vehicleKind, plate: o.provider.vehiclePlate } : null,
    // Where the offering ambulance is, so the patient can see who is closest
    providerLocation: o.status === 'open' ? location(o.provider) : null,
    amount: num(o.amount),
    lastBy: o.lastBy,
    etaMinutes: o.etaMinutes,
    status: o.status,
    updatedAt: iso(o.updatedAt),
  };
}

export function presentRequest(r: RequestRow & { offers?: OfferRow[] }) {
  const live = r.status === 'en_route' || r.status === 'on_trip';
  return {
    id: String(r.id),
    requesterId: String(r.requesterId),
    requesterName: r.requester?.name ?? null,
    requesterPhone: r.requester?.phone ?? null,
    severity: r.severity,
    ambulanceType: r.ambulanceType,
    symptoms: (r.symptoms as string[]) ?? [],
    notes: r.notes,
    pickup: r.pickup,
    pickupCoords: r.pickupLat !== null && r.pickupLng !== null ? { lat: r.pickupLat, lng: r.pickupLng } : null,
    destination: r.destination,
    destinationCoords: r.destinationLat !== null && r.destinationLng !== null ? { lat: r.destinationLat, lng: r.destinationLng } : null,
    // Live ambulance position, shared only while it is on this job
    providerLocation: live ? location(r.provider) : null,
    createdAt: iso(r.createdAt),
    status: r.status,
    providerId: r.providerId ? String(r.providerId) : null,
    providerName: r.provider?.businessName ?? null,
    providerPhone: r.provider?.phone ?? null,
    vehiclePlate: r.provider?.vehiclePlate ?? null,
    estimatedPrice: num(r.estimatedPrice),
    agreedPrice: numOrNull(r.agreedPrice),
    etaMinutes: r.etaMinutes,
    paid: r.paidAt !== null,
    ...(r.offers && { offers: r.offers.map(presentOffer) }),
  };
}

// ---------- Catalog & orders ----------

export const productInclude = {
  supplier: true,
  images: { include: { file: true }, orderBy: { position: 'asc' } },
} as const satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;

export function presentProduct(p: ProductRow) {
  return {
    id: String(p.id),
    supplierId: String(p.supplierId),
    supplierName: p.supplier?.businessName,
    name: p.name,
    category: p.category,
    description: p.description,
    usageNotes: p.usageNotes,
    price: num(p.price),
    stock: p.stock,
    expiresAt: p.expiresAt ? p.expiresAt.toISOString().slice(0, 10) : null,
    available: p.available,
    requiresPrescription: p.requiresPrescription,
    emoji: p.emoji,
    imageUris: p.images.map((i) => fileUrl(i.file)),
    createdAt: iso(p.createdAt),
  };
}

export const orderInclude = {
  requester: true,
  supplier: true,
  dispatcher: true,
  items: { orderBy: { id: 'asc' } },
} as const satisfies Prisma.SupplyOrderInclude;
type OrderRow = Prisma.SupplyOrderGetPayload<{ include: typeof orderInclude }>;

export function presentOrder(o: OrderRow) {
  const riderLive = o.status === 'accepted' || o.status === 'picked_up';
  return {
    id: String(o.id),
    requesterId: String(o.requesterId),
    customerName: o.requester?.name ?? null,
    customerPhone: o.requester?.phone ?? null,
    supplierId: String(o.supplierId),
    supplierName: o.supplier?.businessName ?? null,
    supplierPhone: o.supplier?.phone ?? null,
    supplierAddress: o.supplier?.address ?? null,
    dispatcherId: o.dispatcherId ? String(o.dispatcherId) : null,
    dispatcherName: o.dispatcher?.businessName ?? null,
    dispatcherPhone: o.dispatcher?.phone ?? null,
    items: o.items.map((i) => ({
      productId: i.productId ? String(i.productId) : null,
      name: i.name,
      qty: i.qty,
      price: num(i.price),
      lineTotal: num(i.price) * i.qty,
      requiresPrescription: i.requiresPrescription,
    })),
    deliveryAddress: o.deliveryAddress,
    deliveryCoords: o.deliveryLat !== null && o.deliveryLng !== null ? { lat: o.deliveryLat, lng: o.deliveryLng } : null,
    supplierLocation: location(o.supplier),
    // Live rider position, shared only while they are on this delivery
    dispatcherLocation: riderLive ? location(o.dispatcher) : null,
    deliveryNote: o.deliveryNote,
    subtotal: num(o.subtotal),
    deliveryFee: num(o.deliveryFee),
    total: num(o.total),
    urgent: o.urgent,
    paid: o.paidAt !== null,
    createdAt: iso(o.createdAt),
    status: o.status,
  };
}

// ---------- Money ----------

type TxRow = Prisma.TransactionGetPayload<{ include: { payer: true; payee: true } }>;

export function presentTransaction(t: TxRow) {
  return {
    id: String(t.id),
    reference: t.reference,
    kind: t.kind,
    payer: t.payer?.name ?? null,
    payee: t.payee?.businessName ?? 'Lifeline',
    amount: num(t.amount),
    commission: num(t.commission),
    method: t.method,
    status: t.status,
    createdAt: iso(t.createdAt),
  };
}

type WithdrawalRow = Prisma.WithdrawalGetPayload<{ include: { provider: true } }>;

export function presentWithdrawal(w: WithdrawalRow) {
  return {
    id: String(w.id),
    providerId: String(w.providerId),
    providerName: w.provider?.businessName ?? null,
    providerType: w.provider?.type ?? null,
    amount: num(w.amount),
    bank: w.bank,
    accountName: w.accountName,
    accountNumber: w.accountNumber,
    requestedAt: iso(w.createdAt),
    status: w.status,
  };
}
