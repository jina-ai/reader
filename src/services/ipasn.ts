import { container, singleton } from 'tsyringe';
import fsp from 'fs/promises';
import { AsnResponse, Reader } from 'maxmind';
import { AutoCastable, Prop } from 'civkit/civ-rpc';
import { GlobalLogger } from './logger';
import path from 'path';
import { Threaded } from './threaded';
import { AsyncService } from 'civkit/async-service';
import { runOnce } from 'civkit/decorators';


export class ASNInfo extends AutoCastable {
    @Prop()
    asn?: number;

    @Prop()
    org?: string;
}

@singleton()
export class IPASNService extends AsyncService {

    logger = this.globalLogger.child({ service: this.constructor.name });

    mmdbASN!: Reader<AsnResponse>;

    constructor(
        protected globalLogger: GlobalLogger,
    ) {
        super(...arguments);
    }


    override async init() {
        await this.dependencyReady();

        this.emit('ready');
    }

    @runOnce()
    async _lazyload() {
        const mmdpPath = path.resolve(__dirname, '..', '..', 'licensed', 'geolite2-asn.mmdb');

        const dbBuff = await fsp.readFile(mmdpPath, { flag: 'r', encoding: null });

        this.mmdbASN = new Reader<AsnResponse>(dbBuff);

        this.logger.info(`Loaded ASN database, ${dbBuff.byteLength} bytes`);
    }


    @Threaded()
    async lookupASN(ip: string) {
        await this._lazyload();

        const r = this.mmdbASN.get(ip);

        if (!r) {
            return undefined;
        }

        return ASNInfo.from({
            asn: r.autonomous_system_number,
            org: r.autonomous_system_organization,
        });
    }

    @Threaded()
    async lookupASNs(ips: string[]) {
        const r = (await Promise.all(ips.map((ip) => this.lookupASN(ip)))).filter(Boolean) as ASNInfo[];

        return r;
    }

}

const instance = container.resolve(IPASNService);

export default instance;
