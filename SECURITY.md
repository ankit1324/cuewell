# Security policy

## Reporting a vulnerability

Please report security problems privately. Do not open a public issue, pull request or discussion for them.

Use GitHub's private vulnerability reporting: open [Report a vulnerability](https://github.com/ankit1324/cuewell/security/advisories/new), or choose **Report a vulnerability** on the repository's Security tab. Only you and the maintainer can see the report.

Include:

- A description of the problem and its impact.
- Steps to reproduce, or a proof of concept.
- The version or commit, your operating system, and the AI and speech providers you use, if relevant.

Never include real API keys, `.env` files, resumes or other personal data in a report.

## What to expect

The maintainer, Ankit Chaudhary, will acknowledge your report, investigate it, and keep you updated until a fix is released. Please give a reasonable amount of time for a fix before you disclose the issue publicly.

## Scope

In scope: this repository's code, including the Electron main process, preload scripts, renderer pages, `setup.sh` and the build configuration.

Out of scope: the AI and speech providers themselves (Google, Anthropic, OpenAI, OpenRouter, Groq, DeepSeek, Ollama, Microsoft Azure), and the upstream [OpenCluely](https://github.com/TechyCSR/OpenCluely) project. Report problems there to their owners.

## Supported versions

Only the latest code on the default branch receives security fixes.
