# Contributing to AgentsCircle

Thanks for helping. Bug reports, fixes, support for more agent tools and better docs are all welcome.

## Before you start

- **Bugs:** open an issue with your OS, the AgentsCircle version (Settings → About), which agents were involved, and what you expected. Logs are in Help → Open Logs Folder; remove anything private before attaching them.
- **Features:** open an issue first so we can agree on the approach before you write code.
- **Security problems:** don't open a public issue. Email the maintainers through the contact on agentscircle.dev.

## Working on the code

```bash
npm install
npm run app     # the desktop app
npm start       # or in your browser at http://localhost:4317
```

The app is plain HTML, CSS and JavaScript in `public/` with a Node server in `src/`; there is no build step. Agent command lines live in `tools.json`. Follow the design system in `DESIGN.md` for anything visual.

## Sign your commits (DCO)

Every commit must be signed off under the [Developer Certificate of Origin](https://developercertificate.org/). It certifies that you wrote the change, or have the right to submit it, under this project's license. Add the sign-off with:

```bash
git commit -s -m "Fix the hand-off limit message"
```

which appends a line like `Signed-off-by: Your Name <you@example.com>`.

## License of contributions

By contributing, you agree that your contribution is licensed under the project's license (FSL-1.1-ALv2, see `LICENSE.md`), including its future Apache 2.0 grant, and that ORBITA FOR COMPUTER PROGRAMMING LLC may also distribute your contribution as part of AgentsCircle's commercial editions.
