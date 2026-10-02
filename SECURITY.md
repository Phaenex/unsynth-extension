# Security policy

## Reporting a vulnerability

Do not open a public issue with credentials, tokens, personal watch data, or a working exploit. Report it privately through GitHub's private vulnerability reporting: https://github.com/Phaenex/unsynth-extension/security/advisories/new and include:

- the affected Unsynth version;
- the browser and operating system;
- the smallest reproducible example;
- the impact you observed;
- whether any secret or personal data may have been exposed.

The maintainer will confirm receipt, reproduce the issue, and coordinate a fix before public disclosure.

## Sensitive local data

Unsynth can store OAuth credentials and tokens, AI provider keys, an optional GitHub token, watch history, and settings in Chrome extension storage. Exported backups and profiles should be treated as personal files. Profiles intentionally exclude secrets.

Never commit or share:

- OAuth client secrets or tokens;
- AI provider keys;
- GitHub personal access tokens;
- `tools/extension-key.pem`;
- Google Takeout data;
- Unsynth backups or browser profiles.

The `key` value in `manifest.json` is the public half of the extension signing key. It keeps the extension ID stable and is not a credential.

## Supported versions

Security fixes target the current version. Because Unsynth is sideloaded, users must download the updated folder, reload the extension, and reload open YouTube tabs.
