# Project rules

- Follow the always-applicable Redis requirements in
  [.cursor/rules/redis-security.mdc](.cursor/rules/redis-security.mdc).
- Redis must remain private in every region. Do not introduce public endpoints,
  published Redis ports, or changes that bypass authorization/quota enforcement.
- Track portable `*.example.*` deployment configuration only. Preserve ignored
  local configuration and secrets; never commit credentials or private evidence.
- Keep README.md and the standalone docs/readme.html synchronized using
  `python3 scripts/render-readme.py` when documentation changes.
