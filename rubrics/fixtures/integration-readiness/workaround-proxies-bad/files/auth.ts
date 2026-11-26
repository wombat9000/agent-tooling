export interface VerifiedSession {
  readonly userId: string;
  readonly accessToken: string;
}

export interface SessionVerifier {
  verifyCookie(cookieHeader: string | null): Promise<VerifiedSession | null>;
}
