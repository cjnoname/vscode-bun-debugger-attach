import * as vscode from 'vscode';
import * as cp from 'child_process';

let attached = false;

export function activate(context: vscode.ExtensionContext) {
    console.log('🚀 Bun Auto-Attach Active');

    async function tryAttach() {
        if (attached || vscode.debug.activeDebugSession) return;

        cp.exec('lsof -i :9229', (error, stdout) => {
            if (error || !stdout.includes('LISTEN')) return;
            
            console.log('🔗 Attaching to Bun');
            vscode.debug.startDebugging(undefined, {
                type: 'bun',
                request: 'attach',
                name: 'Attach Bun',
                url: 'ws://127.0.0.1:9229/debugger',
                stopOnEntry: false
            }).then(success => {
                if (success) {
                    attached = true;
                    console.log('✅ Attached');
                }
            });
        });
    }

    const interval = setInterval(tryAttach, 300);
    
    vscode.debug.onDidTerminateDebugSession(() => {
        attached = false;
    });

    context.subscriptions.push({ dispose: () => clearInterval(interval) });
}

export function deactivate() {}