import type Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { ROLE_WORKSPACES, type AppRole } from '../../shared/types';
import { getDemoConfig } from '../db/seed';
import { writeAuditLog } from '../intelligence/contextAndFollowup';

export interface AuthenticatedContext {
  userId: string;
  email: string;
  fullName: string;
  preferredLanguage: string;
  activeRole: AppRole;
  activeOrgId: string | null;
  availableRoles: Array<{ role: AppRole; organizationId: string | null; organizationName: string | null; isDemo: boolean }>;
  isDemoUser: boolean;
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthenticatedContext;
    }
  }
}

export function getTokenFromRequest(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map((c) => c.trim());
    const kp = cookies.find((c) => c.startsWith('khetpatch_session='));
    if (kp) return decodeURIComponent(kp.split('=')[1] || '');
  }
  return null;
}

export function resolveUserWorkspace(
  db: Database.Database,
  authenticatedUserId: string,
  requestedRole?: AppRole,
  requestedOrganizationId?: string | null
): {
  allowed: boolean;
  role: AppRole;
  organizationId: string | null;
  redirectRoute: string;
  availableRoles: Array<{ role: AppRole; organizationId: string | null; organizationName: string | null; isDemo: boolean }>;
  error?: string;
} {
  const rows = db
    .prepare(
      `SELECT ur.role, ur.organization_id, ur.is_demo, o.name as org_name
       FROM user_roles ur
       LEFT JOIN organizations o ON o.id = ur.organization_id
       WHERE ur.user_id = ?`
    )
    .all(authenticatedUserId) as Array<{
    role: AppRole;
    organization_id: string | null;
    is_demo: number;
    org_name: string | null;
  }>;

  const isProd = process.env.APP_ENV === 'production';
  const filtered = rows.filter((r) => !(isProd && r.is_demo === 1));

  const availableRoles = filtered.map((r) => ({
    role: r.role,
    organizationId: r.organization_id,
    organizationName: r.org_name,
    isDemo: Boolean(r.is_demo),
  }));

  if (availableRoles.length === 0) {
    return {
      allowed: false,
      role: 'FARMER',
      organizationId: null,
      redirectRoute: '/login',
      availableRoles: [],
      error: 'No authorized workspace roles assigned to this account.',
    };
  }

  if (requestedRole) {
    const match = availableRoles.find(
      (r) =>
        r.role === requestedRole &&
        (!requestedOrganizationId || r.organizationId === requestedOrganizationId)
    );
    if (!match) {
      return {
        allowed: false,
        role: availableRoles[0].role,
        organizationId: availableRoles[0].organizationId,
        redirectRoute: ROLE_WORKSPACES[availableRoles[0].role],
        availableRoles,
        error: `Account is not authorized for workspace role ${requestedRole}.`,
      };
    }
    return {
      allowed: true,
      role: match.role,
      organizationId: match.organizationId,
      redirectRoute: ROLE_WORKSPACES[match.role],
      availableRoles,
    };
  }

  const defaultRole = availableRoles[0];
  return {
    allowed: true,
    role: defaultRole.role,
    organizationId: defaultRole.organizationId,
    redirectRoute: ROLE_WORKSPACES[defaultRole.role],
    availableRoles,
  };
}

