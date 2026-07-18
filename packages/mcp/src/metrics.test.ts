import { describe, expect, it } from 'vitest';

import { parseMetricsSubset } from './metrics.js';

const SAMPLE = `# HELP uh_oh_events_ingested_total Total events accepted (stored or rate-limited)
# TYPE uh_oh_events_ingested_total counter
uh_oh_events_ingested_total{outcome="stored"} 40
uh_oh_events_ingested_total{outcome="rate-limited"} 2
# HELP uh_oh_issues_new_total Total NEW issues created
# TYPE uh_oh_issues_new_total counter
uh_oh_issues_new_total 7
# HELP uh_oh_webhook_failures_total Total webhook attempts that failed permanently
# TYPE uh_oh_webhook_failures_total counter
uh_oh_webhook_failures_total 1
# HELP uh_oh_request_duration_seconds HTTP request duration
# TYPE uh_oh_request_duration_seconds histogram
uh_oh_request_duration_seconds_bucket{route="/mcp",status_code="200",le="0.1"} 3
uh_oh_request_duration_seconds_sum{route="/mcp",status_code="200"} 0.2
`;

describe('parseMetricsSubset', () => {
  it('sums labelled event samples and reads the counters', () => {
    expect(parseMetricsSubset(SAMPLE)).toEqual({
      eventsIngested: 42, // 40 stored + 2 rate-limited
      issuesNew: 7,
      webhookFailures: 1,
    });
  });

  it('does not confuse a histogram bucket sharing a metric prefix', () => {
    // uh_oh_request_duration_seconds_bucket must not be summed into anything here.
    const { eventsIngested, issuesNew, webhookFailures } = parseMetricsSubset(SAMPLE);
    expect(eventsIngested + issuesNew + webhookFailures).toBe(50);
  });

  it('treats an absent counter as zero', () => {
    expect(parseMetricsSubset('')).toEqual({
      eventsIngested: 0,
      issuesNew: 0,
      webhookFailures: 0,
    });
  });
});
