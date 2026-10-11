# Security reporting

ARRS 0.1.0 is experimental. Reports against the current source checkout are in scope; include the exact commit and your Node/npm versions.

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/AgentRepoStandards/arrs/security/advisories/new). Include a small reproduction, affected command or contract, expected behavior and potential impact. Remove credentials, private application source and personal data from the report.

Before public launch, repository administrators must enable GitHub private vulnerability reporting and verify that this route is available. Release preparation has not verified or changed that setting. If private reporting is unavailable, withhold sensitive details until the route is enabled. Keep vulnerability details out of public issues and discussions; use [GitHub issues](https://github.com/AgentRepoStandards/arrs/issues) for ordinary bugs.

ARRS runs configured repository commands with the caller's privileges. It does not sandbox commands, certify security or authenticate local review records. Read the [security controls and limitations](docs/security.md) before authorizing execution or sharing evidence.
