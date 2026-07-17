# Map · street sign · barrier — the Signposts mental model

The three instruments Signposts gives a project, and the discipline that keeps each one honest.
This is the model behind `/signposts setup` and behind every authoring decision.

| Instrument | Signpost | When it reaches the agent | Carries |
| --- | --- | --- | --- |
| **The map** | a session sign (`at: [session]`) | once, at session start | what you need before touching *any* file: identity, the folder map with globs, the shape of work, pointers to deeper truth |
| **A street sign** | a touch sign (`at: [touch]`, `on: <glob>`) | when a matching file is touched | area-specific guidance — shape, judgement, a constraint no check can make |
| **A barrier** | a rule (`use:` + a script) | at write / commit / command, blocking | a mechanically checkable mistake, stopped before it lands |

## The sorting discipline

Everything a project would once have written into a fat CLAUDE.md sorts into exactly one of
the three (or into the justfile, or the bin):

- Needed before any file is touched → the **map**. One session sign per project; short.
- Only relevant in one area → a **street sign** behind an `on:` glob. Don't spend map space on it.
- Mechanically checkable → a **barrier**. A sign for something a check could catch is hope,
  not enforcement.
- A command → a justfile recipe, and the map's toolbox pointer covers all of them at once.
- Stale, derivable from the code, or restating an enforced rule → delete. **Never restate a
  barrier on a sign** — omit it entirely.

Two corollaries:

1. **The map is a map, not the territory.** It points (globs, doc paths); it never restates
   what the pointed-at thing says. Its Shape section shrinks over time as barriers take over
   enforcing what it used to describe.
2. **CLAUDE.md becomes a stub.** After a proper decomposition, CLAUDE.md holds only a pointer
   to Signposts plus whatever no signpost can carry. If a fat CLAUDE.md survives setup, the
   decomposition failed.

## Why three instruments

One channel can't do the job. Everything-at-session-start is the CLAUDE.md failure mode: the
agent reads it once, drifts, and the guidance is stale context by the time it matters. A
street sign arrives *at the moment of relevance* — when the file is in hand. A barrier removes
the guidance burden entirely: the mistake simply cannot land. The map exists only for what the
other two can't time or check — who the project is, and where things live.
