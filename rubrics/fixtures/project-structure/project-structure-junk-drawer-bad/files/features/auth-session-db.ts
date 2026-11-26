import { verifyJwt } from './auth-jwt';
export function loadSession(raw: string): boolean { return verifyJwt(raw); }
