/**
 * Interactive (operator-driven) authentication for banks that require an SMS
 * one-time code at login.
 *
 * The scheduled scraper NEVER submits credentials on its own — doing so would
 * trigger an SMS on every cycle and get rate-limited/blocked. Instead, the
 * automated `login()` reuses a persisted session and, if it is gone, throws
 * {@link ReauthRequiredError}. A human then drives a two-step flow from the
 * settings UI:
 *   1. start()      → fills credentials, submits, bank sends SMS, page is held
 *                     open in an `awaiting_sms` state.
 *   2. submitCode() → enters the SMS code, completes login, persists the session.
 */

/** Thrown by automated login when the saved session is gone and only an
 *  operator-driven SMS login can restore access. Must NOT be treated as a
 *  transient/retryable error (otherwise the scheduler re-triggers SMS). */
export class ReauthRequiredError extends Error {
  readonly bankId: string;
  constructor(bankId: string, message?: string) {
    super(message ?? `${bankId} requires re-authentication (SMS) — open Settings and log in`);
    this.name = 'ReauthRequiredError';
    this.bankId = bankId;
  }
}

export function isReauthRequired(err: unknown): boolean {
  return err instanceof ReauthRequiredError || (err as Error)?.name === 'ReauthRequiredError';
}

export type AuthStage = 'idle' | 'awaiting_sms' | 'logged_in';

export interface AuthStartResult {
  /** 'logged_in' when the saved session was still valid or no SMS was needed. */
  stage: 'awaiting_sms' | 'logged_in';
  message?: string;
}

export interface InteractiveAuthProvider {
  /** Begin login: fill credentials, submit, and either land on the dashboard
   *  (logged_in) or reach the SMS prompt (awaiting_sms). */
  start(): Promise<AuthStartResult>;
  /** Submit the SMS code entered by the operator; completes and persists login. */
  submitCode(code: string): Promise<void>;
  /** Current stage of the interactive flow. */
  status(): AuthStage;
  /** Abort a pending flow and release the held page. */
  cancel(): Promise<void>;
}

const providers = new Map<string, InteractiveAuthProvider>();

export function registerInteractiveAuth(bankId: string, provider: InteractiveAuthProvider): void {
  providers.set(bankId, provider);
}

export function getInteractiveAuth(bankId: string): InteractiveAuthProvider | undefined {
  return providers.get(bankId);
}

export function interactiveAuthBanks(): string[] {
  return [...providers.keys()];
}
