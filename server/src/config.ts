/**
 * Deployment mode.
 * Default: single business (Hotel Rio Lindo) — public sign-up is closed once the hotel exists and there is no
 * platform super admin. Set MULTI_TENANT=true to run as a multi-business SaaS again.
 */
export const MULTI_TENANT = process.env.MULTI_TENANT === 'true';
export const APP_NAME = process.env.APP_NAME || 'Hotel Rio Lindo POS';
