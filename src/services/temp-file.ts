import { AbstractTempFileManger } from 'civkit/temp';
import { unlink } from 'fs/promises';
import { singleton } from 'tsyringe';

@singleton()
export class TempFileManager extends AbstractTempFileManger {

    rootDir = '';

    override async init() {
        await this.dependencyReady();
        await super.init();
        this.emit('ready');
    }

    override async standDown() {
        await super.standDown();

        await unlink(this.rootDir);

    }
}