export function createSession(
  db: Database.Database,
  userId: string,
  role: AppRole,
  orgId: string | null
): string {
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  db.prepare(`
    INSERT INTO sessions (token, user_id, active_role, active_org_id, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(token, userId, role, orgId, expires.toISOString(), now.toISOString());
  return token;
}

export function authenticateCredentials(
  db: Database.Database,
  email: string,
  password: string,
  requestedRole?: AppRole
): { ok: true; token: string; auth: AuthenticatedContext; redirectRoute: string } | { ok: false; status: number; error: string } {
  const user = db
    .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
    .get(email.trim()) as Record<string, unknown> | undefined;

  if (!user) {
    return { ok: false, status: 401, error: 'Invalid email or password.' };
  }
  if (String(user.status) !== 'ACTIVE') {
    return { ok: false, status: 403, error: 'Account is suspended. Contact your organization administrator.' };
  }

  const demo = getDemoConfig();
  if (Boolean(user.is_demo) && !demo.enabled) {
    return { ok: false, status: 403, error: 'Demo authentication is disabled in production.' };
  }

  const validPwd = bcrypt.compareSync(password, String(user.password_hash));
  if (!validPwd) {
    return { ok: false, status: 401, error: 'Invalid email or password.' };
  }

  const resolution = resolveUserWorkspace(db, String(user.id), requestedRole);
  if (!resolution.allowed) {
    return { ok: false, status: 403, error: resolution.error || 'Role unauthorized.' };
  }

  const token = createSession(db, String(user.id), resolution.role, resolution.organizationId);
  writeAuditLog(db, String(user.id), resolution.role, 'USER_LOGIN', 'SESSION', token.slice(0, 8), {
    email: user.email,
    activeRole: resolution.role,
  });

  return {
    ok: true,
    token,
    redirectRoute: resolution.redirectRoute,
    auth: {
      userId: String(user.id),
      email: String(user.email),
      fullName: String(user.full_name),
      preferredLanguage: String(user.preferred_language || 'en'),
      activeRole: resolution.role,
      activeOrgId: resolution.organizationId,
      availableRoles: resolution.availableRoles,
      isDemoUser: Boolean(user.is_demo),
    },
  };
}

export function registerFarmerAccount(
  db: Database.Database,
  params: { email: string; password: string; fullName: string; phone?: string; language?: string }
): { ok: true; token: string; auth: AuthenticatedContext; redirectRoute: string } | { ok: false; status: number; error: string } {
  const existing = db
    .prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
    .get(params.email.trim());
  if (existing) {
    return { ok: false, status: 409, error: 'An account with this email already exists.' };
  }

  const userId = crypto.randomUUID();
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(params.password, 10);

  db.transaction(() => {
    db.prepare(`
      INSERT INTO users (id, email, password_hash, full_name, phone, preferred_language, email_verified, status, is_demo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 'ACTIVE', 0, ?, ?)
    `).run(userId, params.email.trim().toLowerCase(), hash, params.fullName.trim(), params.phone || null, params.language || 'en', now, now);

    // Public signup ALWAYS assigns FARMER role only (never elevated roles)
    db.prepare(`
      INSERT INTO user_roles (id, user_id, role, organization_id, is_demo, granted_by, created_at)
      VALUES (?, ?, 'FARMER', NULL, 0, 'PUBLIC_SIGNUP', ?)
    `).run(crypto.randomUUID(), userId, now);
  })();

  writeAuditLog(db, userId, 'FARMER', 'PUBLIC_SIGNUP', 'USER', userId, { email: params.email.trim() });

  const resolution = resolveUserWorkspace(db, userId, 'FARMER');
  const token = createSession(db, userId, 'FARMER', null);

  return {
    ok: true,
    token,
    redirectRoute: resolution.redirectRoute,
    auth: {
      userId,
      email: params.email.trim().toLowerCase(),
      fullName: params.fullName.trim(),
      preferredLanguage: params.language || 'en',
      activeRole: 'FARMER',
      activeOrgId: null,
      availableRoles: resolution.availableRoles,
      isDemoUser: false,
    },
  };
}

export function authenticateOrProvisionFirebaseUser(
  db: Database.Database,
  params: { email: string; fullName: string; requestedRole?: AppRole }
): { ok: true; token: string; auth: AuthenticatedContext; redirectRoute: string } | { ok: false; status: number; error: string } {
  const cleanEmail = params.email.trim().toLowerCase();
  const now = new Date().toISOString();

  let user = db
    .prepare('SELECT * FROM users WHERE LOWER(email) = LOWER(?)')
    .get(cleanEmail) as Record<string, unknown> | undefined;

  if (!user) {
    const userId = crypto.randomUUID();
    const randomPwdHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);
    const displayName = (params.fullName || cleanEmail.split('@')[0] || 'KhetPatch Farmer').trim();

    db.transaction(() => {
      db.prepare(`
        INSERT INTO users (id, email, password_hash, full_name, phone, preferred_language, email_verified, status, is_demo, created_at, updated_at)
        VALUES (?, ?, ?, ?, NULL, 'en', 1, 'ACTIVE', 0, ?, ?)
      `).run(userId, cleanEmail, randomPwdHash, displayName, now, now);

      db.prepare(`
        INSERT INTO user_roles (id, user_id, role, organization_id, is_demo, granted_by, created_at)
        VALUES (?, ?, 'FARMER', NULL, 0, 'FIREBASE_GOOGLE_AUTH', ?)
      `).run(crypto.randomUUID(), userId, now);
    })();

    user = db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as Record<string, unknown>;
  }

  if (String(user.status) !== 'ACTIVE') {
    return { ok: false, status: 403, error: 'Account is suspended. Contact your organization administrator.' };
  }

  const demo = getDemoConfig();
  if (Boolean(user.is_demo) && !demo.enabled) {
    return { ok: false, status: 403, error: 'Demo authentication is disabled in production.' };
  }

  const resolution = resolveUserWorkspace(db, String(user.id), params.requestedRole);
  if (!resolution.allowed) {
    return { ok: false, status: 403, error: resolution.error || 'Role unauthorized.' };
  }

  const token = createSession(db, String(user.id), resolution.role, resolution.organizationId);
  writeAuditLog(db, String(user.id), resolution.role, 'FIREBASE_USER_LOGIN', 'SESSION', token.slice(0, 8), {
    email: user.email,
    activeRole: resolution.role,
  });

  return {
    ok: true,
    token,
    redirectRoute: resolution.redirectRoute,
    auth: {
      userId: String(user.id),
      email: String(user.email),
      fullName: String(user.full_name),
      preferredLanguage: String(user.preferred_language || 'en'),
      activeRole: resolution.role,
      activeOrgId: resolution.organizationId,
      availableRoles: resolution.availableRoles,
      isDemoUser: Boolean(user.is_demo),
    },
  };
}

export function resolveSessionFromRequest(
  db: Database.Database,
  req: Request
): { ok: true; auth: AuthenticatedContext } | { ok: false; status: number; error: string } {
  const token = getTokenFromRequest(req);
  if (!token) {
    return { ok: false, status: 401, error: 'Authentication required.' };
  }

  const row = db
    .prepare(
      `SELECT s.user_id, s.active_role, s.active_org_id, s.expires_at,
              u.email, u.full_name, u.preferred_language, u.status, u.is_demo
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ?`
    )
    .get(token) as Record<string, unknown> | undefined;

  if (!row || new Date(String(row.expires_at)).getTime() < Date.now()) {
    return { ok: false, status: 401, error: 'Session expired or invalid.' };
  }
  if (String(row.status) !== 'ACTIVE') {
    return { ok: false, status: 403, error: 'Account suspended.' };
  }

  const resolution = resolveUserWorkspace(
    db,
    String(row.user_id),
    row.active_role as AppRole,
    row.active_org_id ? String(row.active_org_id) : null
  );
  if (!resolution.allowed) {
    return { ok: false, status: 403, error: 'Workspace role no longer authorized.' };
  }

  return {
    ok: true,
    auth: {
      userId: String(row.user_id),
      email: String(row.email),
      fullName: String(row.full_name),
      preferredLanguage: String(row.preferred_language || 'en'),
      activeRole: resolution.role,
      activeOrgId: resolution.organizationId,
      availableRoles: resolution.availableRoles,
      isDemoUser: Boolean(row.is_demo),
    },
  };
}

export function createAuthMiddleware(db: Database.Database) {
  return function requireAuth(req: Request, res: Response, next: NextFunction) {
    const resolved = resolveSessionFromRequest(db, req);
    if (!resolved.ok) {
      res.status(resolved.status).json({ error: resolved.error });
      return;
    }
    req.auth = resolved.auth;
    next();
  };
}

export function requireRole(...allowedRoles: AppRole[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required.' });
      return;
    }
    if (!allowedRoles.includes(req.auth.activeRole)) {
      res.status(403).json({
        error: `Forbidden: requires role ${allowedRoles.join(' or ')}, active role is ${req.auth.activeRole}.`,
      });
      return;
    }
    next();
  };
}

export function canAccessFarm(db: Database.Database, auth: AuthenticatedContext, farmId: string): boolean {
  const farm = db.prepare('SELECT owner_user_id, organization_id FROM farms WHERE id = ?').get(farmId) as
    | { owner_user_id: string; organization_id: string | null }
    | undefined;
  if (!farm) return false;

  if (farm.owner_user_id === auth.userId) return true;
  if (
    (auth.activeRole === 'AGRONOMIST' ||
      auth.activeRole === 'FPO_MANAGER' ||
      auth.activeRole === 'ORGANIZATION_ADMIN') &&
    auth.activeOrgId &&
    farm.organization_id === auth.activeOrgId
  ) {
    return true;
  }
  // PLATFORM_ADMIN does NOT get unrestricted individual farmer record access unless they explicitly own it
  return false;
}

export function createPasswordResetToken(
  db: Database.Database,
  email: string
): { ok: true; resetToken: string | null; isDemo: boolean; message: string } {
  const user = db
    .prepare('SELECT id, email, is_demo FROM users WHERE LOWER(email) = LOWER(?)')
    .get(email.trim()) as { id: string; email: string; is_demo: number } | undefined;

  if (!user) {
    return {
      ok: true,
      resetToken: null,
      isDemo: false,
      message: 'If an account matches that email, a password reset instruction has been issued.',
    };
  }

  if (user.is_demo === 1) {
    return {
      ok: true,
      resetToken: null,
      isDemo: true,
      message: 'Shared demo credentials cannot be overwritten via self-service reset.',
    };
  }

  const token = crypto.randomBytes(16).toString('hex');
  const now = new Date();
  const expires = new Date(now.getTime() + 30 * 60 * 1000);

  db.prepare(`
    INSERT INTO password_resets (id, user_id, token, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(crypto.randomUUID(), user.id, token, expires.toISOString(), now.toISOString());

  writeAuditLog(db, user.id, 'FARMER', 'PASSWORD_RESET_REQUESTED', 'USER', user.id);

  // Return token in non-production / preview mode so local/offline users without SMTP can complete reset cleanly
  const exposePreviewToken = process.env.APP_ENV !== 'production';
  return {
    ok: true,
    resetToken: exposePreviewToken ? token : null,
    isDemo: false,
    message: exposePreviewToken
      ? 'Local development reset token generated (no outbound SMTP configured). Enter the token below to set a new password.'
      : 'If an account matches that email, password reset instructions have been dispatched.',
  };
}

export function completePasswordReset(
  db: Database.Database,
  token: string,
  newPassword: string
): { ok: true } | { ok: false; status: number; error: string } {
  const row = db
    .prepare(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.is_demo
       FROM password_resets pr
       JOIN users u ON u.id = pr.user_id
       WHERE pr.token = ?`
    )
    .get(token.trim()) as
    | { id: string; user_id: string; expires_at: string; used_at: string | null; is_demo: number }
    | undefined;

  if (!row || row.used_at) {
    return { ok: false, status: 400, error: 'Invalid or already used password reset token.' };
  }
  if (new Date(row.expires_at).getTime() < Date.now()) {
    return { ok: false, status: 400, error: 'Password reset token has expired.' };
  }
  if (row.is_demo === 1) {
    return { ok: false, status: 403, error: 'Demo identity password cannot be altered.' };
  }

  const hash = bcrypt.hashSync(newPassword, 10);
  const now = new Date().toISOString();

  db.transaction(() => {
    db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, now, row.user_id);
    db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?').run(now, row.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  })();

  writeAuditLog(db, row.user_id, 'FARMER', 'PASSWORD_RESET_COMPLETED', 'USER', row.user_id);
  return { ok: true };
}

