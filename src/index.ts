/**
 * @class WebpackShellPluginNext
 * @extends Object
 * Run shell commands before and after webpack builds
 */

import { spawn, exec, spawnSync, execSync, ChildProcess } from 'child_process';
import  { Options, Script, Tasks, Task } from './types';
import * as os from 'os';
import * as webpack from 'webpack';
import { Readable } from 'stream';

const defaultTask: Tasks = {
    scripts: [],
    blocking: false,
    parallel: false
};

export default class WebpackShellPlugin {
    private onBeforeBuild: Tasks;
    private onBuildStart: Tasks;
    private onBuildEnd: Tasks;
    private onBuildExit: Tasks;
    private onBuildError: Tasks;
    private env: any = {};
    private dev: boolean = true;
    private safe: boolean = false;
    private logging: boolean = true;
    private swallowError: boolean = false;

    private validateEvent(tasks: Tasks|string|Function|undefined|null): Tasks {
        if (!tasks) {
            return  JSON.parse(JSON.stringify(defaultTask));
        }
        if (typeof tasks === 'string') {
            return { scripts: tasks.split('&&'), blocking: false, parallel: false };
        } else if (typeof tasks === 'function') {
            return { scripts: [tasks], blocking: false, parallel: false };
        }

        return tasks;
    }

    constructor(options: Options) {
        if (options.verbose) {
            this.warn(`WebpackShellPlugin [${new Date()}]: Verbose is being deprecated, please remove.`);
        }

        this.onBeforeBuild = this.validateEvent(options.onBeforeBuild);
        this.onBuildStart = this.validateEvent(options.onBuildStart);
        this.onBuildEnd = this.validateEvent(options.onBuildEnd);
        this.onBuildExit = this.validateEvent(options.onBuildExit);
        this.onBuildError = this.validateEvent(options.onBuildError);

        if (options.hasOwnProperty('env')) {
            this.env = options.env;
        }
        if (options.dev !== undefined) {
            this.dev = options.dev;
        }
        if (options.safe !== undefined) {
            this.safe = options.safe;
        }
        if (options.logging !== undefined) {
            this.logging = options.logging;
        }
        if (options.swallowError !== undefined) {
            this.swallowError = options.swallowError;
        }

        this.onCompilation = this.onCompilation.bind(this);
        this.onAfterEmit = this.onAfterEmit.bind(this);
        this.onDone = this.onDone.bind(this);
        this.onInvalid = this.onInvalid.bind(this);
        this.putsAsync = this.putsAsync.bind(this);
        this.puts = this.puts.bind(this);
    }

    private putsAsync(resolve: () => void) {
        return (error: Error, stdout: Readable, stderr: Readable) => {
            if (error && !this.swallowError) {
                throw error;
            }
            resolve();
        };
    }

    private puts(error: Error, stdout: Readable, stderr: Readable) {
        if (error && !this.swallowError) {
            throw error;
        }
    }

    private spreadStdoutAndStdErr(proc: ChildProcess) {
        if (!proc.stdout || !proc.stderr) return;
        proc.stdout.pipe(process.stdout);
        proc.stderr.pipe(process.stdout);
    }

    private serializeScript(script: string|Script): Script {
        if (typeof script === 'string') {
            const [command, ...args] = script.split(' ');
            return { command, args };
        }
        const { command, args } = script;
        return { command, args };
    }

    private handleScript(script: string) {
        if (os.platform() === 'win32' || this.safe) {
            execSync(script, { maxBuffer: Number.MAX_SAFE_INTEGER, stdio: this.logging ? [0, 1, 2] : undefined });
        } else {
            const { command, args } = this.serializeScript(script);
            let env = Object.create(global.process.env);
            env = Object.assign(env, this.env);
            spawnSync(command, args, { stdio: this.logging ? 'inherit' : undefined, env });
        }
    }

    private handleScriptAsync(script: string) {
        if (os.platform() === 'win32' || this.safe) {
            return new Promise((resolve) => {
                // @ts-ignore
                this.spreadStdoutAndStdErr(exec(script, this.putsAsync(resolve)));
            });
        }

        const { command, args } = this.serializeScript(script);
        const proc = spawn(command, args, { stdio: 'inherit' });
        return new Promise((resolve) => proc.on('close', this.putsAsync(resolve)));
    }

