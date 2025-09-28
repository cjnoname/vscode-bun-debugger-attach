import * as vscode from 'vscode';
import * as cp from 'child_process';

const attachedSessions = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    let isScanning = false;
    let scanCount = 0;
    const portRegex = /:(\d+)\s+\(LISTEN\)/;

    async function scanForBunDebugger() {
        if (isScanning) return [];
        isScanning = true;

        return new Promise<Array<{host: string, port: number}>>((resolve) => {
            cp.exec(`lsof -i TCP -sTCP:LISTEN -n | awk '/bun.*LISTEN/ {print $9}'`, 
                { timeout: 300 }, 
                (error, stdout) => {
                    isScanning = false;
                    const foundProcesses: Array<{host: string, port: number}> = [];
                    
                    if (!error && stdout) {
                        const lines = stdout.split('\n');
                        for (const line of lines) {
                            const match = portRegex.exec(line);
                            if (match) {
                                const port = parseInt(match[1], 10);
                                foundProcesses.push({ host: '127.0.0.1', port });
                            }
                        }
                    }
                    
                    resolve(foundProcesses);
                }
            );
        });
    }

    async function tryAttach() {
        scanCount++;
        
        if (vscode.debug.activeDebugSession && scanCount % 10 !== 0) return;
        
        const processes = await scanForBunDebugger();
        if (processes.length === 0) return;
        
        for (const proc of processes) {
            const key = `${proc.host}:${proc.port}`;
            
            if (attachedSessions.has(key)) continue;
            
            attachedSessions.add(key);
            console.log(`🔗 Attaching to ${key}`);
            
            vscode.debug.startDebugging(undefined, {
                type: 'bun',
                request: 'attach',
                name: `Attach Bun (${key})`,
                url: `ws://${proc.host}:${proc.port}/debugger`,
                stopOnEntry: false
            }).then(success => {
                if (success) {
                    console.log(`✅ Attached to ${key}`);
                } else {
                    console.log(`❌ Failed to attach to ${key}`);
                    attachedSessions.delete(key);
                }
            });
        }
    }

    const interval = setInterval(tryAttach, 200);
    
    vscode.debug.onDidTerminateDebugSession(session => {
        const match = session.name.match(/Attach Bun \(([^)]+)\)/);
        if (match) {
            const key = match[1];
            attachedSessions.delete(key);
            console.log(`🔄 Detached from ${key}`);
        }
    });

    context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export function deactivate() {}