/**
 * `GET /api/session` answered 503: `SESSION_SECRET` is unset on this deployment, so sign-in and everything behind it
 * are off (`.env.example`). Distinct from "not signed in", which is a 401, so the connect-time sign-in can stay quiet
 * instead of opening a prompt that cannot succeed.
 */
export class SessionsOffError extends Error {
  constructor() {
    super("sessions are off on this deployment");
    this.name = "SessionsOffError";
  }
}
