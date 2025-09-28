import * as vscode from 'vscode';
import * as net from 'net';

export interface BunDebugInfo {
    host: string;
    port: number;
    type: string;
    inspectPort?: number;
}

export async function attachDebugger(host: string = '127.0.0.1', port: number = 6499): Promise<void> {
    try {
        const debuggerUrl = `ws://${host}:${port}/debugger`;
        
        const isPortOpen = await checkPort(host, port);
        if (!isPortOpen) {
            return;
        }

        const sessionName = `Attach to Bun (${host}:${port})`;

        const existingSession = vscode.debug.activeDebugSession;
        if (existingSession?.name === sessionName && existingSession.type === 'bun') {
            console.log(`Debug session already exists for ${host}:${port}`);
            return;
        }

        console.log(`🔗 Starting Bun debug session for ${debuggerUrl}`);
        
        const success = await vscode.debug.startDebugging(undefined, {
            type: 'bun',
            request: 'attach',
            name: sessionName,
            url: debuggerUrl,
            stopOnEntry: false
        });
        
        if (success) {
            vscode.window.showInformationMessage(`🚀 Bun Debugger attached to ${debuggerUrl}`);
            console.log(`✅ Successfully started Bun debug session for ${debuggerUrl}`);
        } else {
            console.log(`❌ Failed to start Bun debug session for ${debuggerUrl}`);
            throw new Error(`Failed to start debug session for ${debuggerUrl}`);
        }
    } catch (error) {
        console.log(`Could not attach Bun debugger to ${host}:${port}:`, error);
        vscode.window.showErrorMessage(`Error attaching Bun debugger: ${error}`);
    }
}

async function checkPort(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        
        const timeout = setTimeout(() => {
            socket.destroy();
            resolve(false);
        }, 1000);

        socket.connect(port, host, () => {
            clearTimeout(timeout);
            socket.destroy();
            resolve(true);
        });

        socket.on('error', () => {
            clearTimeout(timeout);
            resolve(false);
        });
    });
}