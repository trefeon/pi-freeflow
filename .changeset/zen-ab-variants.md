---
"pi-freeflow": patch
---

Record opt-in OpenCode Zen free-tier request variants for A/B testing once upstream quota recovers, with no change to the default request. A newer four-part client identifier, alternate project header values (fixed, global, or working-directory digest), and the alternate usage-marked request lane are now available as selectable variants for controlled one-variable comparisons. Default traffic is byte-identical: same User-Agent, project value, lane, tool set, and exactly-one environment block as before.