    private async executeScripts(scripts: Task[], parallel: boolean = false, blocking: boolean = false) {
        if (!scripts || scripts.length <= 0) {
            return;
        }

        if (blocking && parallel) {
            throw new Error(`WebpackShellPlugin [${new Date()}]: Not supported`);
        }

        for (let i = 0; i < scripts.length; i++) {
            const script: Task = scripts[i];
            if (typeof script === 'function') {
                // if(script instanceof Promise)
                if (blocking) await script(); else script();
                continue;
            }
            if (blocking) {
                this.handleScript(script);
            } else if (!blocking) {
                if (parallel) this.handleScriptAsync(script); else await this.handleScriptAsync(script);
            }
        }
    }

    apply(compiler: webpack.Compiler): void {
        if (compiler.hooks) {
            compiler.hooks.invalid.tap('webpack-shell-plugin-next', this.onInvalid);
            compiler.hooks.compilation.tap('webpack-shell-plugin-next', this.onCompilation);
            compiler.hooks.afterEmit.tapAsync('webpack-shell-plugin-next', this.onAfterEmit);
            compiler.hooks.done.tapAsync('webpack-shell-plugin-next', this.onDone);
        } else {
            compiler.plugin('invalid', this.onInvalid);
            compiler.plugin('compilation', this.onCompilation);
            compiler.plugin('after-emit', this.onAfterEmit);
            compiler.plugin('done', this.onDone);
        }
    }

    private readonly onInvalid = async (compilation: string): Promise<void> => {
        const onBeforeBuild = this.onBeforeBuild;
        if (onBeforeBuild.scripts && onBeforeBuild.scripts.length) {
            this.log('Executing before build scripts');
            await this.executeScripts(onBeforeBuild.scripts, onBeforeBuild.parallel, onBeforeBuild.blocking);
            if (this.dev) {
                this.onBeforeBuild = JSON.parse(JSON.stringify(defaultTask));
            }
        }
    };

    private readonly onCompilation = async (compilation: webpack.compilation.Compilation): Promise<void> => {
        const onBuildStartOption = this.onBuildStart;
        if (onBuildStartOption.scripts && onBuildStartOption.scripts.length > 0) {
            this.log('Executing pre-build scripts');
            await this.executeScripts(onBuildStartOption.scripts, onBuildStartOption.parallel, onBuildStartOption.blocking);
            if (this.dev) {
                this.onBuildStart = JSON.parse(JSON.stringify(defaultTask));
            }
        }
    };

    private readonly onAfterEmit = async (compilation: webpack.compilation.Compilation, callback?: Function): Promise<void> => {
        const onBuildEndOption = this.onBuildEnd;
        if (onBuildEndOption.scripts && onBuildEndOption.scripts.length > 0) {
            this.log('Executing post-build scripts');
            await this.executeScripts(onBuildEndOption.scripts, onBuildEndOption.parallel, onBuildEndOption.blocking);
            if (this.dev) {
                this.onBuildEnd = JSON.parse(JSON.stringify(defaultTask));
            }
        }
        if (callback) {
            callback();
        }
    };

    private readonly onDone = async (compilation: webpack.Stats, callback?: Function): Promise<void> => {
        if (compilation.hasErrors()) {
            const onBuildError = this.onBuildError;
            if (onBuildError.scripts && onBuildError.scripts.length > 0) {
                this.warn('Executing error scripts before exit');
                await this.executeScripts(onBuildError.scripts, onBuildError.parallel, onBuildError.blocking);
                if (this.dev) {
                    this.onBuildError = JSON.parse(JSON.stringify(defaultTask));
                }
            }
        }
        const onBuildExit = this.onBuildExit;
        if (onBuildExit.scripts && onBuildExit.scripts.length > 0) {
            this.log('Executing additional scripts before exit');
            await this.executeScripts(onBuildExit.scripts, onBuildExit.parallel, onBuildExit.blocking);
            if (this.dev) {
                this.onBuildExit = JSON.parse(JSON.stringify(defaultTask));
            }
        }
        if (callback) {
            callback();
        }
    };

    private log(text: string) {
        if (this.logging) {
            console.log(text);
        }
    }
    private warn(text: string) {
        if (this.logging) {
            console.warn(text);
        }
    }
}

module.exports = WebpackShellPlugin;
