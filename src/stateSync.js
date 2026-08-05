// -----------------------------------------------------------------------------
// Outbound state queue.
//
// Publishing straight from the gateway's change stream would break against
// Gladys's own limits: externalIntegration.saveStates.js rejects more than 100
// states per request, and more than 300 states per minute per integration
// (TooManyRequests). One connector can produce 6 states per observed message,
// so a chatty charge point saturates that budget on its own.
//
// So every state goes through this queue, which:
//   - coalesces by feature (a value superseded before it was ever sent is
//     simply dropped),
//   - skips values equal to the last one published for that feature,
//   - spends a 300/minute budget mirroring the core's own fixed window,
//   - sends at most 100 states per call.
//
// Nothing is lost when the budget runs out: the queue holds and drains itself
// as the window resets.
// -----------------------------------------------------------------------------

export const MAX_STATES_PER_REQUEST = 100;
export const MAX_STATES_PER_MINUTE = 300;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Backoff after a publish failure that isn't a rate limit (gateway/core hiccup). */
const RETRY_DELAY_MS = 5_000;

function valueOf(state) {
  return state.text === undefined ? state.state : state.text;
}

function isRateLimit(err) {
  const status = err?.status ?? err?.statusCode;
  return status === 429 || /rate.?limit|too many requests/i.test(err?.message ?? '');
}

/**
 * @param {{publishStates: (states: Array<object>) => Promise<unknown>, logger?: object,
 *   maxPerRequest?: number, maxPerMinute?: number, now?: () => number}} options
 */
export function createStatePublisher({
  publishStates,
  logger,
  maxPerRequest = MAX_STATES_PER_REQUEST,
  maxPerMinute = MAX_STATES_PER_MINUTE,
  now = () => Date.now(),
}) {
  /** feature external_id -> pending state (last value wins). */
  const pending = new Map();
  /** feature external_id -> last value actually published. */
  const published = new Map();
  let window = { count: 0, resetAt: 0 };
  let pausedUntil = 0;
  let flushing = false;
  let resumeTimer = null;
  let stopped = false;

  function budget() {
    if (now() >= window.resetAt) {
      window = { count: 0, resetAt: now() + RATE_LIMIT_WINDOW_MS };
    }
    return maxPerMinute - window.count;
  }

  function scheduleResume(delayMs) {
    if (stopped || resumeTimer) return;
    resumeTimer = setTimeout(
      () => {
        resumeTimer = null;
        flush().catch((err) => logger?.error?.('State queue flush crashed', err));
      },
      Math.max(delayMs, 0),
    );
    resumeTimer.unref?.();
  }

  async function flush() {
    if (flushing || stopped) return;
    flushing = true;
    try {
      while (pending.size > 0) {
        const wait = pausedUntil - now();
        if (wait > 0) {
          scheduleResume(wait);
          return;
        }
        const room = Math.min(maxPerRequest, budget());
        if (room <= 0) {
          scheduleResume(window.resetAt - now());
          return;
        }

        const chunk = [];
        for (const [featureId, state] of pending) {
          if (chunk.length >= room) break;
          chunk.push(state);
          pending.delete(featureId);
        }

        try {
          await publishStates(chunk);
          window.count += chunk.length;
          for (const state of chunk) {
            published.set(state.device_feature_external_id, valueOf(state));
          }
        } catch (err) {
          // Put back only what hasn't been superseded meanwhile.
          for (const state of chunk) {
            if (!pending.has(state.device_feature_external_id)) {
              pending.set(state.device_feature_external_id, state);
            }
          }
          const rateLimited = isRateLimit(err);
          pausedUntil = now() + (rateLimited ? RATE_LIMIT_WINDOW_MS : RETRY_DELAY_MS);
          logger?.warn?.(
            rateLimited
              ? 'State publication rate limited, holding the queue for a minute'
              : 'State publication failed, retrying shortly',
            err,
          );
          scheduleResume(pausedUntil - now());
          return;
        }
      }
    } finally {
      flushing = false;
    }
  }

  return {
    /**
     * Queues states for publication, dropping those that would republish a
     * value Gladys already has.
     * @param {Array<{device_feature_external_id: string, state?: number, text?: string}>} states
     */
    enqueue(states) {
      if (stopped) return;
      for (const state of states) {
        const featureId = state.device_feature_external_id;
        if (!pending.has(featureId) && published.get(featureId) === valueOf(state)) {
          continue;
        }
        pending.set(featureId, state);
      }
      if (pending.size > 0) {
        flush().catch((err) => logger?.error?.('State queue flush crashed', err));
      }
    },

    stop() {
      stopped = true;
      if (resumeTimer) {
        clearTimeout(resumeTimer);
        resumeTimer = null;
      }
      pending.clear();
    },

    /** Test/diagnostics only. */
    get pendingCount() {
      return pending.size;
    },
  };
}
