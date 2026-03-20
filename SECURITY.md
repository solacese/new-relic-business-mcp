# Security

## Public repo safety

This starter is intended to be safe to publish publicly.

- No customer names are used in code or docs.
- No secrets are committed.
- No real account IDs are committed.
- No internal URLs are committed.
- Mock scenarios use generic system names: `APIM`, `Solace`, `MuleSoft`, `ERP`.

## Secrets and credentials

- Use `.env` locally and keep it out of version control.
- For direct NerdGraph access, use a dedicated `NEW_RELIC_USER_API_KEY`.
- Do not hardcode credentials or account IDs into source, tests, or sample data.

## Least privilege

- Create a dedicated pilot user and user key.
- Limit that user to the minimum New Relic accounts and roles needed.
- Restrict official New Relic MCP access using `NEW_RELIC_INCLUDE_TAGS=discovery,data-access`.
- Prefer a lower-risk environment first.

## RBAC and preview caveat

The official remote New Relic MCP integration is currently a preview offering. Review the current New Relic documentation and your internal security posture before enabling it broadly.

For this starter:

- direct NerdGraph remains the primary live integration path
- official New Relic MCP usage is optional
- the model is intentionally prevented from getting a generic raw-query tool in this public repo

## Customer-specific field mapping

Real environments rarely use the same attribute names. This starter avoids hardcoded internal field names by supporting `BUSINESS_KEY_FIELD_CANDIDATES`.

That means:

- the repo can stay public and generic
- pilot teams can tune their live correlation behavior without changing the public interface

## Operational notes

- The server exposes only read-only investigation tools.
- The mock backend is the default mode, so the repo runs without credentials.
- Review logs and network egress if you enable the live backend in a hosted environment.
