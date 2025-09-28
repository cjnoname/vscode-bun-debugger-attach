import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

interface BunCandidate { host: string; port: number; pid: number; }
interface CachedProc { port: number; pid: number; lastSeen: number; }

// Centralized mutable state (kept module local)
const state = {
    attachedSessions: new Set<string>(),     // host:port
    sessionPidMap: new Map<string, number>(),
    processCache: new Map<string, CachedProc>(), // pid:port -> info
    suppressed: new Set<string>(),
    cooldown: new Map<string, number>(),
    inFlight: new Set<string>(),
    attachedPids: new Set<number>(),
    sessionIdByKey: new Map<string, string>(),
    isScanning: false,
    lastScanTime: 0
};

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
    state.suppressed.add(key);
    try { fs.writeFileSync(suppressionFile(pid, port), JSON.stringify({ pid, port, time: Date.now() })); } catch {}
}

function isSuppressed(pid: number, port: number): boolean {
    const key = `${pid}:${port}`;
    if (state.suppressed.has(key)) return true;
    const file = suppressionFile(pid, port);
    if (!fs.existsSync(file)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (data.pid !== pid || data.port !== port) return false;
        if (!isProcessAlive(pid)) { try { fs.unlinkSync(file); } catch {}; state.suppressed.delete(key); return false; }
        state.suppressed.add(key); return true;
    } catch { return false; }
}

// Small helpers
const keyOf = (host: string, port: number) => `${host}:${port}`;
const candidateKey = (c: BunCandidate) => keyOf(c.host, c.port);
const nowMs = () => Date.now();
const INSPECT_PORTS = new Set([9229, 6499]);

