# Service Topology

**Parent**: [Effect 4 Deep Adoption](map.md)
**Label**: `wayfinder:grilling`

## Question

What is the service topology for the Effect 4 rewrite?

- Which services exist? Candidates: `PlaneService`, `SentryService`, `AutotaskService`, `GitHubService`, `ConfigService`, `TimeEntryStore`, `FileSystem`
- How are they identified in the Effect `Context`? (individual `Tag`s, a single `ServiceRegistry` record, or grouped by domain?)
- Which services depend on which others? (e.g. does `PlaneService` depend on `ConfigService` + `FileSystem`, or does it take its config pre-resolved?)
- What's the `Layer` composition order? Which services are provided at the top level vs. scoped per-command?
- Does the overlay get its own scoped context, or does it share the top-level runtime?
