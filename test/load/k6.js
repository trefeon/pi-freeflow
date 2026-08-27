// k6 load test — local proxy /_health endpoint
//
// Simulates 20 concurrent clients hammering the loopback health endpoint
// for 30 seconds. Fails the run if:
//   - p95 request duration >= 200ms, or
//   - more than 1% of requests fail (non-200 / connection errors).
//
// Run with: k6 run test/load/k6.js
// Requires the proxy to be running on http://localhost:28180 (default port).

import http from "k6/http";

export const options = {
	vus: 20,
	duration: "30s",
	thresholds: {
		// 95th percentile of request duration must stay under 200ms
		http_req_duration: ["p(95)<200"],
		// failure rate (non-200 responses + connection errors) must stay under 1%
		http_req_failed: ["rate<0.01"],
	},
};

export default function () {
	http.get("http://localhost:28180/_health");
}
