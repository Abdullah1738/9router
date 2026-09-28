// Quota-aware account routing for Claude subscription (OAuth) accounts.
// Selection prefers the account whose weekly quota would otherwise go unused
// first, keeps conversations on one account for prompt-cache reuse, and locks
// exhausted accounts until their real 5h/7d reset.

export const QUOTA_AWARE_STRATEGY = "quota-aware";

export const CLAUDE_QUOTA_ROUTING = {
  // Accounts at or above this 5h utilization (0-1) take no new conversations,
  // and existing ones move off them when another account still has room.
  newSession5hMax: 0.95,

  // Sticky session idle TTL. Claude requests are sent with 1h cache_control,
  // so an idle conversation keeps a warm cache for about an hour.
  stickyIdleTtlMs: 60 * 60 * 1000,
  stickyMaxEntries: 5000,

  // Floor for hours-until-weekly-reset in the score, so an account a few
  // minutes from reset does not get an absurd score.
  minHoursToWeeklyReset: 0.25,

  // An account with no quota data yet gets one new conversation to learn its
  // state from response headers, at most once per this interval.
  exploreIntervalMs: 10 * 60 * 1000,

  // Usage endpoint polling. The interval shrinks to the time left before the
  // next known reset (never below minPollIntervalMs), and a poll is scheduled
  // right after each reset so a freed account is picked up quickly.
  maxPollIntervalMs: 15 * 60 * 1000,
  minPollIntervalMs: 60 * 1000,
  postResetPollDelayMs: 20 * 1000,
  pollTickMs: 20 * 1000,
  firstPollDelayMs: 5 * 1000,
  pollTimeoutMs: 20 * 1000,
  // Skip polling an account whose access token expires within this window;
  // token refresh belongs to the request path and background refresh.
  tokenExpirySkipMs: 2 * 60 * 1000,
};
