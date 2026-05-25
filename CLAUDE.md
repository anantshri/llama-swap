@AGENTS.md

## Security scanning

- Run `make gosec` after every code change. CI rejects new findings; catching them locally is faster than waiting on the workflow.

## Documentation

- Update `README.md` whenever a new feature is added (especially anything user-visible, like new endpoints or behavior changes in the fork-specific section).
