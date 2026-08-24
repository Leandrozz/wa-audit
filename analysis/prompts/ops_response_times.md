# Operativa y tiempos de respuesta

Analyze the operational discipline of the channel: who answers, when, how fast,
and what falls through the cracks. The deterministic stats block already gives
you exact medians and counts — DO NOT recompute or contradict them; interpret
them.

Look for:
- The shape of response times: is the median driven by a fast core plus a slow
  tail? Are there threads answered in minutes next to threads answered days
  later?
- Unanswered threads: how many, and do they cluster (time of day, day of week,
  type of request)?
- Hours of operation as revealed by the data: when do clients write vs when
  does the business reply?
- Burst behavior: clients who send many messages before any reply, and what
  that does to the measured times (the metric anchors at the FIRST message of
  each inbound burst).

Suggested row columns: aspect, observation, supporting numbers (from the stats
block), operational recommendation.
