import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as net from 'net';

const attachedSessions = new Set<string>();
const processCache = new Map<string, { port: number, lastSeen: number }>();
let isScanning = false;
let lastScanTime = 0;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    async function getTerminalProcessIds(): Promise<number[]> {
        const terminals = vscode.window.terminals;
        const processIds: number[] = [];
        
        for (const terminal of terminals) {
            try {
                const processId = await terminal.processId;
                if (processId) {
                    processIds.push(processId);
                }
            } catch {
                continue;
            }
        }
        
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
            getTerminalProcessIds().then(terminalPids => {
                if (terminalPids.length === 0) {
                    isScanning = false;
                    resolve([]);
                    return;
                }
                
                const pidList = terminalPids.join(',');
                cp.exec(`lsof -iTCP -sTCP:LISTEN -n -P -p ${pidList} | grep bun`, { timeout: 800 }, (error, stdout) => {
                    isScanning = false;
                    const foundProcesses: Array<{host: string, port: number}> = [];
                    const seenPorts = new Set<number>();
                    
                    if (!error && stdout) {
                        const lines = stdout.split('\n').filter(line => line.trim());
                        
                        for (const line of lines) {
                            if (line.startsWith('bun') && line.includes('LISTEN')) {
                                const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
                                if (portMatch) {
                                    const port = parseInt(portMatch[1]);
                                    
                                    const isDebuggerPort = port === 9229 || (port === 6499);
                                    if (!isDebuggerPort) continue;
                                    if (seenPorts.has(port)) continue;
                                    
                                    seenPorts.add(port);
                                    const key = `127.0.0.1:${port}`;
                                    
                                    processCache.set(key, { port, lastSeen: now });
                                    foundProcesses.push({ host: '127.0.0.1', port });
                                    console.log(`🎯 Found bun process on port ${port}`);
                                }
                            }
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
                            const isBunDebugger = await checkBunDebugger(proc.host, proc.port);
                            if (!isBunDebugger) return;
                            
                            console.log(`🔗 Attaching to Bun at ${key}`);
                            
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
                                console.log(`⏰ Timeout attaching to ${key}`);
                            }
                        } catch (attachError) {
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
            console.log(`🔄 Detached from ${key}`);
        }
    });

    context.subscriptions.push({ dispose: () => {
        clearInterval(interval);
        if (debounceTimer) clearTimeout(debounceTimer);
    }});
}

export function deactivate() {}