async function probeDebuggerWebSocket(host: string, port: number): Promise<boolean> {
    return new Promise(resolve => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok: boolean) => { if (!done) { done = true; socket.destroy(); resolve(ok); } };
        socket.setTimeout(200);
        socket.connect(port, host, () => {
            socket.write(`GET /debugger HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\n\r\n`);
        });
        socket.on('data', d => {
            const s = d.toString();
            finish(/websocket|101 Switching Protocols/i.test(s));
        });
        socket.on('error', () => finish(false));
        socket.on('timeout', () => finish(false));
        setTimeout(() => finish(false), 300);
    });
}

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    async function getCurrentWindowTerminalPids(): Promise<number[]> {
        const pids: number[] = [];
        for (const term of vscode.window.terminals) {
            try { const pid = await term.processId; if (pid) { pids.push(pid); console.log(`📟 Terminal PID: ${pid} (${term.name})`);} } catch {}
        }
        console.log(`🔍 Scanning ${pids.length} terminals in current VS Code window`);
        return pids;
    }

    async function scanForBunDebugger(): Promise<BunCandidate[]> {
        const now = nowMs();
        if (state.isScanning || (now - state.lastScanTime) < 200) {
            return Array.from(state.processCache.values())
                .filter(p => now - p.lastSeen < 1500)
                .map(p => ({ host: '127.0.0.1', port: p.port, pid: p.pid }));
        }
        state.isScanning = true; state.lastScanTime = now;

        const terminalPids = await getCurrentWindowTerminalPids();
        if (terminalPids.length === 0) { state.isScanning = false; return []; }
        console.log(`🔎 Global scan (ancestors of: ${terminalPids.join(',')})`);

        const [lsofOut, psOut] = await Promise.all([
            new Promise<string>(r => cp.exec(`lsof -iTCP -sTCP:LISTEN -n -P`, { timeout: 800 }, (_, o) => r(o || ''))),
            new Promise<string>(r => cp.exec(`ps -Ao pid,ppid`, { timeout: 800 }, (_, o) => r(o || '')))
        ]);

        const parentMap = new Map<number, number>();
        for (const line of psOut.split('\n')) {
            const m = line.trim().match(/^(\d+)\s+(\d+)/); if (m) parentMap.set(+m[1], +m[2]);
        }
        const belongsToWindow = (pid: number) => {
            const visited = new Set<number>();
            let cur = pid;
            while (cur && !visited.has(cur) && cur !== 1) { if (terminalPids.includes(cur)) return true; visited.add(cur); cur = parentMap.get(cur) || 0; }
            return false;
        };

        const found: BunCandidate[] = [];
        const seen = new Set<string>();
        for (const line of lsofOut.split('\n')) {
            if (!line || line.startsWith('COMMAND') || !line.includes('LISTEN')) continue;
            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/); if (!portMatch) continue;
            const port = +portMatch[1]; if (!INSPECT_PORTS.has(port)) continue;
            const pidMatch = line.match(/^\S+\s+(\d+)/); if (!pidMatch) continue;
            const pid = +pidMatch[1]; if (!belongsToWindow(pid)) continue;
            const unique = `${pid}:${port}`; if (seen.has(unique) || isSuppressed(pid, port)) continue;
            seen.add(unique);
            state.processCache.set(unique, { pid, port, lastSeen: now });
            found.push({ host: '127.0.0.1', port, pid });
            console.log(`🎯 Candidate pid=${pid} port=${port}`);
        }

        // prune old
        for (const [k, v] of state.processCache) if (now - v.lastSeen > 2000) state.processCache.delete(k);
        state.isScanning = false; return found;
    }

    let activeAttachments = 0;
    const MAX_CONCURRENT = 2;

    function eligible(proc: BunCandidate, now: number) {
        const key = candidateKey(proc);
        if (state.attachedSessions.has(key)) return false;
        if (vscode.debug.activeDebugSession?.name.includes(key)) return false;
        if ((state.cooldown.get(key) || 0) > now) return false;
        if (state.attachedPids.has(proc.pid)) return false;
        if (state.inFlight.has(key)) return false;
        if (!acquirePortLock(proc.port)) return false;
        return true;
    }

    async function attemptAttachments() {
        try {
            if (activeAttachments >= MAX_CONCURRENT) return;
            const candidates = (await scanForBunDebugger()).filter(c => eligible(c, nowMs()));
            const slice = candidates.slice(0, MAX_CONCURRENT - activeAttachments);
            await Promise.all(slice.map(async proc => {
                const key = candidateKey(proc);
                state.inFlight.add(key);
                activeAttachments++;
                try {
                    if (!(await probeDebuggerWebSocket(proc.host, proc.port))) { releasePortLock(proc.port); return; }
                    console.log(`🔗 Attaching to Bun at ${key} (pid=${proc.pid})`);
                    const attachPromise = vscode.debug.startDebugging(undefined, {
                        type: 'bun', request: 'attach', name: `Attach Bun (${key})`, url: `ws://${proc.host}:${proc.port}/debugger`, stopOnEntry: false
                    });
                    const success = await Promise.race([attachPromise, new Promise<false>(r => setTimeout(() => r(false), 2000))]);
                    if (success) {
                        state.attachedSessions.add(key);
                        state.sessionPidMap.set(key, proc.pid);
                        state.attachedPids.add(proc.pid);
                        console.log(`✅ Attached to ${key} (pid=${proc.pid}) in workspace: ${vscode.workspace.name || 'current'}`);
                    } else {
                        console.log(`⏰ Timeout attaching to ${key}`);
                        releasePortLock(proc.port);
                    }
                } catch (e) {
                    console.log(`❌ Error attaching to ${key}:`, (e as Error).message);
                    releasePortLock(proc.port);
                } finally {
                    state.inFlight.delete(key);
                    activeAttachments--;
                }
            }));
        } catch (err) {
            console.error('Error in attachment loop:', err);
        }
    }

    const interval = setInterval(attemptAttachments, 200);
    
    // Dedupe: ensure only one active session per host:port. If duplicate appears, stop the newer one.
    vscode.debug.onDidStartDebugSession(session => {
        const match = session.name.match(/Attach Bun \(([^)]+)\)/); if (!match) return; const key = match[1];
        const existing = state.sessionIdByKey.get(key);
        if (!existing) { state.sessionIdByKey.set(key, session.id); return; }
        if (existing !== session.id) { console.log(`⚠️ Duplicate debug session for ${key} -> terminating ${session.id}`); vscode.debug.stopDebugging(session); }
    });

    vscode.debug.onDidTerminateDebugSession(session => {
        const match = session.name.match(/Attach Bun \(([^)]+)\)/); if (!match) return;
        const key = match[1]; const [, portStr] = key.split(':'); const port = parseInt(portStr, 10);
        const pid = state.sessionPidMap.get(key);
        state.attachedSessions.delete(key);
        state.sessionPidMap.delete(key);
        releasePortLock(port);
        state.cooldown.set(key, nowMs() + 800);
        state.sessionIdByKey.delete(key);
        if (pid) state.attachedPids.delete(pid);
        if (pid && isProcessAlive(pid)) { markSuppressed(pid, port); console.log(`🚫 Manual detach for ${key} (pid=${pid}) -> suppression`); }
        else { console.log(`🔄 Detached from ${key}`); }
    });

    context.subscriptions.push({ dispose: () => {
        clearInterval(interval);
        for (const key of state.attachedSessions) { const [, p] = key.split(':'); releasePortLock(parseInt(p, 10)); }
    }});
}

export function deactivate() {}