import { beforeAll, describe, expect, it } from 'vitest';
import { api, auth, login, makeAdmin, makeCompany, makeEmployee, makeWorkflow, prisma } from '../helpers';
import { zonedTimeToUtc, toDateOnly } from '../../src/lib/dates';
import { processDay } from '../../src/modules/attendance/service';

let ctx: Awaited<ReturnType<typeof makeCompany>>;
let adminToken: string;
const TZ = 'Asia/Dubai';
const at = (date: string, hhmm: string) => zonedTimeToUtc(toDateOnly(date), hhmm, TZ).toISOString();

beforeAll(async () => {
  ctx = await makeCompany();
  adminToken = await login((await makeAdmin(ctx.company.id)).email);
});

describe('attendance', () => {
  it('HR entries are calculated against the shift (late, overtime)', async () => {
    const e = await makeEmployee(ctx.company.id);
    const res = await api().put('/api/attendance/records').set(auth(adminToken)).send({ employeeId: e.employee.id, date: '2026-03-02', checkIn: at('2026-03-02', '09:25'), checkOut: at('2026-03-02', '19:30') });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'LATE', lateMinutes: 25, overtimeMinutes: 65 });
  });

  it('web check-in creates today’s record and a quick second punch is refused', async () => {
    const e = await makeEmployee(ctx.company.id);
    const token = await login(e.user.email);
    const first = await api().post('/api/attendance/punch').set(auth(token)).send({ source: 'WEB' });
    expect(first.status).toBe(200);
    expect(first.body.action).toBe('CHECK_IN');
    expect(['PRESENT', 'LATE']).toContain(first.body.record.status);
    expect((await api().post('/api/attendance/punch').set(auth(token)).send({ source: 'WEB' })).status).toBe(422);
  });

  it('mobile check-in is restricted by the geofence', async () => {
    await prisma.attendancePolicy.update({ where: { companyId: ctx.company.id }, data: { geofenceLat: 25.2, geofenceLng: 55.27, geofenceRadiusMeters: 200 } });
    const e = await makeEmployee(ctx.company.id);
    const token = await login(e.user.email);
    const far = await api().post('/api/attendance/punch').set(auth(token)).send({ source: 'MOBILE', lat: 25.3, lng: 55.27 });
    expect(far.status).toBe(422);
    const near = await api().post('/api/attendance/punch').set(auth(token)).send({ source: 'MOBILE', lat: 25.2005, lng: 55.27 });
    expect(near.status).toBe(200);
    await prisma.attendancePolicy.update({ where: { companyId: ctx.company.id }, data: { geofenceLat: null, geofenceLng: null, geofenceRadiusMeters: null } });
  });

  it('corrections go through approval and are applied when approved', async () => {
    const mgr = await makeEmployee(ctx.company.id);
    const e = await makeEmployee(ctx.company.id, { managerId: mgr.employee.id });
    await makeWorkflow(ctx.company.id, 'ATTENDANCE_CORRECTION', [{ name: 'Manager', approverType: 'DIRECT_MANAGER' }]);
    await api().put('/api/attendance/records').set(auth(adminToken)).send({ employeeId: e.employee.id, date: '2026-03-03', checkIn: at('2026-03-03', '10:30'), checkOut: at('2026-03-03', '18:00') });
    const token = await login(e.user.email);
    const corr = await api().post('/api/attendance/corrections').set(auth(token)).send({ date: '2026-03-03', checkIn: at('2026-03-03', '08:55'), reason: 'Badge reader offline' });
    expect(corr.status).toBe(201);
    const approval = await prisma.approvalRequest.findUniqueOrThrow({ where: { requestType_entityId: { requestType: 'ATTENDANCE_CORRECTION', entityId: corr.body.id } } });
    const mgrToken = await login(mgr.user.email);
    expect((await api().post(`/api/approvals/requests/${approval.id}/approve`).set(auth(mgrToken)).send({})).body.status).toBe('APPROVED');
    const rec = await prisma.attendanceRecord.findUniqueOrThrow({ where: { employeeId_date: { employeeId: e.employee.id, date: toDateOnly('2026-03-03') } } });
    expect(rec).toMatchObject({ source: 'CORRECTION', lateMinutes: 0, status: 'PRESENT' });
  });

  it('closing a day marks absences on working days only, skipping approved leave', async () => {
    const e = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    const onLeave = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    await prisma.leaveRequest.create({ data: { employeeId: onLeave.employee.id, leaveTypeId: ctx.annual.id, startDate: toDateOnly('2026-03-04'), endDate: toDateOnly('2026-03-04'), days: 1, status: 'APPROVED' } });
    await processDay(ctx.company.id, '2026-03-04'); // Wednesday
    await processDay(ctx.company.id, '2026-03-07'); // Saturday (weekend)
    const a = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: e.employee.id, date: toDateOnly('2026-03-04') } } });
    expect(a?.status).toBe('ABSENT');
    const l = await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: onLeave.employee.id, date: toDateOnly('2026-03-04') } } });
    expect(l?.status).toBe('ON_LEAVE');
    expect(await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: e.employee.id, date: toDateOnly('2026-03-07') } } })).toBeNull();
  });

  it('holidays are respected', async () => {
    await prisma.holiday.create({ data: { companyId: ctx.company.id, date: toDateOnly('2026-03-05'), name: 'Test holiday' } });
    const e = await makeEmployee(ctx.company.id, { hireDate: '2020-01-01' });
    await processDay(ctx.company.id, '2026-03-05');
    expect(await prisma.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: e.employee.id, date: toDateOnly('2026-03-05') } } })).toBeNull();
    const work = await api().put('/api/attendance/records').set(auth(adminToken)).send({ employeeId: e.employee.id, date: '2026-03-05', checkIn: at('2026-03-05', '10:00'), checkOut: at('2026-03-05', '13:00') });
    expect(work.body.overtimeMinutes).toBe(180);
  });

  it('employees only see their own records', async () => {
    const e = await makeEmployee(ctx.company.id);
    const token = await login(e.user.email);
    const res = await api().get('/api/attendance/records').set(auth(token));
    expect(res.status).toBe(200);
    expect(res.body.items.every((r: { employeeId: string }) => r.employeeId === e.employee.id)).toBe(true);
  });
});
