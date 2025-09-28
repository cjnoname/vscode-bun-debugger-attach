#!/bin/bash

echo "🚀 Starting Bun debug test"
echo "Command: bun --inspect-wait=127.0.0.1:6499 test-script.ts"
echo ""
echo "Debug info:"
echo "- Debugger WebSocket port: 6499 (VS Code connects here)"
echo "- Extension will auto-detect and attach debugger"
echo ""
echo "Starting..."

bun --inspect-wait=127.0.0.1:6499 test-script.ts