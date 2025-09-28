import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as net from 'net';

const attachedSessions = new Set<string>();
const processCache = new Map<string, { port: number, lastSeen: number }>();
let isScanning = false;
let lastScanTime = 0;

// 全局端口锁映射 - 防止多个VS Code窗口attach同一端口
const globalPortLocks = new Map<number, string>();

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    // 获取当前工作区唯一标识
    const workspaceId = vscode.workspace.workspaceFolders?.[0]?.uri.toString() || `vscode-${Date.now()}-${Math.random()}`;

    // 端口锁管理函数
    function canClaimPort(port: number): boolean {
        const currentOwner = globalPortLocks.get(port);
        return !currentOwner || currentOwner === workspaceId;
    }

    function claimPort(port: number): boolean {
        if (!canClaimPort(port)) return false;
        globalPortLocks.set(port, workspaceId);
        return true;
    }

    function releasePort(port: number): void {
        if (globalPortLocks.get(port) === workspaceId) {
            globalPortLocks.delete(port);
        }
    }

    async function getCurrentWindowTerminalPids(): Promise<number[]> {
        const processIds: number[] = [];
        for (const terminal of vscode.window.terminals) {
            try {
                const pid = await terminal.processId;
                if (pid) processIds.push(pid);
            } catch {}
        }
        return processIds;
    }

    // Collect descendant PIDs for shells to ensure we ONLY touch processes launched from terminals of THIS window
    let cachedPidTree: number[] = [];
    let lastPidTreeBuild = 0;
    async function getTerminalProcessTreePids(): Promise<number[]> {
        const now = Date.now();
        // Rebuild at most every 600ms to keep 200ms scan cheap
        if (now - lastPidTreeBuild < 600 && cachedPidTree.length) return cachedPidTree;
        const roots = await getCurrentWindowTerminalPids();
        const visited = new Set<number>(roots);
        let frontier = roots.slice();
        const maxDepth = 5;
        for (let depth = 0; depth < maxDepth && frontier.length; depth++) {
            try {
                const listStr = frontier.join(',');
                const stdout = await new Promise<string>((resolve) => {
                    if (!listStr) { resolve(''); return; }
                    cp.exec(`pgrep -P ${listStr}`, { timeout: 300 }, (err, out) => {
                        if (err || !out) return resolve('');
                        resolve(out);
                    });
                });
                const childPids = stdout.split(/\s+/).map(s => parseInt(s, 10)).filter(n => !isNaN(n));
                const fresh: number[] = [];
                for (const c of childPids) if (!visited.has(c)) { visited.add(c); fresh.push(c); }
                frontier = fresh;
            } catch {
                break;
            }
            if (visited.size > 200) break; // safety cap
        }
        cachedPidTree = Array.from(visited);
        lastPidTreeBuild = now;
        console.log(`🌐 PID tree (window scope) size=${cachedPidTree.length}`);
        return cachedPidTree;
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

    async function scanForBunDebugger() {
        const now = Date.now();
        
        if (isScanning || (now - lastScanTime) < 150) {
            return Array.from(processCache.values())
                .filter(proc => now - proc.lastSeen < 1000)
                .map(proc => ({ host: '127.0.0.1', port: proc.port }));
        }

        isScanning = true;
        lastScanTime = now;

        return new Promise<Array<{host: string, port: number}>>((resolve) => {
            getTerminalProcessTreePids().then(pids => {
                if (pids.length === 0) {
                    isScanning = false;
                    resolve([]);
                    return;
                }
                const pidList = pids.join(',');
                cp.exec(`lsof -iTCP -sTCP:LISTEN -n -P -p ${pidList} 2>/dev/null | awk 'NR==1 || /bun/ {print}'`, { timeout: 800 }, (error, stdout) => {
                    isScanning = false;
                    const foundProcesses: Array<{host: string, port: number}> = [];
                    const seenPorts = new Set<number>();
                    
                    if (!error && stdout) {
                        const lines = stdout.split('\n').filter(line => line.trim() && line.includes('LISTEN'));
                        for (const line of lines) {
                            if (!line.startsWith('bun')) continue;
                            const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
                            if (!portMatch) continue;
                            const port = parseInt(portMatch[1]);
                            const isDebuggerPort = port === 9229 || (port >= 6000 && port < 7000);
                            if (!isDebuggerPort) continue;
                            if (seenPorts.has(port)) continue;
                            seenPorts.add(port);
                            const key = `127.0.0.1:${port}`;
                            processCache.set(key, { port, lastSeen: now });
                            foundProcesses.push({ host: '127.0.0.1', port });
                        }
                    }
                    
                    for (const [key, proc] of processCache.entries()) {
                        if (now - proc.lastSeen > 1000) {
                            processCache.delete(key);
                        }
                    }
                    
                    resolve(foundProcesses);
                });
            });
        });
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
                
                const attachPromises = processes
                    .filter(proc => {
                        const key = `${proc.host}:${proc.port}`;
                        return !attachedSessions.has(key) && 
                               !vscode.debug.activeDebugSession?.name.includes(key);
                    })
                    .slice(0, maxConcurrentAttachments - activeAttachments)
                    .map(async (proc) => {
                        const key = `${proc.host}:${proc.port}`;
                        activeAttachments++;
                        
                        try {
                            // 工作区锁检查 - 核心防跨窗口逻辑
                            if (!claimPort(proc.port)) {
                                console.log(`🔒 Port ${proc.port} already claimed by another workspace`);
                                return;
                            }
                            
                            const isBunDebugger = await checkBunDebugger(proc.host, proc.port);
                            if (!isBunDebugger) {
                                releasePort(proc.port);
                                return;
                            }
                            
                            console.log(`🔗 Attaching to Bun at ${key} (workspace: ${workspaceId})`);
                            
                            const attachPromise = vscode.debug.startDebugging(undefined, {
                                type: 'bun',
                                request: 'attach',
                                name: `Attach Bun (${key})`,
                                url: `ws://${proc.host}:${proc.port}/debugger`,
                                stopOnEntry: false
                            });
                            
                            const timeoutPromise = new Promise<false>((resolve) => 
                                setTimeout(() => resolve(false), 2000)
                            );
                            
                            const success = await Promise.race([attachPromise, timeoutPromise]);
                            
                            if (success) {
                                attachedSessions.add(key);
                                console.log(`✅ Attached to ${key}`);
                            } else {
                                releasePort(proc.port);
                                console.log(`⏰ Timeout attaching to ${key}`);
                            }
                        } catch (attachError) {
                            releasePort(proc.port);
                            console.log(`❌ Error attaching to ${key}:`, (attachError as Error).message);
                        } finally {
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
    
    vscode.debug.onDidTerminateDebugSession(session => {
        const match = session.name.match(/Attach Bun \(([^)]+)\)/);
        if (match) {
            const key = match[1];
            attachedSessions.delete(key);
            const port = parseInt(key.split(':')[1]);
            if (!isNaN(port)) releasePort(port);
            console.log(`🔄 Detached from ${key}`);
        }
    });

    context.subscriptions.push({ dispose: () => {
        clearInterval(interval);
        if (debounceTimer) clearTimeout(debounceTimer);
        // 清理我们占用的所有端口锁
        for (const key of attachedSessions) {
            const port = parseInt(key.split(':')[1]);
            if (!isNaN(port)) releasePort(port);
        }
    }});
}

export function deactivate() {}