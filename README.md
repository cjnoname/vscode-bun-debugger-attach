# Bun Debugger Auto-Attach

Automatically attach VS Code debugger to Bun processes.

## Features

- Auto-detection of Bun processes with --inspect-wait
- Instant debugger attachment  
- Fast response (checks every 300ms)
- Zero configuration required

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)  
3. Search for "Bun Debugger Auto-Attach"
4. Click Install

## Usage

Run Bun with debug flag:
```bash
bun --inspect-wait=127.0.0.1:9229 your-script.ts
```

The extension automatically detects and attaches the debugger.

### Supported Commands

```bash
# Basic usage
bun --inspect-wait script.ts

# Custom port  
bun --inspect-wait=9230 script.ts

# Custom host and port
bun --inspect-wait=127.0.0.1:9229 script.ts
```

## Troubleshooting

1. Check if port is available: `lsof -i :9229`
2. Verify Bun process: `ps aux | grep "bun.*--inspect"`
3. Check VS Code Developer Console for "Bun Auto-Attach Active" message

## License

MIT License
