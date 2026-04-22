# Contributing to PM Copilot Agent

## How to Contribute

### Reporting Bugs

1. Check if the bug has already been reported in [Issues](https://github.com/AIMatrix/pm-copilot-agent/issues)
2. If not, create a new issue with:
   - Clear, descriptive title
   - Steps to reproduce
   - Expected vs actual behavior
   - System information (OS version)

### Pull Requests

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/your-feature-name`
3. Make your changes
4. Run checks before committing:
   ```bash
   npm run typecheck
   npm run lint
   ```
5. Commit with conventional commit messages (feat/fix/docs/refactor/test/chore)
6. Push and create a Pull Request

### Development Setup

```bash
git clone https://github.com/AIMatrix/pm-copilot-agent.git
cd pm-copilot-agent/src
bun install
npm run typecheck
```

### Questions?

Open an issue or reach out at aimatrixling@gmail.com
