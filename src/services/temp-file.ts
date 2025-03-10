import { AbstractTempFileManger } from 'civkit/temp';
import { rm } from 'fs/promises';
import { singleton } from 'tsyringe';
import { Finalizer } from './finalizer';

@singleton()
export class TempFileManager extends AbstractTempFileManger {

    rootDir = '';

    override async init() {
        await this.dependencyReady();
        await super.init();
        this.emit('ready');
    }

    @Finalizer()
    override async standDown() {
        await super.standDown();

        await rm(this.rootDir, { recursive: true, force: true });
    }
}
