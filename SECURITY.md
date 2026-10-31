# Security policy

Kestrel's job includes keeping apps inside their permissions, so we take reports
seriously: a way for a page or `native.ts` to reach files, commands or IPC that its
`kestrel.json` doesn't grant is a vulnerability, and so is a way to tamper with an update.

## Reporting a vulnerability

Please **don't open a public issue.** Report it privately through GitHub instead:
[**Report a vulnerability**](https://github.com/richlaconte/kestrel/security/advisories/new)
on the repository's Security tab.

Include what you can of:

- what an attacker can do, and what they need first (a malicious page, a crafted file, a
  network position)
- steps or a small app that reproduces it
- the Kestrel version or commit, and the OS

We'll acknowledge the report within a week, keep you posted while we fix it, and credit
you in the advisory unless you'd rather we didn't.

## Supported versions

Kestrel is pre-alpha. Fixes go into the latest release only.

## In scope

- The host (`host/`): permission checks, path scoping, the `kestrel://` protocol, IPC
  origin checks, navigation limits, the updater's signature checks
- The CLI's packaging and signing (`packages/kestrel/`)
- The std-lib client (`packages/kestrel-native/`)

Bugs in Tauri, WebKit or WebView2 belong upstream, but tell us if Kestrel's defaults make
one easier to exploit.
