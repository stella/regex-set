# Security Policy

## Supported Versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | Yes       |

## Reporting a Vulnerability

If you discover a security vulnerability in this
package, please report it responsibly.

**Do not open a public GitHub issue.**

Instead, email **security@stll.app** with:

1. A description of the vulnerability.
2. Steps to reproduce.
3. The affected version(s).
4. Any potential impact assessment.

We will acknowledge your report within 48 hours and
aim to provide a fix or mitigation within 7 days
for critical issues.

## Scope

This package is a native addon (NAPI-RS) wrapping
the Rust `regex-set` crate. Security concerns
may include:

- Memory safety issues in the Rust/NAPI boundary.
- Denial of service via crafted input patterns.
- Incorrect boundary handling leading to out-of-
  bounds reads.

The underlying Rust crate is maintained by
[BurntSushi](https://github.com/BurntSushi) and
has its own security track record. Issues in the
upstream crate should be reported to the upstream
maintainer directly.
