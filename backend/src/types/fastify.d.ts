import type { FastifyReply, FastifyRequest } from 'fastify';
import type { UserRole } from './api.js';

export interface AuthContext {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  department: string | null;
  timezone: string;
  hourlyRate: number;
  currency: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Bearer JWT veya x-agent-key dogrular. */
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    /** authenticate + rol kontrolu. */
    requireRole: (
      ...roles: UserRole[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }

  interface FastifyRequest {
    authUser: AuthContext | null;
    /** Agent API anahtari ile dogrulandiysa true. */
    authenticatedByAgentKey?: boolean;
  }
}
