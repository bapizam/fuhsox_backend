import { Role } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      /** Authenticated user info (set by authenticate middleware) */
      user: {
        id: string;
        role: Role;
        institution_id: string;
        email: string;
      };
      /** Institution ID resolved from auth token or email domain (set by scopeToInstitution) */
      institutionId: string;
    }
  }
}

export {};
