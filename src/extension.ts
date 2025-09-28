import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface BunCandidate {
    host: string;
    port: number;
    pid: number;
}

// Sessions we have successfully attached in THIS window (key host:port)
const attachedSessions = new Set<string>();
// Mapping host:port -> bun pid (so we can distinguish manual stop vs process exit)
const sessionPidMap = new Map<string, number>();
// Cache of candidates (key pid:port) for quick re-use between tight scans
const processCache = new Map<string, { port: number; pid: number; lastSeen: number }>();
// Local suppression (user manually stopped). Key pid:port
const suppressed = new Set<string>();
// Cooldown per host:port after termination to prevent race re-attach (ms timestamp)
const cooldown = new Map<string, number>();
// Track in-flight attachment attempts (host:port)
const inFlight = new Set<string>();
// Track which PIDs already have a debugger (enforce single session per bun pid)
const attachedPids = new Set<number>();
// Map host:port -> session.id to detect duplicates
const sessionIdByKey = new Map<string, string>();

// Cross-window coordination directory
const TMP_BASE = path.join(os.tmpdir(), 'vscode-bun-debugger-attach');
try { fs.mkdirSync(TMP_BASE, { recursive: true }); } catch {}

function lockFile(port: number) { return path.join(TMP_BASE, `lock-${port}.json`); }
function suppressionFile(pid: number, port: number) { return path.join(TMP_BASE, `suppress-${pid}-${port}`); }

function isProcessAlive(pid: number) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquirePortLock(port: number): boolean {
    const file = lockFile(port);
    try {
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(content);
            if (data && isProcessAlive(data.extensionPid) && data.extensionPid !== process.pid) {
                return false; // another window owns the lock
            }
        }
        fs.writeFileSync(file, JSON.stringify({ extensionPid: process.pid, time: Date.now() }));
        return true;
    } catch {
        return true; // fail open (do our best)
    }
}

function releasePortLock(port: number) {
    const file = lockFile(port);
    try {
        if (fs.existsSync(file)) {
            const content = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(content);
            if (data.extensionPid === process.pid) {
                fs.unlinkSync(file);
            }
        }
    } catch {}
}

function markSuppressed(pid: number, port: number) {
    const key = `${pid}:${port}`;
    suppressed.add(key);
    try { fs.writeFileSync(suppressionFile(pid, port), JSON.stringify({ pid, port, time: Date.now() })); } catch {}
}

