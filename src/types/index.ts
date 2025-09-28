export interface DebuggerConfig {
    command: string;
    port: number;
}

export interface CommandParameters {
    script: string;
    args?: string[];
}