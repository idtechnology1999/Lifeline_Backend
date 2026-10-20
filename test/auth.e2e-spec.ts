import { useApp } from './helpers.js';

describe('Auth', () => {
  const t = useApp();

  it('signs a requester up and logs them in with an OTP', async () => {
    const send = await t.guest().post('/auth/otp/send', { phone: '0803 123 4567', purpose: 'signup' });
    expect(send.status).toBe(200);
    expect(send.body.phone).toBe('+2348031234567');

    const signup = await t.guest().post('/auth/otp/verify', { phone: '+234-803-123-4567', code: send.body.debugCode, purpose: 'signup', name: 'Ada Obi' });
    expect(signup.status).toBe(201);
    expect(signup.body.user.role).toBe('requester');
    expect(signup.body.token).toEqual(expect.any(String));

    const again = await t.guest().post('/auth/otp/send', { phone: '+234 0803 123 4567', purpose: 'login' });
    expect(again.body.phone).toBe('+2348031234567');

    const loginCode = (await t.guest().post('/auth/otp/send', { phone: '08031234567', purpose: 'login' })).body.debugCode;
    const login = await t.guest().post('/auth/otp/verify', { phone: '08031234567', code: loginCode, purpose: 'login' });
    expect(login.status).toBe(200);

    const me = await t.guest().get('/me').set('Authorization', `Bearer ${login.body.token}`);
    expect(me.body.data.name).toBe('Ada Obi');
  });

  it('rejects a wrong code and never accepts a code twice', async () => {
    const code = (await t.guest().post('/auth/otp/send', { phone: '08031234567', purpose: 'signup' })).body.debugCode;
    const wrong = code === '111111' ? '222222' : '111111';
    const body = { phone: '08031234567', purpose: 'signup', name: 'A' };

    const bad = await t.guest().post('/auth/otp/verify', { ...body, code: wrong });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.code).toBeDefined();

    expect((await t.guest().post('/auth/otp/verify', { ...body, code })).status).toBe(201);

    const reused = await t.guest().post('/auth/otp/verify', { ...body, code });
    expect(reused.status).toBe(422);
    expect(reused.body.errors.code).toBeDefined();
  });

  it('requires an existing account to log in', async () => {
    const res = await t.guest().post('/auth/otp/send', { phone: '08039999999', purpose: 'login' });
    expect(res.status).toBe(422);
    expect(res.body.errors.phone).toBeDefined();
  });

  it('logs admins in with a password and keeps requesters out of admin routes', async () => {
    await t.createUser({ name: 'Admin', email: 'admin@lifeline.app', password: 'secret123', role: 'admin' });

    const bad = await t.guest().post('/admin/auth/login', { email: 'admin@lifeline.app', password: 'wrong' });
    expect(bad.status).toBe(422);
    expect(bad.body.errors.email).toBeDefined();

    const ok = await t.guest().post('/admin/auth/login', { email: 'admin@lifeline.app', password: 'secret123' });
    expect(ok.status).toBe(200);
    expect((await t.guest().get('/admin/dashboard').set('Authorization', `Bearer ${ok.body.token}`)).status).toBe(200);

    const requester = await t.createUser({ name: 'R', phone: '+2348030000001' });
    expect((await (await t.as(requester)).get('/admin/dashboard')).status).toBe(403);
  });

  it('revokes the token on logout', async () => {
    const user = await t.createUser({ name: 'R', phone: '+2348030000001' });
    const api = await t.as(user);
    expect((await api.post('/auth/logout')).status).toBe(200);
    expect((await api.get('/me')).status).toBe(401);
  });
});
