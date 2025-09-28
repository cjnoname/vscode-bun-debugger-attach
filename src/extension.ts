import * as vscode from 'vscode';
import * as cp from 'child_process';

const attachedSessions = new Set<string>();

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    async function scanForBunDebugger() {
        return new Promise<Array<{host: string, port: number}>>((resolve) => {
            const commonPorts = [9229, 6499, 8080, 3000, 5000, 8000, 9999];
            const foundProcesses: Array<{host: string, port: number}> = [];
            
            let remaining = commonPorts.length;
            
            for (const port of commonPorts) {
                cp.exec(`lsof -i :${port} | grep LISTEN`, (error, stdout) => {
                    remaining--;
                    
                    if (!error && stdout.includes('bun')) {
                        console.log(`🎯 Found bun process on port ${port}`);
                        foundProcesses.push({ host: '127.0.0.1', port });
                    }
                    
                    if (remaining === 0) {
                        resolve(foundProcesses);
                    }
                });
            }
            
            // 安全回调，避免永久等待
            setTimeout(() => {
                if (remaining > 0) {
                    console.log('⏰ Port scan timeout');
                    resolve(foundProcesses);
                }
            }, 1000);
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