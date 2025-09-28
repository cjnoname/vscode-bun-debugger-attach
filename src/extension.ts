import * as vscode from 'vscode';
import * as cp from 'child_process';

const attachedSessions = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    async function scanForBunDebugger() {
        return new Promise<Array<{host: string, port: number}>>((resolve) => {
            cp.exec(`lsof -i -P -n | grep bun | grep LISTEN`, (error, stdout) => {
                const foundProcesses: Array<{host: string, port: number}> = [];
                
                if (!error && stdout) {
                    const lines = stdout.split('\n').filter(line => line.trim());
                    
                    for (const line of lines) {
                        const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
                        if (portMatch) {
                            const port = parseInt(portMatch[1]);
                            console.log(`🎯 Found bun process on port ${port}`);
                            foundProcesses.push({ host: '127.0.0.1', port });
                        }
                    }
                }
                
                resolve(foundProcesses);
            });
        });
    }



    async function tryAttach() {
        const processes = await scanForBunDebugger();
        
        for (const proc of processes) {
            const key = `${proc.host}:${proc.port}`;
            
            if (attachedSessions.has(key)) continue;
            if (vscode.debug.activeDebugSession?.name.includes(key)) continue;
            
            console.log(`🔗 Attaching to Bun at ${key}`);
            
            vscode.debug.startDebugging(undefined, {
                type: 'bun',
                request: 'attach',
                name: `Attach Bun (${key})`,
                url: `ws://${proc.host}:${proc.port}/debugger`,
                stopOnEntry: false
            }).then(success => {
                if (success) {
                    attachedSessions.add(key);
                    console.log(`✅ Attached to ${key}`);
                } else {
                    console.log(`❌ Failed to attach to ${key}`);
                }
            });
        }
    }

    const interval = setInterval(tryAttach, 300);
    
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