function isSuppressed(pid: number, port: number): boolean {
    const key = `${pid}:${port}`;
    if (suppressed.has(key)) return true;
    const file = suppressionFile(pid, port);
    if (fs.existsSync(file)) {
        try {
            const content = fs.readFileSync(file, 'utf8');
            const data = JSON.parse(content);
            if (data.pid === pid && data.port === port) {
                if (!isProcessAlive(pid)) {
                    // cleanup stale suppression (process gone)
                    try { fs.unlinkSync(file); } catch {}
                    suppressed.delete(key);
                    return false;
                }
                suppressed.add(key);
                return true;
            }
        } catch {}
    }
    return false;
}
let isScanning = false;
let lastScanTime = 0;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    async function getCurrentWindowTerminalPids(): Promise<number[]> {
        const processIds: number[] = [];
        
        for (const terminal of vscode.window.terminals) {
            try {
                const processId = await terminal.processId;
                if (processId) {
                    processIds.push(processId);
                    console.log(`📟 Found terminal PID: ${processId} (${terminal.name})`);
                }
            } catch {
            }
        }
        
        console.log(`🔍 Scanning ${processIds.length} terminals in current VS Code window`);
        return processIds;
    }

    async function checkBunDebugger(host: string, port: number): Promise<boolean> {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            socket.setTimeout(200);
            socket.setNoDelay(true);
            
            let resolved = false;
            const resolveOnce = (result: boolean) => {
                if (!resolved) {
                    resolved = true;
                    socket.destroy();
                    resolve(result);
                }
            };
            
            socket.connect(port, host, () => {
                socket.write('GET /debugger HTTP/1.1\r\nHost: ' + host + '\r\nUpgrade: websocket\r\n\r\n');
            });
            
            socket.on('data', (data) => {
                const response = data.toString();
                if (response.includes('websocket') || response.includes('101 Switching Protocols')) {
                    resolveOnce(true);
                } else {
                    resolveOnce(false);
                }
            });
            
            socket.on('error', () => {
                resolveOnce(false);
            });
            
            socket.on('timeout', () => {
                resolveOnce(false);
            });
            
            setTimeout(() => {
                resolveOnce(false);
            }, 300);
        });
    }

    async function scanForBunDebugger(): Promise<BunCandidate[]> {
        const now = Date.now();

        if (isScanning || (now - lastScanTime) < 200) {
            return Array.from(processCache.values())
                .filter(proc => now - proc.lastSeen < 1500)
                .map(proc => ({ host: '127.0.0.1', port: proc.port, pid: proc.pid }));
        }

        isScanning = true;
        lastScanTime = now;

        const terminalPids = await getCurrentWindowTerminalPids();
        if (terminalPids.length === 0) {
            isScanning = false;
            return [];
        }

        console.log(`🔎 Global scan for bun processes (filtering to ancestors of: ${terminalPids.join(',')})`);

        // Perform lsof to find ALL bun listening ports, we'll filter afterwards.
        const lsofPromise = new Promise<string>(resolve => {
            cp.exec(`lsof -iTCP -sTCP:LISTEN -n -P | grep bun`, { timeout: 800 }, (e, out) => resolve(out || ''));
        });
        const psPromise = new Promise<string>(resolve => {
            cp.exec(`ps -Ao pid,ppid`, { timeout: 800 }, (e, out) => resolve(out || ''));
        });

        const [lsofOut, psOut] = await Promise.all([lsofPromise, psPromise]);

        const parentMap = new Map<number, number>();
        psOut.split('\n').forEach(line => {
            const m = line.trim().match(/^(\d+)\s+(\d+)/);
            if (m) parentMap.set(parseInt(m[1]), parseInt(m[2]));
        });

        function belongsToCurrentWindow(pid: number): boolean {
            const visited = new Set<number>();
            let current = pid;
            while (current && !visited.has(current) && current !== 1) {
                if (terminalPids.includes(current)) return true;
                visited.add(current);
                current = parentMap.get(current) || 0;
            }
            return false;
        }

        const found: BunCandidate[] = [];
        const seen = new Set<string>();
        lsofOut.split('\n').forEach(line => {
            if (!line.startsWith('bun') || !line.includes('LISTEN')) return;
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
            const pidMatch = line.match(/^bun\s+(\d+)/);
            if (!portMatch || !pidMatch) return;
            const port = parseInt(portMatch[1]);
            const pid = parseInt(pidMatch[1]);
            const isDebuggerPort = port === 9229 || port === 6499; // commonly used bun inspector ports
            if (!isDebuggerPort) return;
            if (!belongsToCurrentWindow(pid)) return; // NOT from this window's terminals
            const unique = `${pid}:${port}`;
            if (seen.has(unique)) return;
            seen.add(unique);
            if (isSuppressed(pid, port)) return; // user manually detached earlier
            processCache.set(unique, { pid, port, lastSeen: now });
            found.push({ host: '127.0.0.1', port, pid });
            console.log(`🎯 Found bun process pid=${pid} port=${port}`);
        });

        // cleanup stale cache entries
        for (const [key, proc] of processCache.entries()) {
            if (now - proc.lastSeen > 2000) processCache.delete(key);
        }

        isScanning = false;
        return found;
    }

    let debounceTimer: NodeJS.Timeout | null = null;
    let activeAttachments = 0;
    const maxConcurrentAttachments = 2;
    
    async function tryAttachDebounced() {
        if (debounceTimer) clearTimeout(debounceTimer);
        
        debounceTimer = setTimeout(async () => {
            try {
                if (activeAttachments >= maxConcurrentAttachments) return;
                
                const processes = await scanForBunDebugger();
                const now = Date.now();
                const attachPromises = processes
                    .filter(proc => {
                        const key = `${proc.host}:${proc.port}`;
                        if (attachedSessions.has(key)) return false;
                        if (vscode.debug.activeDebugSession?.name.includes(key)) return false;
                        if (cooldown.get(key) && cooldown.get(key)! > now) return false;
                        if (attachedPids.has(proc.pid)) return false; // already attached to this bun process
                        if (inFlight.has(key)) return false;
                        if (!acquirePortLock(proc.port)) return false; // another window already attached
                        return true;
                    })
                    .slice(0, maxConcurrentAttachments - activeAttachments)
                    .map(async (proc) => {
                        const key = `${proc.host}:${proc.port}`;
                        inFlight.add(key);
                        activeAttachments++;
                        try {
                            const isBunDebugger = await checkBunDebugger(proc.host, proc.port);
                            if (!isBunDebugger) { releasePortLock(proc.port); return; }
                            console.log(`🔗 Attaching to Bun at ${key} (pid=${proc.pid})`);
                            const attachPromise = vscode.debug.startDebugging(undefined, {
                                type: 'bun',
                                request: 'attach',
                                name: `Attach Bun (${key})`,
                                url: `ws://${proc.host}:${proc.port}/debugger`,
                                stopOnEntry: false
                            });
                            const timeoutPromise = new Promise<false>(r => setTimeout(() => r(false), 2000));
                            const success = await Promise.race([attachPromise, timeoutPromise]);
                            if (success) {
                                attachedSessions.add(key);
                                sessionPidMap.set(key, proc.pid);
                                attachedPids.add(proc.pid);
                                console.log(`✅ Attached to ${key} (pid=${proc.pid}) in workspace: ${vscode.workspace.name || 'current'}`);
                            } else {
                                console.log(`⏰ Timeout attaching to ${key}`);
                                releasePortLock(proc.port);
                            }
                        } catch (attachError) {
                            console.log(`❌ Error attaching to ${key}:`, (attachError as Error).message);
                            releasePortLock(proc.port);
                        } finally {
                            inFlight.delete(key);
                            activeAttachments--;
                        }
                    });

                await Promise.allSettled(attachPromises);
            } catch (error) {
                console.error('Error in tryAttach:', error);
            }
        }, 150);
    }

    const interval = setInterval(tryAttachDebounced, 200);
    
    // Dedupe: ensure only one active session per host:port. If duplicate appears, stop the newer one.
    vscode.debug.onDidStartDebugSession(session => {
        const match = session.name.match(/Attach Bun \(([^)]+)\)/);
        if (!match) return;
        const key = match[1];
        const existing = sessionIdByKey.get(key);
        if (!existing) {
            sessionIdByKey.set(key, session.id);
            return;
        }
        if (existing !== session.id) {
            console.log(`⚠️ Duplicate debug session detected for ${key}. Terminating new session ${session.id}`);
            vscode.debug.stopDebugging(session); // terminate duplicate quickly
        }
    });

    vscode.debug.onDidTerminateDebugSession(session => {
        const match = session.name.match(/Attach Bun \(([^)]+)\)/);
        if (!match) return;
        const key = match[1]; // host:port
        const [host, portStr] = key.split(':');
        const port = parseInt(portStr, 10);
        const pid = sessionPidMap.get(key);

        attachedSessions.delete(key);
        sessionPidMap.delete(key);
        releasePortLock(port);
        cooldown.set(key, Date.now() + 800);
        sessionIdByKey.delete(key);
        if (pid) attachedPids.delete(pid);

        if (pid && isProcessAlive(pid)) {
            // Manual stop (process still running) -> suppress re-attach until restart
            markSuppressed(pid, port);
            console.log(`🚫 Manual detach detected for ${key} (pid=${pid}) -> suppression active until process restarts`);
        } else {
            console.log(`🔄 Detached from ${key} (process ended)`);
        }
    });

    context.subscriptions.push({ dispose: () => {
        clearInterval(interval);
        if (debounceTimer) clearTimeout(debounceTimer);
        // release any held locks on deactivate
        for (const key of attachedSessions) {
            const [, portStr] = key.split(':');
            const port = parseInt(portStr, 10);
            releasePortLock(port);
        }
    }});
}

export function deactivate() {}