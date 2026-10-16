import { createRequire } from 'node:module';
import { fixture, form, PASSWORD, PERSON, UNAVAILABLE, USER } from './uat-effects-fixtures.mjs';

const require = createRequire(import.meta.url);
const f = fixture();
const result = {};
try {
  const account = await f.load('src/app/accounts/actions.ts');
  for (const name of ['createPortalAccount', 'updatePortalLogin', 'resetPortalPassword', 'togglePortalAccount']) {
    result[name] = await account[name]({ personId: PERSON, userId: USER, loginName: 'synthetic@example.invalid', newPassword: PASSWORD, accountVersion: 1, enabled: false });
  }
  const directory = await f.load('src/app/people/actions.ts');
  for (const name of ['createEmployeeDirectoryRecord', 'updateEmployeeDirectoryRecord', 'updateEmployeeDirectoryRole', 'archiveEmployeeDirectoryRecord', 'deleteEmployeeDirectoryRecord']) {
    result[name] = await directory[name]({ personId: PERSON, personVersion: 1, detailVersion: 1, role: 'manager', expectedRole: 'employee', endDate: '2026-10-01', reason: 'Resigned' });
  }
  const recovery = await f.load('src/app/login/forgot-password/actions.ts');
  result.requestPasswordRecovery = await recovery.requestPasswordRecovery({}, form({ email: 'synthetic@example.invalid' }));
  result.resetRecoveredPassword = await recovery.resetRecoveredPassword({}, form({ token: 'A'.repeat(43), password: PASSWORD, confirmPassword: PASSWORD }));
  f.assertZero('production Flight UAT mutations');
  if (Object.values(result).some(value => value.error !== UNAVAILABLE && value.message !== UNAVAILABLE && value.message !== 'Password reset is unavailable. Try again later.')) throw new Error('Unexpected typed rejection');
} finally { f.cleanup(); }
const { renderToPipeableStream } = require('next/dist/compiled/react-server-dom-webpack/server.node');
renderToPipeableStream(result, {}, { onError: () => { process.exitCode = 1; return 'synthetic-flight-error'; } }).pipe(process.stdout);
