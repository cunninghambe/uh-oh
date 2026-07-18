// Parse the small subset of the Prometheus /metrics text that get_server_health
// surfaces. Shared by both backends so there is a single parser: HttpBackend
// fetches GET /metrics and parses the text; InProcessBackend renders the
// in-process registry to the same text and parses it the same way.

export interface MetricsSubset {
  eventsIngested: number;
  issuesNew: number;
  webhookFailures: number;
}

/**
 * Sum every sample line for a given metric name, ignoring `# HELP` / `# TYPE`
 * comment lines and any label set (e.g. `{outcome="stored"}`). A counter with
 * no samples yet is simply absent from the text, which reads as 0.
 */
const sumMetric = (text: string, name: string): number => {
  let total = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    // Match `name` or `name{labels...}` followed by whitespace + value.
    if (line === name || line.startsWith(`${name} `) || line.startsWith(`${name}{`)) {
      const value = Number(line.slice(line.lastIndexOf(' ') + 1));
      if (Number.isFinite(value)) total += value;
    }
  }
  return total;
};

export const parseMetricsSubset = (text: string): MetricsSubset => ({
  eventsIngested: sumMetric(text, 'uh_oh_events_ingested_total'),
  issuesNew: sumMetric(text, 'uh_oh_issues_new_total'),
  webhookFailures: sumMetric(text, 'uh_oh_webhook_failures_total'),
});
