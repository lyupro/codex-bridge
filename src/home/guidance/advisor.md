# advisor

Use a scope pass and a granted advise pass under one order id to obtain an evidence-backed design recommendation.

## Two phases, one order

Start with `phase: scope`. This read-only pass checks whether the supplied paths cover the question and names missing paths and expected risks.

Continue with `phase: advise` under the same order id. Its task-file header must contain a `continue:` grant naming the successful scope run by its bare run-folder name (the last segment of the `RUN=`/`ATTACH=` path, never a path), with a reason for proceeding: `continue: <run folder> — <reason>`. The grant authorizes the second phase; a successful scope result alone does not grant it.

`OK — scope: sufficient` means the supplied context covers the question. `OK — scope: insufficient; N paths named` with a `Missing:` line is also success: it identifies the context advise needs. It is not FAIL or LIMIT. The advise boundary includes the original paths and that scope result's `missing_paths`.

Never continue a successful scope as another scope: that would consume the continuation intended for advise. A failed scope or advise pass is repeated only with a `retry:` grant naming that failed run, under the same order id. A changed question needs a new scope pass.

## Task-file bodies

Both phases use the following body form after the lowercase header and a blank line:

```markdown
## Question
Which boundary should own the validation contract?

## Options
- local-boundary: Keep validation within the owning component.
- shared-contract: Share validation between the consuming components.

## Paths
- src/component.mjs
- tests/component.test.mjs
```

`## Question` contains the design question. `## Options` contains at least two unique option ids matching `[a-z0-9][a-z0-9-]*`, each on a `- <option_id>: <description>` line. Keep options neutral: no preference markers or wording such as `recommend`, `prefer`, `рекоменд`, `предпочт`, `(✓)` or `★`. Biased or malformed options are refused before quota is spent.

`## Paths` contains at least one repository-relative path, one per list line. In scope, these are the read boundary. In advise, the successful scope run's `missing_paths` are also available. Citations must be real `path:line` addresses within that boundary; invented or out-of-list addresses fail validation.

For the scope task, declare the scope phase in the header and supply this question, neutral options and initial paths. For the advise task, declare the advise phase and the continuation grant in the header, preserving the question and options and incorporating the scope findings.

## Use the answer

An advise answer recommends one option id and explains the choice, rejects alternatives with their costs, gives the strongest counterargument and a pre-mortem of risks. Its short form begins `OK — recommend <option_id>: …` and includes `Rejected:`, `Counter:` and `Risks:`. The full structured result and report stay in the run folder.

To cite it in a build task, use exactly one `advice:` line whose value is the absolute folder of the successful advise run. Its `meta.json` must identify `codex-advisor`, phase advise, status OK. A scope folder, report filename, failed advise or recommendation text is not a valid advice reference.
